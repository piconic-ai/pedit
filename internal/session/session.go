// Package session shares a local file in a pedit room.
package session

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"mime"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
	"unicode"
	"unicode/utf8"

	"github.com/fsnotify/fsnotify"
	"github.com/piconic-ai/pedit/internal/attach"
	"github.com/piconic-ai/pedit/internal/filewriter"
	"github.com/piconic-ai/pedit/internal/protocol"
	"github.com/reearth/ygo/awareness"
	"github.com/reearth/ygo/crdt"
)

type Options struct {
	File string
	// Root is the directory the paths of a room's files are shown relative
	// to, such as where pedit runs. A file outside it is shown by its name.
	// Empty: the first file's directory.
	Root string
	// Project is the directory whose .pedit/meta/ keeps the comments of the
	// files inside it (#121). Empty: no file offers comments.
	Project string
	// Server is the base URL of the pedit server, e.g. https://edit.piconic.ai
	Server string
	Name   string
	// Avatar is the URL of the host's picture, shown to the others.
	Avatar     string
	WriteDelay time.Duration
	// Watch streams edits made to the file outside pedit into the room.
	Watch bool
	// Header is sent with every request to the server, such as the Cloudflare
	// Access token of whoever signed in.
	Header     http.Header
	HTTPClient *http.Client
	Dial       protocol.Dialer
	OnStatus   func(protocol.Status)
	// OnPeople is called with the names of the other people in the room,
	// sorted, whenever someone joins, leaves or renames.
	OnPeople func([]string)
	// OnSaved is called with the path, relative to File, of each image
	// someone pasted that was saved beside the file.
	OnSaved func(path string)
	// OnNotice is called, one at a time, with conditions of the file the
	// user can act on: a save that failed, or a change pedit cannot take in,
	// and when each ends. It must not call into the Session.
	OnNotice func(Notice)
	// OnError is called with errors nobody can act on, or that clear by
	// themselves, such as a dropped connection.
	OnError func(error)

	// Keep asks the relay to keep the room open for this long after the host
	// leaves on purpose (docs/design/rooms-away.md), and has Start write the
	// record that --resume takes the room up again by. More are the files to
	// share with the first, so the record lists them all.
	Keep time.Duration
	More []string
	// Resume is the ID of a room Keep left a record of in Project: Start
	// takes in what was written while the host was away, then goes on
	// sharing the record's files in that room. File, More and Server are
	// the record's.
	Resume string
	// OnKeep is called with the seconds the relay keeps the room, which may be
	// less than asked, or 0 if it cannot keep it (it speaks version 5).
	OnKeep func(seconds int64)
	// OnSkipped is called with how many entries guests wrote that were
	// refused, in all; OnImageError with an image of a replayed edit that
	// could not be saved.
	OnSkipped    func(int)
	OnImageError func(path string, err error)
}

type Session struct {
	// URL is the share URL. Its fragment holds the key and must never be sent to the server.
	URL string
	Doc *crdt.Doc
	// Text is the shared text, or nil when the file is a canvas, shared as
	// nodes and edges.
	Text   *crdt.YText
	Client *protocol.Client
	// The first file, shared in the room's own doc (file 0).
	*sharedFile

	awareness *awareness.Awareness
	watcher   *fsnotify.Watcher
	watchDone chan struct{}
	stopAlive func()
	// temp is the directory holding a joined copy that is removed on Stop.
	temp string

	// What adding a file needs, set by Start (files.go).
	opts Options
	// project is Options.Project, opened, or nil, and noProject why it
	// could not be opened.
	project   *os.Root
	noProject string
	server    string
	roomID    string
	blobKeys  *protocol.BlobKeys

	// filesMu guards the files added after the first, the watched files and
	// stopped.
	filesMu sync.Mutex
	added   []*sharedFile
	watched map[string]*sharedFile // by local path
	dirs    map[string]bool        // watched directories
	nextID  uint64
	closed  bool

	// mirror mirrors the room's other files, when joined (mirror.go).
	mirrorMu sync.Mutex
	mirror   *mirror

	stopOnce sync.Once
	stopErr  error

	// away keeps the room for the host's return, if it asked for that.
	away *keepAway
	// resumed is what taking in a kept room left, while Start runs.
	resumed *resumed

	// Test seams, called during Stop.
	beforeDestroy    func()
	beforeFinalWrite func(attempt int)
	// Test seam, called by Join under the client's lock, just before the
	// writer is published: a remote edit sent from here is applied after.
	beforePublishWriter func()
}

// fileOrigin tags changes merged in from the file.
const fileOrigin = "file"

// editOrigin tags a canvas someone edited by hand in the browser.
const editOrigin = "edit"

// Awareness timings. We renew our state as often as y-protocols does, but drop
// a peer only after 90 s of silence rather than its 30 s: Chrome wakes the
// timers of a tab hidden for 5 minutes at most once a minute, so a guest in a
// background tab renews only that often (#193). The web client drops peers
// after the same timeout (packages/web/src/expiry.ts).
const (
	outdatedTimeout = 90 * time.Second
	renewInterval   = 15 * time.Second
)

func Start(ctx context.Context, opts Options) (*Session, error) {
	onError := opts.OnError
	if onError == nil {
		onError = func(error) {}
	}
	if opts.Root == "" {
		opts.Root = filepath.Dir(opts.File)
	}
	root, err := filepath.Abs(opts.Root)
	if err != nil {
		return nil, err
	}
	opts.Root = root
	res, err := beginKeep(ctx, &opts)
	if err != nil {
		return nil, err
	}
	// Left on purpose, so that the relay keeps the room, if Start fails.
	defer func() { res.abandon() }()
	project, noProject := openProject(opts.Project)
	defer func() {
		if project != nil {
			_ = project.Close()
		}
	}()
	if keepsComments(project, opts.File) {
		return nil, errKeepsComments
	}
	bound, initial, err := openShared(opts.File)
	if err != nil {
		return nil, err
	}
	defer func() {
		if bound != nil {
			_ = bound.Close()
		}
	}()
	// Before creating a room, so a canvas that is not valid fails right away.
	doc := crdt.New()
	shared, err := newContent(doc, opts.File, initial, res.stateOf(opts.File))
	if err != nil {
		return nil, err
	}
	var text *crdt.YText
	if c, ok := shared.(*textContent); ok {
		text = c.text
	}
	if frame := protocol.StateFrameBytes(doc); frame > protocol.MaxFrameBytes {
		return nil, tooLarge(opts.File, initial, shared, frame)
	}

	server := strings.TrimRight(opts.Server, "/")
	room, key, err := openRoom(ctx, opts, server, res)
	if err != nil {
		return nil, err
	}
	rawKey, err := protocol.DecodeKey(key)
	if err != nil {
		return nil, err
	}
	keys, err := protocol.EditKeys(rawKey, room.ID)
	if err != nil {
		return nil, err
	}
	wsURL := "ws" + strings.TrimPrefix(server, "http") + "/api/rooms/" + room.ID + "/ws"

	aw := awareness.New(uint64(doc.ClientID()))
	aw.SetLocalState(hostAwareness(opts, shared))
	blobKeys, err := protocol.DeriveBlobKeys(keys.FrameKey)
	if err != nil {
		return nil, err
	}
	// The host's token lets it add images as well as fetch them.
	blobKeys.Admission = keys.EditAdmission

	s := &Session{
		URL:  server + "/r/" + room.ID + "#" + key,
		Doc:  doc,
		Text: text,
		sharedFile: &sharedFile{
			file:    opts.File,
			path:    sharedPath(opts.Root, opts.File),
			doc:     doc,
			bound:   bound,
			content: shared,
			onError: onError,
			notices: newNotices(opts.File, opts.OnNotice, onError),
		},
		awareness: aw,
		opts:      opts,
		project:   project,
		noProject: noProject,
		server:    server,
		roomID:    room.ID,
		blobKeys:  blobKeys,
		nextID:    1,
		resumed:   res,
	}
	s.opts.OnError = onError
	s.Writer = filewriter.New(opts.File, initial, filewriter.Options{
		Bound:            bound,
		Delay:            opts.WriteDelay,
		OnError:          s.notices.saveError,
		OnWritten:        s.notices.written,
		OnExternalChange: s.scheduleSyncFromDisk,
	})
	header, dial := hostHeader(opts, room.HostToken, res)
	s.Client, err = protocol.NewClient(protocol.ClientOptions{
		URL:       wsURL,
		RoomID:    room.ID,
		Key:       rawKey,
		Doc:       doc,
		Awareness: aw,
		Header:    header,
		Host:      true,
		Dial:      dial,
		OnKind:    s.onKind,
		OnText:    s.onText,
		OnStatus:  s.onStatus,
		OnError:   onError,
		// Set below, before the client connects.
		OnAttachment:     func(m protocol.Attachment) { s.attachments.Handle(m) },
		OnCanvas:         func(m protocol.CanvasMessage) { s.handleCanvas(m) },
		OnFileAttachment: s.handleFileAttachment,
		OnFileCanvas:     s.handleFileCanvas,
		OnAccess:         func(uint64) { s.reportPeople(opts.OnPeople) },
	})
	if err != nil {
		return nil, err
	}
	s.client = s.Client
	s.sendCanvas = s.Client.SendCanvas
	s.attachments = attach.New(attach.Options{
		File:            opts.File,
		Root:            bound.Dir(),
		InitialDocument: initial,
		Server:          server,
		Room:            room.ID,
		// Without the host token: blobs are for everyone in the room.
		Header:     opts.Header,
		HTTPClient: opts.HTTPClient,
		Keys:       blobKeys,
		Send:       s.Client.SendAttachment,
		OnSaved: func(path string) {
			s.notices.imageSaved()
			if opts.OnSaved != nil {
				opts.OnSaved(path)
			}
		},
		OnSaveError: s.notices.imageError,
		OnError:     onError,
	})

	doc.OnUpdate(func(_ []byte, origin any) {
		// Both come in under the client's lock, so the doc can be read here.
		if origin == s.Client || origin == editOrigin {
			s.Writer.Schedule(s.content.render())
		}
	})
	aw.OnChange(func(awareness.ChangeEvent) { s.reportPeople(opts.OnPeople) })
	s.stopAlive = keepAlive(aw)
	s.notices.start()
	s.startMeta()
	if err := s.keepOpen(&opts, room.HostToken, key, res); err != nil {
		_ = s.Stop()
		return nil, err
	}
	s.Client.Connect()

	if opts.Watch {
		if err := s.watch(); err != nil {
			_ = s.Stop()
			return nil, err
		}
	}
	// Session owns the directory handles from here.
	bound, project, res = nil, nil, nil
	return s, nil
}

// hostAwareness is what the host tells the room about itself.
func hostAwareness(opts Options, shared content) map[string]any {
	name := opts.Name
	if name == "" {
		name = "host"
	}
	user := map[string]any{"name": name}
	if opts.Avatar != "" {
		user["avatar"] = opts.Avatar
	}
	state := map[string]any{
		"role": "host",
		"name": name,
		"user": user,
		"file": filepath.Base(opts.File),
		// Browsers let people paste images only when the host says it saves them.
		"attachments": map[string]any{"dir": attach.Dir, "maxBytes": attach.MaxBytes},
	}
	if _, ok := shared.(*canvasContent); ok {
		state["format"] = formatCanvas
	}
	return state
}

// displayName reads a peer's name the way the web editor does: from
// user.name (browsers) or name (older hosts).
func displayName(state map[string]any) string {
	user, _ := state["user"].(map[string]any)
	for _, v := range []any{user["name"], state["name"]} {
		name, _ := v.(string)
		if name = cleanName(name); name != "" {
			return name
		}
	}
	return "Someone"
}

// maxNameLength matches the web editor's limit on names.
const maxNameLength = 40

// cleanName makes a name safe to print. Names come from other people's
// browsers and end up on the host's terminal, so anything that could move
// the cursor, start an escape sequence or reorder the text is dropped.
func cleanName(name string) string {
	name = strings.Map(func(r rune) rune {
		if unicode.IsControl(r) || unicode.Is(unicode.Bidi_Control, r) {
			return -1
		}
		return r
	}, name)
	name = strings.TrimSpace(name)
	if r := []rune(name); len(r) > maxNameLength {
		name = strings.TrimSpace(string(r[:maxNameLength])) + "…"
	}
	return name
}

// ErrBehindAccess means Cloudflare Access sent us to its login page: we sent
// no credentials, or Access did not accept them.
var ErrBehindAccess = errors.New("Cloudflare Access sent us to its login page")

type room struct {
	ID        string `json:"id"`
	HostToken string `json:"hostToken"`
}

func createRoom(ctx context.Context, client *http.Client, server string, header http.Header) (*room, error) {
	if client == nil {
		client = http.DefaultClient
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, server+"/api/rooms", bytes.NewReader(nil))
	if err != nil {
		return nil, err
	}
	for k, v := range header {
		req.Header[k] = v
	}
	// A room creation request can carry a Cloudflare Access credential. Keep
	// the caller's client unchanged, and never forward that credential to a
	// redirect destination.
	noRedirect := *client
	noRedirect.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	res, err := noRedirect.Do(req)
	if err != nil {
		return nil, fmt.Errorf("failed to create a room: %w", err)
	}
	defer res.Body.Close()
	// Cloudflare Access answers requests it does not let through with its login page.
	if location, err := res.Location(); err == nil && strings.HasPrefix(location.Path, "/cdn-cgi/access/") {
		return nil, fmt.Errorf("failed to create a room on %s: %w", server, ErrBehindAccess)
	}
	if res.StatusCode < 200 || res.StatusCode > 299 {
		if msg := serverMessage(res); msg != "" {
			return nil, fmt.Errorf("failed to create a room on %s: %d %s: %s", server, res.StatusCode, http.StatusText(res.StatusCode), msg)
		}
		// Not res.Status: its reason phrase is the server's, printed as it came.
		return nil, fmt.Errorf("failed to create a room on %s: %d %s", server, res.StatusCode, http.StatusText(res.StatusCode))
	}
	var r room
	if err := json.NewDecoder(res.Body).Decode(&r); err != nil || r.ID == "" {
		return nil, fmt.Errorf("failed to create a room: %s did not answer like a pedit server (check server in .pedit/config.yaml)", server)
	}
	if r.HostToken == "" {
		// Servers before host tokens cannot close a room when its host leaves.
		return nil, fmt.Errorf("failed to create a room: %s did not return a host token; the server is older than this pedit and needs an update", server)
	}
	return &r, nil
}

// serverMessage is what a server says about an error in a short plain-text
// body, such as when to try again, cut to one line of printable characters so
// it cannot garble the terminal. Anything else says nothing.
func serverMessage(res *http.Response) string {
	if media, _, err := mime.ParseMediaType(res.Header.Get("Content-Type")); err != nil || media != "text/plain" {
		return ""
	}
	body, _ := io.ReadAll(io.LimitReader(res.Body, 512))
	text := strings.Map(func(r rune) rune {
		if r == utf8.RuneError || !unicode.IsPrint(r) {
			return ' '
		}
		return r
	}, string(body))
	text = strings.Join(strings.Fields(text), " ")
	if runes := []rune(text); len(runes) > 200 {
		text = string(runes[:200]) + "…"
	}
	return text
}

// keepAlive renews our awareness state and drops peers that went silent, as the
// JavaScript Awareness does on its own.
func keepAlive(aw *awareness.Awareness) func() {
	return keepAliveFor(aw, outdatedTimeout, renewInterval)
}

// keepAliveFor is keepAlive with the given timings, for tests.
func keepAliveFor(aw *awareness.Awareness, timeout, renew time.Duration) func() {
	stopExpiry := aw.StartAutoExpiry(timeout)
	ticker := time.NewTicker(renew)
	done := make(chan struct{})
	go func() {
		for {
			select {
			case <-ticker.C:
				aw.Heartbeat()
			case <-done:
				return
			}
		}
	}()
	return func() {
		ticker.Stop()
		close(done)
		stopExpiry()
	}
}

// Watch directories rather than files: editors often save by renaming a new
// file over the old one, which would orphan a watch on the file itself.
// fsnotify does not watch subdirectories, so each shared file's directory is
// watched, and only the shared names in it are acted on.
func (s *Session) watch() error {
	w, err := fsnotify.NewWatcher()
	if err != nil {
		return err
	}
	s.filesMu.Lock()
	s.watcher = w
	s.watched = map[string]*sharedFile{}
	s.dirs = map[string]bool{}
	err = s.watchFile(s.sharedFile)
	s.filesMu.Unlock()
	if err != nil {
		_ = w.Close()
		return err
	}
	s.watchDone = make(chan struct{})
	go func() {
		defer close(s.watchDone)
		for {
			select {
			case ev, ok := <-w.Events:
				if !ok {
					return
				}
				s.filesMu.Lock()
				f := s.watched[filepath.Clean(ev.Name)]
				s.filesMu.Unlock()
				if f != nil {
					f.scheduleSyncFromDisk()
				}
			case err, ok := <-w.Errors:
				if !ok {
					return
				}
				s.onError(err)
			}
		}
	}()
	return nil
}

// watchFile starts acting on changes to f. The caller holds s.filesMu.
func (s *Session) watchFile(f *sharedFile) error {
	if s.watcher == nil {
		return nil
	}
	dir := filepath.Dir(f.file)
	if !s.dirs[dir] {
		if err := s.watcher.Add(dir); err != nil {
			return err
		}
		s.dirs[dir] = true
	}
	s.watched[filepath.Clean(f.file)] = f
	return nil
}

// errNotUTF8 means the file on disk is no longer UTF-8 text, such as after an
// editor saved it in another encoding. Taking it in would lose what pedit
// cannot read, and saving would then overwrite the file with that loss.
var errNotUTF8 = errors.New("it is not UTF-8 text")

// maxRejectReason keeps a rejection within what a canvas message carries.
const maxRejectReason = 16 << 10

// truncate cuts s to at most n bytes, on a character boundary.
func truncate(s string, n int) string {
	if len(s) <= n {
		return s
	}
	for n > 0 && !utf8.RuneStart(s[n]) {
		n--
	}
	return s[:n]
}

// finalWriteAttempts bounds how often Stop retries when the file keeps changing
// outside pedit while it tries to save.
const finalWriteAttempts = 3

// Stop leaves the room and writes the final state to the files. It reports
// an error when the final state could not be saved.
func (s *Session) Stop() error {
	s.stopOnce.Do(func() {
		s.filesMu.Lock()
		s.closed = true
		files := s.files()
		s.filesMu.Unlock()
		// Stop returns what goes wrong from here.
		for _, f := range files {
			f.stop()
		}
		if s.watcher != nil {
			_ = s.watcher.Close()
			<-s.watchDone
		}
		// Waits for syncs already started by the timers; none can start after this.
		for _, f := range files {
			f.syncing.Lock()
			defer f.syncing.Unlock()
		}

		// Merge last-second external edits while peers can still get them,
		// and save right away: leaving can take a while, and a second Ctrl+C
		// exits.
		for _, f := range files {
			f.syncFromDisk()
			f.Writer.Schedule(f.render())
			_ = f.Writer.Flush()
			if f.meta != nil {
				// Before leaving, as the file is.
				f.meta.stop()
				_ = f.meta.saveNow(true)
			}
		}
		if s.away != nil {
			s.away.leaving()
		}

		if s.beforeDestroy != nil {
			s.beforeDestroy()
		}
		for _, f := range files {
			// A joined session saves no attachments.
			if f.attachments != nil {
				f.attachments.Close()
			}
		}
		s.Client.Destroy()

		// Save again: edits may have arrived while leaving, and none can arrive now.
		for _, f := range files {
			s.stopErr = errors.Join(s.stopErr, s.finalSave(f))
			if f.meta != nil {
				s.stopErr = errors.Join(s.stopErr, f.meta.finish())
			}
		}
		if s.away != nil {
			s.stopErr = errors.Join(s.stopErr, s.away.finish())
		}
		if s.project != nil {
			_ = s.project.Close()
		}
		s.stopAlive()
		s.awareness.Destroy()
		for _, f := range files {
			s.stopErr = errors.Join(s.stopErr, f.close())
		}
		s.mirrorMu.Lock()
		if s.mirror != nil && s.mirror.root != nil {
			_ = s.mirror.root.Close()
		}
		s.mirrorMu.Unlock()
		if s.temp != "" {
			// A temporary copy is for the session only: nothing to save.
			s.stopErr = errors.Join(s.stopErr, removeTemp(s.temp))
		}
	})
	return s.stopErr
}

// finalSave writes f once the room is left, merging in saves made outside
// pedit meanwhile.
func (s *Session) finalSave(f *sharedFile) error {
	var err error
	for attempt := 1; ; attempt++ {
		if s.beforeFinalWrite != nil {
			s.beforeFinalWrite(attempt)
		}
		f.Writer.Schedule(f.render())
		err = f.Writer.Flush()
		if !errors.Is(err, filewriter.ErrExternalChange) || attempt == finalWriteAttempts {
			return err
		}
		// Someone saved the file meanwhile: merge it in and try again.
		f.syncFromDisk()
	}
}

// files returns every file of the session, the first one first. The caller
// holds s.filesMu.
func (s *Session) files() []*sharedFile {
	return append([]*sharedFile{s.sharedFile}, s.added...)
}

// Saving is often truncate-then-write, so a read right after the change event can
// see a half-written file. Read until two consecutive reads agree; report !ok if
// they never do, so a half-written file is not taken for the new content.
func readSettled(path string) (string, bool) {
	return settle(func() (string, bool) { return filewriter.ReadFile(path) }, 30*time.Millisecond, 10)
}

func settle(read func() (string, bool), interval time.Duration, maxReads int) (string, bool) {
	previous, prevOK := read()
	for range maxReads - 1 {
		time.Sleep(interval)
		current, ok := read()
		if current == previous && ok == prevOK {
			return current, ok
		}
		previous, prevOK = current, ok
	}
	return "", false
}
