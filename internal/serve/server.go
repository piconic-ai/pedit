// Package serve holds a file's Yjs document for a local app: clients on a Unix
// socket speak the y-websocket protocol (sync and awareness, unencrypted),
// and pedit alone writes the file and merges saves made by other editors.
// There is no room and no relay (#372).
package serve

import (
	"context"
	"fmt"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"github.com/coder/websocket"
	"github.com/fsnotify/fsnotify"
	"github.com/piconic-ai/pedit/internal/filewriter"
	"github.com/piconic-ai/pedit/internal/merge"
	"github.com/reearth/ygo/awareness"
	"github.com/reearth/ygo/crdt"
	"github.com/reearth/ygo/encoding"
	ysync "github.com/reearth/ygo/sync"
)

// y-websocket's message types, the first varuint of each frame.
const (
	msgSync      = 0
	msgAwareness = 1
)

// maxFrame bounds a frame from a client; the file's whole text can be one.
const maxFrame = 64 << 20

// fileOrigin marks changes that came from the file, not from a client.
type fileOrigin struct{ _ byte }

type Options struct {
	// App names the app that serves the file, for the lock's message.
	App string
	// WriteDelay is how long the file waits for more edits before it is
	// written; 250ms by default.
	WriteDelay time.Duration
	// SocketBase is where the private socket directory is made; pedit's
	// config directory by default.
	SocketBase string
	// OnError receives problems that do not stop serving.
	OnError func(error)
	// OnWritten is called after each write of the file, with its size in bytes.
	OnWritten func(bytes int)
	// OnExternalSave is called when a save made by another editor was taken in.
	OnExternalSave func()
	// Root, when set, holds the file: Open's file is then a path relative to
	// it, and a path that leaves it (an absolute one, "..", or a link in a
	// directory component) is refused.
	Root *os.Root
}

type Server struct {
	file    string
	opts    Options
	release func()
	bound   *filewriter.BoundFile
	writer  *filewriter.Writer

	dir string
	ln  net.Listener
	srv *http.Server
	// ctx ends when the server closes.
	ctx    context.Context
	cancel context.CancelFunc
	wg     sync.WaitGroup

	// crlf: the file ends its lines with CRLF throughout, which the doc holds
	// as LF. Guarded by mu.
	crlf bool
	// mu guards the doc, the awareness and the clients: a client's frames
	// are applied one at a time, and an update reaches the others in order.
	mu      sync.Mutex
	doc     *crdt.Doc
	text    *crdt.YText
	aw      *awareness.Awareness
	clients map[*client]struct{}

	watcher *fsnotify.Watcher
	// syncing serializes reads of the file; timer debounces them.
	syncing sync.Mutex
	tmu     sync.Mutex
	timer   *time.Timer
	stopped bool
	invalid string
}

// Open locks and reads file, and listens on a Unix socket of its own. It
// returns a *HeldError when another process serves the file.
func Open(file string, opts Options) (*Server, error) {
	var bound *filewriter.BoundFile
	var err error
	if opts.Root != nil {
		if filepath.IsAbs(file) {
			return nil, fmt.Errorf("%s is outside %s: with a root, the file must be a relative path", file, opts.Root.Name())
		}
		bound, err = filewriter.OpenBoundIn(opts.Root, file)
		if err != nil && strings.Contains(err.Error(), "escapes from parent") {
			err = fmt.Errorf("%s is outside %s", file, opts.Root.Name())
		}
		file = filepath.Join(opts.Root.Name(), file)
	} else {
		if file, err = filepath.Abs(file); err != nil {
			return nil, err
		}
		bound, err = filewriter.OpenBound(file)
	}
	if err != nil {
		return nil, err
	}
	if opts.WriteDelay == 0 {
		opts.WriteDelay = 250 * time.Millisecond
	}
	if opts.OnError == nil {
		opts.OnError = func(error) {}
	}
	// One lock per file however it is reached: resolve the directory's links
	// after OpenBound has refused a file that is itself a link.
	dir, err := filepath.EvalSymlinks(bound.Dir().Name())
	if err != nil {
		_ = bound.Close()
		return nil, err
	}
	file = filepath.Join(dir, filepath.Base(file))
	initial, ok := bound.Read()
	if !ok {
		_ = bound.Close()
		return nil, fmt.Errorf("cannot read %s: it must be an existing text file", file)
	}
	if !utf8.ValidString(initial) {
		_ = bound.Close()
		return nil, fmt.Errorf("%s is not UTF-8 text", file)
	}
	release, err := acquire(file, opts.App)
	if err != nil {
		_ = bound.Close()
		return nil, err
	}
	s := &Server{file: file, opts: opts, release: release, bound: bound, clients: map[*client]struct{}{}}
	s.ctx, s.cancel = context.WithCancel(context.Background())
	s.crlf = isCRLF(initial)
	s.doc = crdt.New()
	s.text = s.doc.GetText("content")
	s.doc.Transact(func(txn *crdt.Transaction) { s.text.Insert(txn, 0, s.normalize(initial), nil) })
	s.aw = awareness.New(uint64(s.doc.ClientID()))
	s.writer = filewriter.New(file, initial, filewriter.Options{
		Bound:   bound,
		Delay:   opts.WriteDelay,
		OnError: opts.OnError,
		OnWritten: func() {
			if opts.OnWritten == nil {
				return
			}
			n := 0
			if info, err := bound.Dir().Stat(filepath.Base(file)); err == nil {
				n = int(info.Size())
			}
			opts.OnWritten(n)
		},
		OnExternalChange: s.scheduleRead,
	})
	s.doc.OnUpdate(s.onUpdate)
	if err := s.listen(); err != nil {
		s.cleanup()
		return nil, err
	}
	if err := s.watch(); err != nil {
		s.cleanup()
		return nil, err
	}
	return s, nil
}

// SocketPath is where clients connect.
func (s *Server) SocketPath() string { return filepath.Join(s.dir, "s") }

// listen makes the socket's directory (0700, so only this user reaches it)
// and serves WebSocket upgrades on it. A Unix socket path is limited to about
// 100 bytes, so a long config path falls back to the temp directory.
func (s *Server) listen() error {
	base := s.opts.SocketBase
	if base == "" {
		cfg, err := os.UserConfigDir()
		if err != nil || len(cfg) > 60 {
			cfg = os.TempDir()
		} else {
			cfg = filepath.Join(cfg, "pedit", "serve")
		}
		base = cfg
	}
	if err := os.MkdirAll(base, 0o700); err != nil {
		return err
	}
	dir, err := os.MkdirTemp(base, "p")
	if err != nil {
		return err
	}
	s.dir = dir
	if err := os.Chmod(dir, 0o700); err != nil {
		return err
	}
	ln, err := net.Listen("unix", s.SocketPath())
	if err != nil {
		return err
	}
	s.ln = ln
	s.srv = &http.Server{Handler: http.HandlerFunc(s.accept)}
	s.wg.Add(1)
	go func() {
		defer s.wg.Done()
		_ = s.srv.Serve(ln)
	}()
	return nil
}

// Close writes the file one last time, then removes the socket and the lock.
func (s *Server) Close() error {
	s.tmu.Lock()
	s.stopped = true
	if s.timer != nil {
		s.timer.Stop()
	}
	s.tmu.Unlock()
	s.cancel()
	_ = s.srv.Close()
	s.wg.Wait()
	// A save by another editor in the last moments is taken in first.
	s.syncing.Lock()
	s.syncFromDisk()
	s.syncing.Unlock()
	err := s.writer.Flush()
	s.cleanup()
	return err
}

func (s *Server) cleanup() {
	if s.watcher != nil {
		_ = s.watcher.Close()
	}
	if s.ln != nil {
		_ = s.ln.Close()
	}
	if s.dir != "" {
		_ = os.RemoveAll(s.dir)
	}
	_ = s.bound.Close()
	s.release()
}

// text as the doc has it now.
func (s *Server) render() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.fileText()
}

// onUpdate runs inside every transaction on the doc, with s.mu held.
func (s *Server) onUpdate(update []byte, origin any) {
	s.broadcast(frame(msgSync, ysync.EncodeUpdate(update)), origin)
	s.writer.Schedule(s.fileText())
}

func frame(kind uint64, payload []byte) []byte {
	enc := encoding.NewEncoder()
	enc.WriteVarUint(kind)
	return append(enc.Bytes(), payload...)
}

// scheduleRead reads the file soon, once, after a burst of events.
func (s *Server) scheduleRead() {
	s.tmu.Lock()
	defer s.tmu.Unlock()
	if s.stopped {
		return
	}
	if s.timer != nil {
		s.timer.Stop()
	}
	s.timer = time.AfterFunc(50*time.Millisecond, func() {
		s.syncing.Lock()
		defer s.syncing.Unlock()
		s.syncFromDisk()
	})
}

// syncFromDisk takes in a save made outside pedit as the diff from what pedit
// last wrote, as the live room does. The caller holds s.syncing.
func (s *Server) syncFromDisk() {
	changed, external := false, false
	s.writer.Rebase(func(last string) string {
		onDisk, ok := s.bound.Read()
		if !ok || onDisk == last {
			changed = ok
			return last
		}
		if !utf8.ValidString(onDisk) {
			// Wait for it to be fixed rather than clobber what is being written.
			if onDisk != s.invalid {
				s.invalid = onDisk
				s.opts.OnError(fmt.Errorf("%s is not UTF-8 text: waiting for a valid save", s.file))
			}
			return last
		}
		s.invalid = ""
		changed, external = true, true
		s.mu.Lock()
		base := toDoc(last, isCRLF(last))
		s.crlf = isCRLF(onDisk)
		merge.ExternalEdit(s.doc, s.text, base, s.normalize(onDisk), &fileOrigin{})
		s.mu.Unlock()
		return onDisk
	})
	if external && s.opts.OnExternalSave != nil {
		s.opts.OnExternalSave()
	}
	if changed {
		// Edits made meanwhile are not on disk yet; Rebase dropped them.
		s.writer.Schedule(s.render())
	}
}

// watch watches the file's directory, not the file: editors often save by
// renaming a new file over the old one.
func (s *Server) watch() error {
	w, err := fsnotify.NewWatcher()
	if err != nil {
		return err
	}
	if err := w.Add(filepath.Dir(s.file)); err != nil {
		_ = w.Close()
		return err
	}
	s.watcher = w
	go func() {
		for {
			select {
			case ev, ok := <-w.Events:
				if !ok {
					return
				}
				if filepath.Clean(ev.Name) == s.file {
					s.scheduleRead()
				}
			case err, ok := <-w.Errors:
				if !ok {
					return
				}
				s.opts.OnError(err)
			}
		}
	}()
	return nil
}

// A client is one connection. Everything sent to it goes through out, so a
// slow client never holds up the others.
type client struct {
	conn   *websocket.Conn
	out    chan []byte
	ids    map[uint64]bool // awareness client IDs it announced
	closed bool            // out is closed; guarded by Server.mu
}

// send queues msg for c; the caller holds s.mu. A client that falls far
// behind is dropped, and catches up when it reconnects.
func (s *Server) send(c *client, msg []byte) {
	if c.closed {
		return
	}
	select {
	case c.out <- msg:
	default:
		_ = c.conn.CloseNow()
	}
}

// broadcast sends msg to every client but origin. The caller holds s.mu.
func (s *Server) broadcast(msg []byte, origin any) {
	for c := range s.clients {
		if origin != c {
			s.send(c, msg)
		}
	}
}

func (s *Server) accept(w http.ResponseWriter, r *http.Request) {
	// The socket is reachable only by this user, and a browser never
	// connects to it directly: the Origin check does not apply.
	conn, err := websocket.Accept(w, r, &websocket.AcceptOptions{InsecureSkipVerify: true})
	if err != nil {
		return
	}
	conn.SetReadLimit(maxFrame)
	c := &client{conn: conn, out: make(chan []byte, 1024), ids: map[uint64]bool{}}
	s.wg.Add(1)
	defer s.wg.Done()

	s.mu.Lock()
	s.clients[c] = struct{}{}
	off := s.aw.OnUpdate(func(ev awareness.UpdateEvent) {
		if ev.Origin == c {
			for _, id := range append(ev.Added, ev.Updated...) {
				c.ids[id] = true
			}
		}
	})
	s.send(c, frame(msgSync, ysync.EncodeSyncStep1(s.doc)))
	if len(s.aw.GetStates()) > 0 {
		s.send(c, awarenessFrame(s.aw.EncodeUpdate(nil)))
	}
	s.mu.Unlock()

	done := make(chan struct{})
	go func() {
		defer close(done)
		for msg := range c.out {
			if err := conn.Write(s.ctx, websocket.MessageBinary, msg); err != nil {
				_ = conn.CloseNow()
				return
			}
		}
	}()
	for {
		typ, data, err := conn.Read(s.ctx)
		if err != nil {
			break
		}
		if typ != websocket.MessageBinary {
			continue
		}
		if err := s.handle(c, data); err != nil {
			s.opts.OnError(err)
			break
		}
	}
	off()
	s.mu.Lock()
	delete(s.clients, c)
	s.leave(c)
	c.closed = true
	close(c.out)
	s.mu.Unlock()
	<-done
	_ = conn.CloseNow()
}

func awarenessFrame(update []byte) []byte {
	enc := encoding.NewEncoder()
	enc.WriteVarBytes(update)
	return frame(msgAwareness, enc.Bytes())
}

// leave tells the others that c's awareness clients are gone, as
// y-websocket's server does; the caller holds s.mu.
func (s *Server) leave(c *client) {
	var gone []uint64
	states := s.aw.GetStates()
	for id := range c.ids {
		if _, ok := states[id]; ok {
			gone = append(gone, id)
		}
	}
	if len(gone) == 0 {
		return
	}
	enc := encoding.NewEncoder()
	enc.WriteVarUint(uint64(len(gone)))
	for _, id := range gone {
		meta, _ := s.aw.Meta(id)
		enc.WriteVarUint(id)
		enc.WriteVarUint(meta.Clock + 1)
		enc.WriteVarString("null")
	}
	if err := s.aw.ApplyUpdate(enc.Bytes(), nil); err == nil {
		s.broadcast(awarenessFrame(enc.Bytes()), c)
	}
}

// handle applies one frame from c. An error closes the connection.
func (s *Server) handle(c *client, data []byte) (err error) {
	defer func() {
		// ygo can panic on a malformed update; a client must not end the process.
		if r := recover(); r != nil {
			err = fmt.Errorf("malformed frame: %v", r)
		}
	}()
	if len(data) == 0 {
		return nil
	}
	kind, payload := data[0], data[1:]
	s.mu.Lock()
	defer s.mu.Unlock()
	switch kind {
	case msgSync:
		reply, err := ysync.ApplySyncMessage(s.doc, payload, c)
		if err != nil {
			return err
		}
		if len(reply) > 0 {
			s.send(c, frame(msgSync, reply))
		}
	case msgAwareness:
		update, err := encoding.NewDecoder(payload).ReadVarBytes()
		if err != nil {
			return err
		}
		if err := s.aw.ApplyUpdate(update, c); err != nil {
			return err
		}
		s.broadcast(data, c)
	}
	// Other types (query awareness, auth) are not used by pedit.
	return nil
}

// The doc holds a file whose lines all end in CRLF with LF endings, and the
// file is written back with CRLF: a CodeMirror client counts "\r\n" as one
// character, so with CRs in the text its edits would land off by one per line
// (#372). A file with mixed endings is held as it is.
func isCRLF(s string) bool {
	crlf := strings.Count(s, "\r\n")
	return crlf > 0 && crlf == strings.Count(s, "\n") && crlf == strings.Count(s, "\r")
}

func toDoc(s string, crlf bool) string {
	if crlf {
		return strings.ReplaceAll(s, "\r\n", "\n")
	}
	return s
}

// normalize is the doc's form of file content that ends its lines as s does.
func (s *Server) normalize(content string) string { return toDoc(content, isCRLF(content)) }

// fileText is the doc as the file holds it. The caller holds s.mu, or runs
// before the server does.
func (s *Server) fileText() string {
	text := s.text.ToString()
	if s.crlf {
		return strings.ReplaceAll(text, "\n", "\r\n")
	}
	return text
}
