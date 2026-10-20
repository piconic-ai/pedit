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
	"unicode"
	"unicode/utf8"

	"github.com/piconic-ai/pedit/internal/filewriter"
	"github.com/piconic-ai/pedit/internal/protocol"
	"github.com/reearth/ygo/awareness"
	"github.com/reearth/ygo/crdt"
)

// JoinOptions joins a room someone else hosts, as a browser would, and keeps a
// local copy of the shared file so any editor can work on it.
type JoinOptions struct {
	// URL is the share link, with the key in its fragment.
	URL string
	// Directory is where the copy is written, under the name the host shares,
	// and where it stays after the session. Empty: a temporary directory that
	// is removed when the session stops, leaving nothing behind, like a
	// browser tab.
	Directory  string
	Name       string
	WriteDelay time.Duration
	// Watch streams edits made to the copy outside pedit into the room.
	Watch bool
	// Timeout bounds how long Join waits for the room's state; 15s by default.
	Timeout  time.Duration
	Header   http.Header
	Dial     protocol.Dialer
	OnStatus func(protocol.Status)
	OnPeople func([]string)
	// OnNotice and OnError are as in Options.
	OnNotice func(Notice)
	OnError  func(error)
	// OnMirrored is called with the path of each other file the room shares
	// as it is mirrored beside the first, with why not when it is not. Called
	// one at a time.
	OnMirrored func(path string, err error)

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

// ErrFileExists means the copy was not written because a file of that name is
// already in Directory.
type ErrFileExists struct{ Path string }

func (e *ErrFileExists) Error() string {
	return fmt.Sprintf("%s already exists; move it away, or join from another directory", e.Path)
}

// Join enters the room at opts.URL, waits for its content and writes it to a
// file named as the host's. The returned Session mirrors the copy and the room
// both ways until Stop; Session.URL is the link joined.
func Join(ctx context.Context, opts JoinOptions) (*Session, error) {
	onError := opts.OnError
	if onError == nil {
		onError = func(error) {}
	}
	if opts.Timeout == 0 {
		opts.Timeout = 15 * time.Second
	}
	wsURL, roomID, rawKey, err := parseShareURL(opts.URL)
	if err != nil {
		return nil, err
	}
	dir, temp := opts.Directory, ""
	if dir == "" {
		if temp, err = os.MkdirTemp("", "pedit-"+roomID+"-"); err != nil {
			return nil, fmt.Errorf("cannot create a temporary directory for the copy: %w", err)
		}
		dir = temp
	}
	dir, err = filepath.Abs(dir)
	if err != nil {
		_ = removeTemp(temp)
		return nil, err
	}

	doc := crdt.New()
	shared := newTextContent(doc, "")
	aw := awareness.New(uint64(doc.ClientID()))
	name := opts.Name
	if name == "" {
		name = "guest"
	}
	aw.SetLocalState(map[string]any{
		"role": "guest",
		"name": name,
		"user": map[string]any{"name": name},
	})

	s := &Session{
		URL:        opts.URL,
		Doc:        doc,
		Text:       shared.text,
		sharedFile: &sharedFile{doc: doc, content: shared, onError: onError},
		awareness:  aw,
		temp:       temp,

		beforePublishWriter: opts.beforePublishWriter,
	}
	s.mirror = &mirror{dir: dir, opts: opts, keys: map[string]bool{}, dirs: map[string]bool{}, done: map[uint64]bool{}}
	synced := make(chan struct{})
	closed := make(chan struct{})
	var ended atomic.Value // the final protocol.Status, set before closed is
	s.Client, err = protocol.NewClient(protocol.ClientOptions{
		URL:       wsURL,
		Key:       rawKey,
		Doc:       doc,
		Awareness: aw,
		Header:    opts.Header,
		Dial:      opts.Dial,
		OnStatus: func(st protocol.Status) {
			if st.Final() {
				select {
				case <-closed:
				default:
					ended.Store(st)
					close(closed)
				}
			}
			if opts.OnStatus != nil {
				opts.OnStatus(st)
			}
		},
		OnSynced:   func() { close(synced) },
		OnError:    onError,
		OnManifest: s.takeManifest,
	})
	if err != nil {
		return nil, err
	}
	s.client = s.Client
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
	hostSeen := make(chan struct{}, 1)
	aw.OnChange(func(awareness.ChangeEvent) {
		if _, ok := hostState(aw); ok {
			select {
			case hostSeen <- struct{}{}:
			default:
			}
		}
		s.reportPeople(opts.OnPeople)
	})
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
		_ = removeTemp(temp)
		return nil, err
	}
	// OnStatus may cancel ctx on the very status that ended the room, so both
	// are ready at once; the reason the room ended wins.
	canceled := func() (*Session, error) {
		select {
		case <-closed:
			return fail(endedErr(ended.Load().(protocol.Status)))
		default:
			return fail(ctx.Err())
		}
	}
	deadline := time.NewTimer(opts.Timeout)
	defer deadline.Stop()
	var host map[string]any
	for host == nil {
		select {
		case <-hostSeen:
			host, _ = hostState(aw)
		case <-closed:
			return fail(endedErr(ended.Load().(protocol.Status)))
		case <-deadline.C:
			return fail(fmt.Errorf("no host answered within %s", opts.Timeout))
		case <-ctx.Done():
			return canceled()
		}
	}
	select {
	case <-synced:
	case <-closed:
		return fail(endedErr(ended.Load().(protocol.Status)))
	case <-deadline.C:
		return fail(fmt.Errorf("the room did not send its content within %s", opts.Timeout))
	case <-ctx.Done():
		return canceled()
	}
	if format, _ := host["format"].(string); format == formatCanvas {
		return fail(errors.New("this room shares a canvas as nodes and edges, which pedit cannot join from the command line yet; open the link in a browser"))
	}
	base, ok := sharedFileName(host)
	if !ok {
		return fail(errors.New("the host did not share a usable file name"))
	}
	s.file = filepath.Join(dir, base)
	s.notices = newNotices(s.file, opts.OnNotice, onError)
	if _, err := os.Lstat(s.file); err == nil {
		return fail(&ErrFileExists{Path: s.file})
	} else if !errors.Is(err, os.ErrNotExist) {
		return fail(err)
	}
	s.bound, err = filewriter.OpenBound(s.file)
	if err != nil {
		return fail(err)
	}
	if opts.writeHook != nil {
		s.bound.SetTestHook(opts.writeHook)
	}
	// The copy is new: a file that appears at its name is never replaced.
	s.bound.CreateOnly()

	w := filewriter.New(s.file, "", filewriter.Options{
		Bound:            s.bound,
		Delay:            opts.WriteDelay,
		OnError:          s.notices.saveError,
		OnWritten:        s.notices.written,
		OnExternalChange: s.scheduleSyncFromDisk,
	})
	// Under the client's lock, no remote update can land between taking the
	// first snapshot and publishing the writer that OnUpdate schedules on,
	// so every edit after the snapshot is scheduled. The writer skips content
	// equal to what it last wrote (nothing yet), so an empty document is
	// created by hand, before any later edit can be written.
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
	if created != nil {
		return fail(fmt.Errorf("cannot write %s: %w", s.file, created))
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
	err = s.startMirror(base)
	s.mirrorMu.Unlock()
	if err != nil {
		onError(err)
	}
	return s, nil
}

// File is the path of the shared file, or of the copy when the session joined
// a room.
func (s *Session) File() string { return s.file }

// Temporary reports whether the copy is removed when the session stops.
func (s *Session) Temporary() bool { return s.temp != "" }

// KeepCopy makes Stop keep a temporary copy, as a copy placed in a
// directory is kept. Call it before Stop.
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
		if id != s.awareness.ClientID() {
			names = append(names, displayName(st.State))
		}
	}
	sort.Strings(names)
	onPeople(names)
}

// hostState returns the awareness state of the host, if one is in the room.
func hostState(aw *awareness.Awareness) (map[string]any, bool) {
	for id, st := range aw.GetStates() {
		if id == aw.ClientID() {
			continue
		}
		if role, _ := st.State["role"].(string); role == "host" {
			return st.State, true
		}
	}
	return nil, false
}

// sharedFileName takes the file name the host shares, which comes from the
// room: only a plain name is accepted, never a path, and nothing that changes
// how the name prints. "invoice\u202ecod.md" would show as invoicedm.doc.
// The path of the copy is put on the clipboard to paste after an editor's
// name in a shell, so it must stay one plain argument there: in sh, cmd and
// PowerShell alike. Of ASCII, only letters, digits and "._-+,@=" are kept,
// and anything else becomes "_", so a name cannot add a word, quote, option,
// expansion or operator: "notes -c '!sh' x.md" is saved as
// notes_-c___sh__x.md. Other characters are kept, but for the spaces, and
// the quotes and dashes PowerShell reads like ASCII ones.
func sharedFileName(host map[string]any) (string, bool) {
	name, _ := host["file"].(string)
	if name == "" || name == "." || name == ".." || len(name) > 255 {
		return "", false
	}
	if strings.ContainsAny(name, `/\`+"\x00") {
		return "", false
	}
	for _, r := range name {
		if unicode.IsControl(r) || unicode.Is(unicode.Bidi_Control, r) {
			return "", false
		}
	}
	return strings.Map(func(r rune) rune {
		if plainInShells(r) {
			return r
		}
		return '_'
	}, name), true
}

// plainInShells tells a character that means nothing but itself in sh, cmd
// and PowerShell, outside quotes.
func plainInShells(r rune) bool {
	if r < utf8.RuneSelf {
		return 'a' <= r && r <= 'z' || 'A' <= r && r <= 'Z' || '0' <= r && r <= '9' || strings.ContainsRune("._-+,@=", r)
	}
	// PowerShell takes these dashes and quotes for "-", ' and ".
	return !unicode.IsSpace(r) && !unicode.Is(unicode.Zs, r) && (r < '\u2013' || r > '\u201e' || r == '\u2016' || r == '\u2017')
}

// parseShareURL returns the room's WebSocket URL, its ID and the key from a
// share link. The key is in the fragment and never leaves this process. The
// ID is used in a directory name, so only the characters of a generated room
// ID are accepted.
func parseShareURL(link string) (wsURL, roomID string, key []byte, err error) {
	u, err := url.Parse(link)
	if err != nil || u.Host == "" || (u.Scheme != "http" && u.Scheme != "https") {
		return "", "", nil, fmt.Errorf("%s is not a share link", redactFragment(link))
	}
	id, ok := strings.CutPrefix(u.Path, "/r/")
	if !ok || !isRoomID(id) {
		return "", "", nil, fmt.Errorf("%s is not a share link (expected /r/<room>#<key>)", redactFragment(link))
	}
	if u.Fragment == "" {
		return "", "", nil, errors.New("the link has no key after #; copy the whole link, including the part after #")
	}
	key, err = protocol.DecodeKey(u.Fragment)
	if err != nil {
		return "", "", nil, fmt.Errorf("the link's key after # is not valid: %w", err)
	}
	wsURL = "ws" + strings.TrimPrefix(u.Scheme, "http") + "://" + u.Host + "/api/rooms/" + id + "/ws"
	return wsURL, id, key, nil
}

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
