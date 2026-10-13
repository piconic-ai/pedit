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
}

type Session struct {
	// URL is the share URL. Its fragment holds the key and must never be sent to the server.
	URL string
	Doc *crdt.Doc
	// Text is the shared text, or nil when the file is a canvas, shared as
	// nodes and edges.
	Text   *crdt.YText
	Client *protocol.Client
	Writer *filewriter.Writer
	bound  *filewriter.BoundFile

	file        string
	content     content
	awareness   *awareness.Awareness
	attachments *attach.Attachments
	watcher     *fsnotify.Watcher
	watchDone   chan struct{}
	stopAlive   func()
	onError     func(error)
	notices     *notices
	// temp is the directory holding a joined copy that is removed on Stop.
	temp string

	mu        sync.Mutex
	readTimer *time.Timer
	stopped   bool
	stopOnce  sync.Once
	stopErr   error

	// syncing serializes syncs from disk, and lets Stop wait out one in flight.
	syncing sync.Mutex
	// invalidOnDisk is the invalid canvas last reported, so it is reported once.
	// Guarded by syncing.
	invalidOnDisk string

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

// Awareness timings of y-protocols: peers that stay silent for outdatedTimeout
// are dropped, so renew our state well before that.
const (
	outdatedTimeout = 30 * time.Second
	renewInterval   = outdatedTimeout / 2
)

func Start(ctx context.Context, opts Options) (*Session, error) {
	onError := opts.OnError
	if onError == nil {
		onError = func(error) {}
	}
	bound, err := filewriter.OpenBound(opts.File)
	if err != nil {
		return nil, fmt.Errorf("cannot open %s: %w", opts.File, err)
	}
	defer func() {
		if bound != nil {
			_ = bound.Close()
		}
	}()
	initial, ok := bound.Read()
	if !ok {
		return nil, fmt.Errorf("cannot read %s", opts.File)
	}
	if !utf8.ValidString(initial) {
		// Before creating a room: once edited, the bytes pedit cannot read
		// would be saved back as U+FFFD, and the file changed for good.
		return nil, fmt.Errorf("%s is not UTF-8 text. pedit shares UTF-8 only, and would replace the bytes it cannot read; convert the file first (for example, iconv -f SHIFT_JIS -t UTF-8)", opts.File)
	}
	// Before creating a room: on connecting, the room gets the whole state in
	// one frame, which the relay caps. Text takes at least its own size there,
	// so a file over the limit is turned away before it is loaded.
	if !isCanvas(opts.File) && protocol.FrameBytes(len(initial)) > protocol.MaxFrameBytes {
		return nil, &TooLargeError{File: opts.File, Size: len(initial)}
	}
	// Before creating a room, so a canvas that is not valid fails right away.
	doc := crdt.New()
	var shared content
	var text *crdt.YText
	if isCanvas(opts.File) {
		c, err := newCanvasContent(doc, opts.File, initial)
		if err != nil {
			return nil, err
		}
		shared = c
	} else {
		c := newTextContent(doc, initial)
		shared, text = c, c.text
	}
	if frame := protocol.StateFrameBytes(doc); frame > protocol.MaxFrameBytes {
		e := &TooLargeError{File: opts.File, Size: len(initial)}
		if _, ok := shared.(*canvasContent); ok {
			e.Shared = frame
		}
		return nil, e
	}

	server := strings.TrimRight(opts.Server, "/")
	room, err := createRoom(ctx, opts.HTTPClient, server, opts.Header)
	if err != nil {
		return nil, err
	}
	key := protocol.GenerateKey()
	rawKey, err := protocol.DecodeKey(key)
	if err != nil {
		return nil, err
	}
	wsURL := "ws" + strings.TrimPrefix(server, "http") + "/api/rooms/" + room.ID + "/ws"

	aw := awareness.New(uint64(doc.ClientID()))
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
	aw.SetLocalState(state)
	blobKeys, err := protocol.DeriveBlobKeys(rawKey)
	if err != nil {
		return nil, err
	}

	s := &Session{
		URL:       server + "/r/" + room.ID + "#" + key,
		Doc:       doc,
		Text:      text,
		file:      opts.File,
		bound:     bound,
		content:   shared,
		awareness: aw,
		onError:   onError,
		notices:   newNotices(opts.File, opts.OnNotice, onError),
	}
	s.Writer = filewriter.New(opts.File, initial, filewriter.Options{
		Bound:            bound,
		Delay:            opts.WriteDelay,
		OnError:          s.notices.saveError,
		OnWritten:        s.notices.written,
		OnExternalChange: s.scheduleSyncFromDisk,
	})
	header := opts.Header.Clone()
	if header == nil {
		header = http.Header{}
	}
	// Marks us as the host: the room closes for everyone once we leave.
	header.Set("Authorization", "Bearer "+room.HostToken)
	s.Client, err = protocol.NewClient(protocol.ClientOptions{
		URL:       wsURL,
		Key:       rawKey,
		Doc:       doc,
		Awareness: aw,
		Header:    header,
		Dial:      opts.Dial,
		OnStatus:  opts.OnStatus,
		OnError:   onError,
		// Set below, before the client connects.
		OnAttachment: func(m protocol.Attachment) { s.attachments.Handle(m) },
		OnCanvas:     s.handleCanvas,
	})
	if err != nil {
		return nil, err
	}
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
	s.Client.Connect()
	s.notices.start()

	if opts.Watch {
		if err := s.watch(); err != nil {
			_ = s.Stop()
			return nil, err
		}
	}
	bound = nil // Session owns the directory handle from here.
	return s, nil
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
			return nil, fmt.Errorf("failed to create a room on %s: %s: %s", server, res.Status, msg)
		}
		return nil, fmt.Errorf("failed to create a room on %s: %s", server, res.Status)
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
	stopExpiry := aw.StartAutoExpiry(outdatedTimeout)
	ticker := time.NewTicker(renewInterval)
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

// Watch the directory rather than the file: editors often save by renaming a
// new file over the old one, which would orphan a watch on the file itself.
func (s *Session) watch() error {
	w, err := fsnotify.NewWatcher()
	if err != nil {
		return err
	}
	if err := w.Add(filepath.Dir(s.file)); err != nil {
		_ = w.Close()
		return err
	}
	s.watcher = w
	s.watchDone = make(chan struct{})
	name := filepath.Base(s.file)
	go func() {
		defer close(s.watchDone)
		for {
			select {
			case ev, ok := <-w.Events:
				if !ok {
					return
				}
				if filepath.Base(ev.Name) == name {
					s.scheduleSyncFromDisk()
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

func (s *Session) scheduleSyncFromDisk() {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.stopped {
		return
	}
	if s.readTimer != nil {
		s.readTimer.Stop()
	}
	s.readTimer = time.AfterFunc(50*time.Millisecond, func() {
		s.syncing.Lock()
		defer s.syncing.Unlock()
		s.mu.Lock()
		stopped := s.stopped
		s.mu.Unlock()
		if !stopped {
			s.syncFromDisk()
		}
	})
}

// syncFromDisk merges the file's current content into the doc if it changed
// outside pedit, against what we last wrote. The caller must hold s.syncing.
func (s *Session) syncFromDisk() {
	changed := false
	// Told after Rebase, so not under the writer's lock.
	var notice *Notice
	// Rebase drops any pending write, which predates the merge.
	s.Writer.Rebase(func(lastWritten string) string {
		onDisk, ok := settle(s.bound.Read, 30*time.Millisecond, 10)
		if !ok {
			return lastWritten
		}
		if onDisk == lastWritten {
			// The file holds what pedit knows. A write skipped meanwhile
			// (the file was invalid, or changed and changed back) is saved
			// now; Flush skips it if nothing differs.
			if s.invalidOnDisk != "" {
				notice = &Notice{Kind: HoldReleased}
			}
			changed = true
			s.invalidOnDisk = ""
			return lastWritten
		}
		err := errNotUTF8
		if utf8.ValidString(onDisk) {
			s.Client.Do(func() { err = s.content.merge(lastWritten, onDisk) })
		}
		if err != nil {
			// Wait for it to be fixed: saving now would clobber whatever
			// someone is in the middle of writing.
			if onDisk != s.invalidOnDisk {
				s.invalidOnDisk = onDisk
				n := held(filepath.Base(s.file), err)
				notice = &n
			}
			return lastWritten
		}
		if s.invalidOnDisk != "" {
			notice = &Notice{Kind: HoldReleased}
		}
		s.invalidOnDisk = ""
		changed = true
		if s.attachments != nil {
			s.attachments.AllowLocalChanges(lastWritten, onDisk)
		}
		return onDisk
	})
	if notice != nil {
		s.notices.send(*notice)
	}
	if changed {
		// Remote edits made meanwhile are not on disk yet.
		s.Writer.Schedule(s.render())
	}
}

// errNotUTF8 means the file on disk is no longer UTF-8 text, such as after an
// editor saved it in another encoding. Taking it in would lose what pedit
// cannot read, and saving would then overwrite the file with that loss.
var errNotUTF8 = errors.New("it is not UTF-8 text")

// render returns the file as the doc has it now, under the client's lock so
// remote updates cannot change the doc while it is read.
func (s *Session) render() string {
	var out string
	s.Client.Do(func() { out = s.content.render() })
	return out
}

// maxRejectReason keeps a rejection within what a canvas message carries.
const maxRejectReason = 16 << 10

// handleCanvas applies JSON someone edited by hand in the browser, and tells
// the room whether it did.
func (s *Session) handleCanvas(m protocol.CanvasMessage) {
	c, ok := s.content.(*canvasContent)
	if !ok || m.Kind != protocol.CanvasEdit {
		return
	}
	var err error
	s.Client.Do(func() { err = c.edit(m.ID, m.Base, m.Next) })
	reply := protocol.CanvasMessage{Kind: protocol.CanvasApplied, ID: m.ID}
	if err != nil {
		reply = protocol.CanvasMessage{Kind: protocol.CanvasRejected, ID: m.ID, Reason: truncate(err.Error(), maxRejectReason)}
	}
	if err := s.Client.SendCanvas(reply); err != nil {
		s.onError(err)
	}
}

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

// Stop leaves the room and writes the final state to the file. It reports an
// error when the final state could not be saved.
func (s *Session) Stop() error {
	s.stopOnce.Do(func() {
		// Stop returns what goes wrong from here.
		s.notices.stop()
		s.mu.Lock()
		s.stopped = true
		if s.readTimer != nil {
			s.readTimer.Stop()
		}
		s.mu.Unlock()
		if s.watcher != nil {
			_ = s.watcher.Close()
			<-s.watchDone
		}
		// Waits for a sync already started by the timer; none can start after this.
		s.syncing.Lock()
		defer s.syncing.Unlock()

		// Merge a last-second external edit while peers can still get it, and
		// save right away: leaving can take a while, and a second Ctrl+C exits.
		s.syncFromDisk()
		s.Writer.Schedule(s.render())
		_ = s.Writer.Flush()

		if s.beforeDestroy != nil {
			s.beforeDestroy()
		}
		// A joined session saves no attachments.
		if s.attachments != nil {
			s.attachments.Close()
		}
		s.Client.Destroy()

		// Save again: edits may have arrived while leaving, and none can arrive now.
		for attempt := 1; ; attempt++ {
			if s.beforeFinalWrite != nil {
				s.beforeFinalWrite(attempt)
			}
			s.Writer.Schedule(s.render())
			s.stopErr = s.Writer.Flush()
			if !errors.Is(s.stopErr, filewriter.ErrExternalChange) || attempt == finalWriteAttempts {
				break
			}
			// Someone saved the file meanwhile: merge it in and try again.
			s.syncFromDisk()
		}
		s.stopAlive()
		s.awareness.Destroy()
		if s.bound != nil {
			s.stopErr = errors.Join(s.stopErr, s.bound.Close())
		}
		if s.temp != "" {
			// A temporary copy is for the session only: nothing to save.
			s.stopErr = errors.Join(s.stopErr, removeTemp(s.temp))
		}
	})
	return s.stopErr
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
