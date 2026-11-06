// Package serve holds a file's Yjs document for a local app: clients, one per
// stream on pedit's standard streams (stdio.go), speak the y-websocket
// protocol (sync and awareness, unencrypted), and pedit alone writes the file and merges saves made by other editors.
// There is no room and no relay (#372).
package serve

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"github.com/fsnotify/fsnotify"
	"github.com/piconic-ai/pedit/internal/filewriter"
	"github.com/piconic-ai/pedit/internal/lineend"
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
	// StateDir is where recovery states are kept (in its "state" directory);
	// pedit's config directory by default.
	StateDir string
	// OnError receives problems that do not stop serving.
	OnError func(error)
	// OnWritten is called after each write of the file, with its size in bytes.
	// The file writer's lock is held: it must not block for long.
	OnWritten func(bytes int)
	// OnExternalSave is called when a save made by another editor was taken in.
	OnExternalSave func()
	// Root, when set, holds the file: Open's file is then a path relative to
	// it, and a path that leaves it (an absolute one, "..", or a link in a
	// directory component) is refused.
	Root *os.Root
	// FrameRate and Step1Rate are the most frames, and the most sync step 1
	// messages, per second one connection may send: 1000 and 10 by default.
	FrameRate, Step1Rate int
}

type Server struct {
	file    string
	opts    Options
	release func()
	bound   *filewriter.BoundFile
	writer  *filewriter.Writer

	// crlf: the file ends its lines with CRLF throughout, which the doc holds
	// as LF. Guarded by mu.
	crlf bool
	// generation names the document; statePath is where its recovery state is
	// kept ("" for nowhere).
	generation string
	statePath  string
	// mu guards the doc, the awareness and the clients: a client's frames
	// are applied one at a time, and an update reaches the others in order.
	mu      sync.Mutex
	doc     *crdt.Doc
	text    *crdt.YText
	aw      *awareness.Awareness
	clients map[*client]struct{}
	// peer is the in-process client, if any (peer.go).
	peer *Peer
	// closing: Close has begun, and no client is taken in.
	closing bool

	watcher *fsnotify.Watcher
	// syncing serializes reads of the file; timer debounces them.
	syncing sync.Mutex
	tmu     sync.Mutex
	timer   *time.Timer
	stopped bool
	invalid string
}

// openFile binds file, a path relative to root if there is one. It returns the
// path that names the file.
func openFile(file string, root *os.Root) (*filewriter.BoundFile, string, error) {
	if root == nil {
		file, err := filepath.Abs(file)
		if err != nil {
			return nil, "", err
		}
		bound, err := filewriter.OpenBound(file)
		return bound, file, err
	}
	if filepath.IsAbs(file) {
		return nil, "", fmt.Errorf("%s is outside %s: with a root, the file must be a relative path", file, root.Name())
	}
	bound, err := filewriter.OpenBoundIn(root, file)
	if err != nil && strings.Contains(err.Error(), "escapes from parent") {
		err = fmt.Errorf("%s is outside %s", file, root.Name())
	}
	return bound, filepath.Join(root.Name(), file), err
}

// Open locks and reads file. Clients are attached to it with Stdio.Serve. It
// returns a *HeldError when another process serves the file.
func Open(file string, opts Options) (*Server, error) {
	bound, file, err := openFile(file, opts.Root)
	if err != nil {
		return nil, err
	}
	if opts.WriteDelay == 0 {
		opts.WriteDelay = 250 * time.Millisecond
	}
	if opts.FrameRate == 0 {
		opts.FrameRate = defaultFrameRate
	}
	if opts.Step1Rate == 0 {
		opts.Step1Rate = defaultStep1Rate
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
		if _, gone := bound.Dir().Stat(filepath.Base(file)); os.IsNotExist(gone) {
			forgetState(opts, file)
		}
		_ = bound.Close()
		return nil, fmt.Errorf("cannot read %s: it must be an existing text file", file)
	}
	if !utf8.ValidString(initial) {
		_ = bound.Close()
		return nil, fmt.Errorf("%s is not UTF-8 text", file)
	}
	// The lock is taken through the handle on the directory; only the watch
	// below needs its path.
	release, err := acquire(bound.Dir(), file, opts.App)
	if err != nil {
		_ = bound.Close()
		return nil, err
	}
	s := &Server{file: file, opts: opts, release: release, bound: bound, clients: map[*client]struct{}{}}
	s.crlf = lineend.IsCRLF(initial)
	s.statePath = opts.statePath(file)
	s.seed(initial)
	s.aw = awareness.New(uint64(s.doc.ClientID()))
	s.writer = filewriter.New(file, initial, filewriter.Options{
		Bound:   bound,
		Delay:   opts.WriteDelay,
		OnError: opts.OnError,
		OnWritten: func() {
			if written, ok := bound.Read(); ok {
				s.saveState(written, nil)
			}
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
		// The doc is saved before the file it is about to be written to, so a
		// crash between the two leaves a state that knows both texts.
		BeforeWrite: func(last, content string) { s.saveState(last, &content) },
	})
	if s.fileText() != initial {
		s.writer.Schedule(s.fileText())
	}
	s.doc.OnUpdate(s.onUpdate)
	s.saveState(s.writer.LastWritten(), nil)
	// fsnotify watches a path, not a handle: refuse if the path does not lead
	// to the directory the file was opened in, checked after the watch is set
	// so that a swap before it cannot go unseen.
	if err := s.watch(); err != nil {
		s.cleanup()
		return nil, err
	}
	if err := sameDir(bound, dir); err != nil {
		s.cleanup()
		return nil, err
	}
	return s, nil
}

// sameDir checks that dir is the directory bound holds open.
func sameDir(bound *filewriter.BoundFile, dir string) error {
	held, err := bound.Dir().Stat(".")
	if err != nil {
		return err
	}
	now, err := os.Stat(dir)
	if err != nil || !os.SameFile(held, now) {
		return fmt.Errorf("%s was replaced while pedit opened the file", dir)
	}
	return nil
}

// Path is the resolved path of the file Open bound.
func (s *Server) Path() string { return s.file }

// Close writes the file one last time, then removes the lock.
func (s *Server) Close() error {
	// The peer goes first, so that no handler call runs after Close returns.
	s.mu.Lock()
	s.closing = true
	peer := s.peer
	s.mu.Unlock()
	if peer != nil {
		peer.Close()
	}
	s.tmu.Lock()
	s.stopped = true
	if s.timer != nil {
		s.timer.Stop()
	}
	s.tmu.Unlock()
	s.mu.Lock()
	s.closing = true
	open := make([]*client, 0, len(s.clients))
	for c := range s.clients {
		open = append(open, c)
	}
	s.mu.Unlock()
	for _, c := range open {
		c.finish(s, nil, false)
	}
	// A save by another editor in the last moments is taken in first.
	s.syncing.Lock()
	s.syncFromDisk()
	s.syncing.Unlock()
	err := s.writer.Flush()
	if _, gone := s.bound.Dir().Stat(filepath.Base(s.file)); os.IsNotExist(gone) {
		_ = os.Remove(s.statePath)
	} else {
		s.saveState(s.writer.LastWritten(), nil)
	}
	s.cleanup()
	return err
}

func (s *Server) cleanup() {
	if s.watcher != nil {
		_ = s.watcher.Close()
	}
	// The lock is released through the directory handle: close that last.
	s.release()
	_ = s.bound.Close()
}

// text as the doc has it now.
func (s *Server) render() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.fileText()
}

// onUpdate runs inside every transaction on the doc, with s.mu held.
func (s *Server) onUpdate(update []byte, origin any) {
	if s.peer != nil && origin != s.peer {
		s.peer.push(peerMsg{update: update})
	}
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
		base := lineend.Doc(last)
		s.crlf = lineend.IsCRLF(onDisk)
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

// conn is one client's end of a stream: the messages pedit sends it, and how a
// stream is ended. A close of nil ends it without a word. A write gives up
// when quit closes, and reports false for a message that cannot be sent.
type conn interface {
	write(msg []byte, quit <-chan struct{}) bool
	close(ce *closeError, quit <-chan struct{})
}

// A client is one stream's end. Everything sent to it goes through out, so a
// slow client never holds up the others.
type client struct {
	conn   conn
	out    chan []byte
	quit   chan struct{} // closes to drop what out still holds
	pumped chan struct{} // closes when the writer of out has returned
	off    func()
	once   sync.Once
	dropIt sync.Once
	ids    map[uint64]bool // awareness client IDs it announced
	seen   map[uint64]bool // every ID it introduced to the room, removed ones too
	closed bool            // out is closed; guarded by Server.mu
	reader bool            // may send sync step 1 and awareness only
	// frames and step1 limit what it sends; its receiver alone uses them.
	frames, step1 *bucket
}

// send queues msg for c; the caller holds s.mu. A client that falls far
// behind is closed with 1013, and catches up when it reconnects.
func (s *Server) send(c *client, msg []byte) {
	if c.closed {
		return
	}
	select {
	case c.out <- msg:
	default:
		s.retire(c, errTooSlow)
	}
}

// retire stops c taking part now (it is sent nothing and its messages are
// ignored) and ends it in the background, so that a queue to drain never holds
// up the caller. The caller holds s.mu.
func (s *Server) retire(c *client, ending error) {
	if c.closed {
		return
	}
	c.closed = true
	close(c.out)
	go c.finish(s, ending, true)
}

// broadcast sends msg to every client but origin. The caller holds s.mu.
func (s *Server) broadcast(msg []byte, origin any) {
	for c := range s.clients {
		if origin != c {
			s.send(c, msg)
		}
	}
}

// attach takes cn in as a client, a reader if reader is set. It returns nil
// when the server is closing.
func (s *Server) attach(cn conn, reader bool) *client {
	c := &client{
		conn: cn, out: make(chan []byte, 1024), quit: make(chan struct{}), pumped: make(chan struct{}), ids: map[uint64]bool{}, seen: map[uint64]bool{},
		reader: reader,
		frames: newBucket(s.opts.FrameRate), step1: newBucket(s.opts.Step1Rate),
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closing {
		return nil
	}
	s.clients[c] = struct{}{}
	// c owns the awareness IDs ygo accepted from it, not the ones it echoed.
	c.off = s.aw.OnUpdate(func(ev awareness.UpdateEvent) {
		if ev.Origin == c {
			for _, id := range append(ev.Added, ev.Updated...) {
				c.ids[id] = true
			}
		}
	})
	if !c.reader { // a reader has nothing to send back
		s.send(c, frame(msgSync, ysync.EncodeSyncStep1(s.doc)))
	}
	if len(s.aw.GetStates()) > 0 {
		s.send(c, awarenessFrame(s.aw.EncodeUpdate(nil)))
	}
	go func() {
		defer close(c.pumped)
		for {
			select {
			case msg, ok := <-c.out:
				if !ok {
					return
				}
				if !cn.write(msg, c.quit) {
					s.mu.Lock()
					s.retire(c, errTooLarge)
					s.mu.Unlock()
				}
			case <-c.quit:
				return
			}
		}
	}()
	return c
}

// receive applies one message from c; an error ends the client, with the code
// of a *closeError if it is one.
func (s *Server) receive(c *client, data []byte) {
	if !c.frames.allow() {
		s.mu.Lock()
		s.retire(c, errTooManyFrames)
		s.mu.Unlock()
		return
	}
	if err := s.handle(c, data); err != nil {
		s.opts.OnError(err)
		s.mu.Lock()
		s.retire(c, err)
		s.mu.Unlock()
	}
}

// drop makes c's writes give up and its queue be dropped.
func (c *client) drop() { c.dropIt.Do(func() { close(c.quit) }) }

// finish ends c once: it leaves the room and the stream is closed with the
// code of ending, if it is a *closeError. With drain, what was queued is sent
// first; without, it is dropped.
func (c *client) finish(s *Server, ending error, drain bool) {
	if !drain {
		c.drop() // even if another finish is already draining
	}
	c.once.Do(func() {
		c.off()
		s.mu.Lock()
		delete(s.clients, c)
		s.leave(c)
		if !c.closed {
			c.closed = true
			close(c.out)
		}
		s.mu.Unlock()
		<-c.pumped
		var ce *closeError
		errors.As(ending, &ce)
		c.conn.close(ce, c.quit)
	})
}

func awarenessFrame(update []byte) []byte {
	enc := encoding.NewEncoder()
	enc.WriteVarBytes(update)
	return frame(msgAwareness, enc.Bytes())
}

// leave tells the others that c's awareness clients are gone, as
// y-websocket's server does; the caller holds s.mu.
func (s *Server) leave(c *client) {
	// Forget old tombstones so that churn does not grow the awareness.
	defer s.aw.PurgeTombstones(time.Minute)
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
	// c is the origin, so that the peer can tell the role of what left.
	if err := s.aw.ApplyUpdate(enc.Bytes(), c); err == nil {
		s.broadcast(awarenessFrame(enc.Bytes()), c)
	}
}

// handle applies one frame from c. An error closes the connection, with the
// code of a *closeError if it is one.
func (s *Server) handle(c *client, data []byte) (err error) {
	defer func() {
		// ygo can panic on a malformed update; a client must not end the process.
		if r := recover(); r != nil {
			err = malformed(fmt.Errorf("%v", r))
		}
	}()
	kind, sub, rest, err := parseFrame(data)
	if err != nil {
		return malformed(err)
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if c.closed {
		return nil
	}
	switch kind {
	case msgSync:
		return s.handleSync(c, sub, rest)
	case msgAwareness:
		return s.handleAwareness(c, rest)
	}
	// Other types (query awareness, auth) are not used by pedit.
	return nil
}

// handleSync applies a sync message; sub is its sub-type as parseFrame read it,
// the same way ApplySyncMessage will. The caller holds s.mu.
func (s *Server) handleSync(c *client, sub uint64, msg []byte) error {
	if c.reader && sub != ysync.MsgSyncStep1 {
		return errReadOnly
	}
	if sub == ysync.MsgSyncStep1 && !c.step1.allow() {
		return errTooManyStep1
	}
	reply, err := ysync.ApplySyncMessage(s.doc, msg, c)
	if err != nil {
		return malformed(err)
	}
	if len(reply) > 0 {
		s.send(c, frame(msgSync, reply))
	}
	return nil
}

// handleAwareness applies an awareness update, within the caps on how many
// client IDs a connection and the room may announce. The caller holds s.mu.
func (s *Server) handleAwareness(c *client, payload []byte) error {
	update, err := encoding.NewDecoder(payload).ReadVarBytes()
	if err == nil {
		var entries []awEntry
		if entries, err = awarenessEntries(update); err == nil {
			err = s.checkAwareness(c, entries)
		}
	}
	var ce *closeError
	switch {
	case errors.As(err, &ce):
		return ce
	case err != nil:
		return malformed(err)
	}
	if err := s.aw.ApplyUpdate(update, c); err != nil {
		return malformed(err)
	}
	s.broadcast(frame(msgAwareness, payload), c)
	return nil
}

// normalize is the doc's form of file content that ends its lines as s does.
func (s *Server) normalize(content string) string { return lineend.Doc(content) }

// fileText is the doc as the file holds it. The caller holds s.mu, or runs
// before the server does.
func (s *Server) fileText() string {
	text := s.text.ToString()
	if s.crlf {
		return lineend.FromDoc(text, true)
	}
	return text
}
