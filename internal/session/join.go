package session

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync/atomic"
	"time"

	"github.com/piconic-ai/pedit/internal/filewriter"
	"github.com/piconic-ai/pedit/internal/protocol"
	"github.com/reearth/ygo/awareness"
	"github.com/reearth/ygo/crdt"
)

// JoinOptions joins a room someone else hosts, as a browser would, and keeps a
// local copy of each text file it shares so any editor can work on it. The
// copies go in a new temporary directory, removed when the session stops,
// leaving nothing behind, like a browser tab. They are named by the guest
// (copyName), never as the host names them.
type JoinOptions struct {
	// URL is the share link, with the key in its fragment.
	URL        string
	Name       string
	WriteDelay time.Duration
	// Watch streams edits made to the copy outside pedit into the room. A
	// comment link edits nothing, so its copies are not watched.
	Watch bool
	// OnComments is as in Options.
	OnComments func(CommentChange)
	// Timeout bounds how long Join waits for the room's state; 15s by default.
	Timeout  time.Duration
	Header   http.Header
	Dial     protocol.Dialer
	OnStatus func(protocol.Status)
	// OnKept is called with the time a kept room stays open until, before
	// OnStatus reports it kept.
	OnKept   func(time.Time)
	OnPeople func([]string)
	// OnNotice and OnError are as in Options.
	OnNotice func(Notice)
	OnError  func(error)
	// OnMirrored is called for each other file the room shares, with the path
	// the host shows it at and the path of its copy beside the first, and why
	// it is not copied when it is not. Called one at a time.
	OnMirrored func(hostPath, path string, err error)

	// dir is a test seam: the copies go there, and stay, instead of in a new
	// temporary directory.
	dir string

	// beforePublishWriter is a test seam; see Session.beforePublishWriter.
	beforePublishWriter func()
	// writeHook is a test seam, set on the copy's BoundFile before its first
	// write; see filewriter.BoundFile.SetTestHook.
	writeHook func(filewriter.Step)
}

// ErrRoomClosed means the room could not be joined because nobody hosts it:
// the host left, or the link is wrong.
var ErrRoomClosed = errors.New("the room is closed: the host left, or the link is wrong")

// ErrRoomFull means the room already has as many guests as its relay allows.
var ErrRoomFull = errors.New("the room is full: its relay takes only so many people at once; try again when someone leaves")

// ErrRelayMaintenance means the relay is closed for maintenance.
var ErrRelayMaintenance = errors.New("the relay is closed for maintenance; try again later")

// ErrClientOutdated means the server speaks a newer protocol version than this
// pedit, which has to be updated.
var ErrClientOutdated = errors.New("this pedit is too old for the server; update it")

// ErrServerOutdated means the server speaks an older protocol version than
// this pedit; whoever runs it has to update it.
var ErrServerOutdated = errors.New("the server is older than this pedit; ask whoever runs it to update it")

// ErrTooLarge means the room's file grew too large to share.
var ErrTooLarge = errors.New("the shared file is too large to share; pedit shares files up to " + SizeLimit + " for now")

// ErrRoomExpired means the room reached its relay's time limit and has ended for good.
var ErrRoomExpired = errors.New("the room has ended: it reached its time limit on the relay; ask the host to run pedit again for a new link")

// endedErr says why a Client ended in the final status st.
func endedErr(st protocol.Status) error {
	switch st {
	case protocol.StatusFull:
		return ErrRoomFull
	case protocol.StatusMaintenance:
		return ErrRelayMaintenance
	case protocol.StatusClientOutdated:
		return ErrClientOutdated
	case protocol.StatusServerOutdated:
		return ErrServerOutdated
	case protocol.StatusTooLarge:
		return ErrTooLarge
	case protocol.StatusExpired:
		return ErrRoomExpired
	}
	return ErrRoomClosed
}

// ErrFileExists means the copy was not written because a file of that name
// appeared in its directory, which pedit made empty.
type ErrFileExists struct{ Path string }

func (e *ErrFileExists) Error() string {
	return fmt.Sprintf("%s already exists, and pedit does not write over it", e.Path)
}

// Join enters the room at opts.URL, waits for its content and writes it to a
// copy (copyName). The returned Session mirrors the copy and the room
// both ways until Stop; Session.URL is the link joined.
func Join(ctx context.Context, opts JoinOptions) (*Session, error) {
	onError := opts.OnError
	if onError == nil {
		onError = func(error) {}
	}
	if opts.Timeout == 0 {
		opts.Timeout = 15 * time.Second
	}
	wsURL, roomID, secrets, err := parseShareURL(opts.URL)
	if err != nil {
		return nil, err
	}
	opts.Watch = watchesCopies(opts.Watch, secrets.Access)
	dir, temp, root, err := copyRoot(opts.dir, roomID)
	if err != nil {
		return nil, err
	}

	doc := crdt.New()
	shared := newTextContent(doc, "")
	aw := guestAwareness(doc, opts.Name)

	s := &Session{
		URL:        opts.URL,
		Doc:        doc,
		Text:       shared.text,
		sharedFile: &sharedFile{doc: doc, content: shared, onError: onError},
		awareness:  aw,
		temp:       temp,

		beforePublishWriter: opts.beforePublishWriter,
	}
	s.mirror = &mirror{dir: dir, root: root, opts: opts, done: map[uint64]bool{}, firstList: make(chan struct{})}
	s.guest = newGuestComments(opts.Name, opts.OnComments, &s.commentCalls)
	room := &roomWait{
		synced:   make(chan struct{}),
		closed:   make(chan struct{}),
		hostSeen: make(chan struct{}, 1),
	}
	var waited atomic.Bool // the host was away
	// What the room's people are, and whether the host is among them, follows
	// from their states and the access they speak with.
	peopleChanged := func() {
		if _, ok := hostState(aw, s.Client); ok {
			select {
			case room.hostSeen <- struct{}{}:
			default:
			}
		}
		s.reportPeople(opts.OnPeople)
	}
	var last atomic.Value // the status before
	s.Client, err = protocol.NewClient(protocol.ClientOptions{
		URL:       wsURL,
		RoomID:    roomID,
		Link:      &secrets,
		Doc:       doc,
		Awareness: aw,
		Header:    opts.Header,
		Dial:      opts.Dial,
		OnStatus: func(st protocol.Status) {
			if was, _ := last.Swap(st).(protocol.Status); was == protocol.StatusKept && st == protocol.StatusConnected {
				// The host is back, and takes the state by sync.
				s.kept.settle()
			}
			if st.HostAway() {
				waited.Store(true)
			} else if st == protocol.StatusConnected && waited.Swap(false) {
				s.resumeFromDisk()
			}
			if st.Final() {
				room.end(st)
			}
			if opts.OnStatus != nil {
				opts.OnStatus(st)
			}
		},
		OnKept:   opts.OnKept,
		OnSynced: func() { close(room.synced) },
		OnError:  onError,
		OnManifest: func(files []protocol.FileEntry) {
			s.takeManifest(files)
			s.guest.takeManifest(files)
		},
		OnFileSynced: func(id uint64) { s.guest.synced(id) },
		// A room kept while its host is away (kept_guest.go).
		OnKind:       func(kind byte, payload []byte) { s.kept.onKind(kind, payload) },
		OnKeptUpdate: func(id uint64, update []byte) { s.kept.send(id, update) },
		After:        func() (uint64, bool) { return s.kept.cursor() },
		OnLive:       func() { s.kept.settle() },
		OnFileAnswer: func(id uint64, fromHost bool, update []byte) { s.guest.answered(id, fromHost, update) },
		OnAccess:     func(uint64) { peopleChanged() },
	})
	if err != nil {
		_ = root.Close()
		_ = removeTemp(temp)
		return nil, err
	}
	s.client = s.Client
	s.guest.client = s.Client
	s.kept = newKeptGuest(s, s.Client.Keys())
	s.sendCanvas = s.Client.SendCanvas
	// Until the file is known, remote edits only land in the doc; the first
	// write below carries them all.
	doc.OnUpdate(func(_ []byte, origin any) {
		if origin != s.Client {
			return
		}
		s.mu.Lock()
		w := s.Writer
		s.mu.Unlock()
		if w != nil {
			w.Schedule(s.content.render())
		}
	})
	aw.OnChange(func(awareness.ChangeEvent) { peopleChanged() })
	s.stopAlive = keepAlive(aw)
	s.Client.Connect()

	fail := func(err error) (*Session, error) {
		if s.notices != nil {
			s.notices.stop()
		}
		// A first write that met a change scheduled a sync; none may run now.
		s.mu.Lock()
		s.stopped = true
		if s.readTimer != nil {
			s.readTimer.Stop()
		}
		s.mu.Unlock()
		if s.bound != nil {
			_ = s.bound.Close()
		}
		s.Client.Destroy()
		s.stopAlive()
		aw.Destroy()
		_ = root.Close()
		_ = removeTemp(temp)
		return nil, err
	}
	host, err := room.wait(ctx, aw, s.Client, s.kept.replayed, opts.Timeout)
	if err != nil {
		return fail(err)
	}
	host = s.kept.orFirstFile(host)
	s.takeFormat(host)
	hostName, _ := host["file"].(string)
	if err := s.openCopy(root, dir, hostName, opts, onError); err != nil {
		return fail(err)
	}
	s.awaitFirstList(hostName)

	w := filewriter.New(s.file, "", filewriter.Options{
		Bound:            s.bound,
		Delay:            opts.WriteDelay,
		OnError:          s.notices.saveError,
		OnWritten:        s.notices.written,
		OnExternalChange: s.scheduleSyncFromDisk,
	})
	if err := s.publishWriter(w); err != nil {
		return fail(fmt.Errorf("cannot write %s: %w", s.file, err))
	}
	if err := w.Flush(); err != nil {
		return fail(fmt.Errorf("cannot write %s: %w", s.file, err))
	}
	s.notices.start()
	if opts.Watch {
		if err := s.watch(); err != nil {
			return fail(err)
		}
	}
	// The room's other files go beside the first, as the host lists them.
	s.mirrorMu.Lock()
	s.startMirror()
	s.mirrorMu.Unlock()
	return s, nil
}

// takeFormat shares the first file as the host does: as text, or a canvas
// as nodes and edges, whose copy is JSON Canvas rendered from them and
// whose edits are taken in as the host takes in edits to its file.
func (s *Session) takeFormat(host map[string]any) {
	if format, _ := host["format"].(string); format == formatCanvas {
		s.sharedFile.content = &canvasContent{doc: s.Doc}
		s.Text = nil
	}
}

// watchesCopies tells whether a guest watches its copies for edits: only an
// edit link edits.
func watchesCopies(watch bool, access protocol.Access) bool {
	if access != protocol.AccessEdit {
		return false
	}
	return watch
}

// listWait bounds how long Join waits for the host's list of files, which
// names the first file as the room shows it; every host sends one.
const listWait = 2 * time.Second

// awaitFirstList waits for the host's list of files, and names the first
// file by the name the host goes by meanwhile if it does not come.
func (s *Session) awaitFirstList(hostName string) {
	select {
	case <-s.mirror.firstList:
	case <-time.After(listWait):
	}
	s.filesMu.Lock()
	defer s.filesMu.Unlock()
	if s.sharedFile.path == "" {
		s.sharedFile.path = hostName
	}
}

// copyRoot opens the directory the copies go in: dir, or when it is empty a
// new temporary directory, which it also returns as temp.
func copyRoot(dir, roomID string) (abs, temp string, root *os.Root, err error) {
	if dir == "" {
		// The room ID only tells the directories apart; a short part does.
		if temp, err = os.MkdirTemp("", "pedit-"+roomID[:min(len(roomID), maxRoomInDir)]+"-"); err != nil {
			return "", "", nil, fmt.Errorf("cannot create a temporary directory for the copies: %w", err)
		}
		dir = temp
	}
	abs, err = filepath.Abs(dir)
	if err != nil {
		_ = removeTemp(temp)
		return "", "", nil, err
	}
	// Every copy is made through this handle, so the directory stays the one
	// made here, whatever its name comes to lead to.
	root, err = os.OpenRoot(abs)
	if err != nil {
		_ = removeTemp(temp)
		return "", "", nil, err
	}
	return abs, temp, root, nil
}

// guestAwareness is the awareness of a guest called name.
func guestAwareness(doc *crdt.Doc, name string) *awareness.Awareness {
	aw := awareness.New(uint64(doc.ClientID()))
	if name == "" {
		name = "guest"
	}
	aw.SetLocalState(map[string]any{
		"role": "guest",
		"name": name,
		"user": map[string]any{"name": name},
	})
	return aw
}

// roomWait is what Join waits on until the room has sent its content.
type roomWait struct {
	synced, closed chan struct{}
	ended          atomic.Value // the final protocol.Status, set before closed is
	hostSeen       chan struct{}
}

// end records the final status st, once.
func (r *roomWait) end(st protocol.Status) {
	select {
	case <-r.closed:
	default:
		r.ended.Store(st)
		close(r.closed)
	}
}

// endedErr says why the room ended.
func (r *roomWait) endedErr() error { return endedErr(r.ended.Load().(protocol.Status)) }

// canceled is the error for a canceled ctx. OnStatus may cancel ctx on the
// very status that ended the room, so both are ready at once; the reason the
// room ended wins.
func (r *roomWait) canceled(ctx context.Context) error {
	select {
	case <-r.closed:
		return r.endedErr()
	default:
		return ctx.Err()
	}
}

// wait waits for a host to show up in the room, and then for the room's
// content, both within timeout. It returns the host's awareness state.
// The replay of a room kept while its host is away ends the wait too, with
// no host: the relay sent all it keeps.
func (r *roomWait) wait(ctx context.Context, aw *awareness.Awareness, client *protocol.Client, replayed <-chan struct{}, timeout time.Duration) (map[string]any, error) {
	deadline := time.NewTimer(timeout)
	defer deadline.Stop()
	var host map[string]any
	for host == nil {
		select {
		case <-replayed:
			if host, _ = hostState(aw, client); host == nil {
				return nil, nil
			}
		case <-r.hostSeen:
			host, _ = hostState(aw, client)
		case <-r.closed:
			return nil, r.endedErr()
		case <-deadline.C:
			return nil, fmt.Errorf("no host answered within %s", timeout)
		case <-ctx.Done():
			return nil, r.canceled(ctx)
		}
	}
	select {
	case <-r.synced:
	case <-r.closed:
		return nil, r.endedErr()
	case <-deadline.C:
		return nil, fmt.Errorf("the room did not send its content within %s", timeout)
	case <-ctx.Done():
		return nil, r.canceled(ctx)
	}
	return host, nil
}

// openCopy opens the copy of the host's file hostName in dir, through root.
// The copy must not exist yet, and is never written over once it does.
func (s *Session) openCopy(root *os.Root, dir, hostName string, opts JoinOptions, onError func(error)) error {
	base := copyName(0, hostName)
	s.file = filepath.Join(dir, base)
	s.notices = newNotices(s.file, opts.OnNotice, onError)
	if _, err := root.Lstat(base); err == nil {
		return &ErrFileExists{Path: s.file}
	} else if !errors.Is(err, os.ErrNotExist) {
		return err
	}
	var err error
	s.bound, err = filewriter.OpenBoundIn(root, base)
	if err != nil {
		return err
	}
	if opts.writeHook != nil {
		s.bound.SetTestHook(opts.writeHook)
	}
	// The copy is new: a file that appears at its name is never replaced.
	s.bound.CreateOnly()
	return nil
}

// publishWriter makes w the copy's writer and gives it the content so far.
// Under the client's lock, no remote update can land between taking the
// first snapshot and publishing the writer that OnUpdate schedules on, so
// every edit after the snapshot is scheduled. The writer skips content equal
// to what it last wrote (nothing yet), so an empty document is created by
// hand, before any later edit can be written.
func (s *Session) publishWriter(w *filewriter.Writer) error {
	var created error
	s.Client.Do(func() {
		if s.beforePublishWriter != nil {
			s.beforePublishWriter()
		}
		s.mu.Lock()
		s.Writer = w
		s.mu.Unlock()
		if content := s.content.render(); content != "" {
			w.Schedule(content)
		} else {
			created = s.bound.Write("", "")
		}
	})
	return created
}

// File is the path of the shared file, or of the copy when the session joined
// a room.
func (s *Session) File() string { return s.file }

// Temporary reports whether the copy is removed when the session stops.
func (s *Session) Temporary() bool { return s.temp != "" }

// KeepCopy makes Stop keep the temporary directory of the copies. Call it
// before Stop.
func (s *Session) KeepCopy() { s.temp = "" }

// removeTemp removes the temporary directory of a copy, if there is one.
func removeTemp(dir string) error {
	if dir == "" {
		return nil
	}
	return os.RemoveAll(dir)
}

func (s *Session) reportPeople(onPeople func([]string)) {
	if onPeople == nil {
		return
	}
	var names []string
	for id, st := range s.awareness.GetStates() {
		if id == s.awareness.ClientID() || s.isSourcePage(id) {
			continue
		}
		name := displayName(st.State)
		// What a participant may do follows from the link it joined with.
		if access, ok := s.Client.AccessOf(id); ok && access != protocol.AccessEdit {
			name += " (" + access.String() + " only)"
		}
		names = append(names, name)
	}
	sort.Strings(names)
	onPeople(names)
}

// hostState returns the awareness state of the host, if one is in the room:
// one that came signed by an editor (protocol.Client.AccessOf), since anyone
// can say they are the host.
func hostState(aw *awareness.Awareness, client *protocol.Client) (map[string]any, bool) {
	for id, st := range aw.GetStates() {
		if access, _ := client.AccessOf(id); id == aw.ClientID() || access != protocol.AccessEdit {
			continue
		}
		if role, _ := st.State["role"].(string); role == "host" {
			return st.State, true
		}
	}
	return nil, false
}

// parseShareURL returns the room's WebSocket URL, its ID and the secrets of
// a share link: an edit link, or a comment link (#212). The secrets are in
// the fragment and never leave this process. The ID is used in a directory
// name, so only the characters of a generated room ID are accepted.
func parseShareURL(link string) (wsURL, roomID string, secrets protocol.LinkSecrets, err error) {
	u, err := url.Parse(link)
	if err != nil || u.Host == "" || (u.Scheme != "http" && u.Scheme != "https") {
		return "", "", secrets, fmt.Errorf("%s is not a share link", redactFragment(link))
	}
	id, ok := strings.CutPrefix(u.Path, "/r/")
	if !ok || !isRoomID(id) {
		return "", "", secrets, fmt.Errorf("%s is not a share link (expected /r/<room>#<key>)", redactFragment(link))
	}
	if u.Fragment == "" {
		return "", "", secrets, errors.New("the link has no key after #; copy the whole link, including the part after #")
	}
	secrets, err = protocol.ParseFragment(u.Fragment)
	if err != nil {
		return "", "", protocol.LinkSecrets{}, errors.New("the link's key after # is not valid")
	}
	if secrets.Access == protocol.AccessRead {
		return "", "", protocol.LinkSecrets{}, fmt.Errorf("this link is %s only: open it in a browser", secrets.Access)
	}
	wsURL = "ws" + strings.TrimPrefix(u.Scheme, "http") + "://" + u.Host + "/api/rooms/" + id + "/ws"
	return wsURL, id, secrets, nil
}

// maxRoomInDir bounds the part of the room ID in the name of the copies'
// directory, so their paths stay short on Windows.
const maxRoomInDir = 16

// isRoomID accepts the base64url alphabet room IDs are made of, at a sane length.
func isRoomID(id string) bool {
	if id == "" || len(id) > 64 {
		return false
	}
	for _, r := range id {
		switch {
		case r >= 'a' && r <= 'z', r >= 'A' && r <= 'Z', r >= '0' && r <= '9', r == '-', r == '_':
		default:
			return false
		}
	}
	return true
}

// redactFragment keeps the key out of error messages.
func redactFragment(link string) string {
	before, _, found := strings.Cut(link, "#")
	if found {
		return before + "#…"
	}
	return link
}

// resumeFromDisk merges what changed in the copies while the host was away,
// when nothing was taken from them (sharedFile.syncFromDisk).
func (s *Session) resumeFromDisk() {
	s.filesMu.Lock()
	files := s.files()
	s.filesMu.Unlock()
	for _, f := range files {
		f.mu.Lock()
		ready := f.Writer != nil
		f.mu.Unlock()
		if ready {
			f.scheduleSyncFromDisk()
		}
	}
}
