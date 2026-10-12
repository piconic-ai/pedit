package session

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"runtime"
	"slices"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/piconic-ai/pedit/internal/attach"
	"github.com/piconic-ai/pedit/internal/filewriter"
	"github.com/piconic-ai/pedit/internal/protocol"
	"github.com/piconic-ai/pedit/internal/protocol/prototest"
	"github.com/reearth/ygo/awareness"
	"github.com/reearth/ygo/crdt"
)

const wait = 3 * time.Second

func TestWatchedReplacementLinkNeverReachesGuest(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("symlink creation needs privileges on Windows")
	}
	const original = "public\n"
	const secret = "private outside the shared directory\n"
	f := setup(t, original, setupOpts{watch: true})
	g := joinAsGuest(t, f.relay, f.session.URL)
	prototest.WaitFor(t, wait, func() bool { return g.String() == original }, "initial document")
	victim := filepath.Join(t.TempDir(), "private.md")
	if err := os.WriteFile(victim, []byte(secret), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Remove(f.file); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(victim, f.file); err != nil {
		t.Fatal(err)
	}
	f.session.scheduleSyncFromDisk()
	time.Sleep(400 * time.Millisecond)
	if got := g.String(); got != original {
		t.Fatalf("guest received %q", got)
	}
	if err := f.session.Stop(); err == nil {
		t.Fatal("final save accepted replacement link")
	}
}

type fixture struct {
	puts     atomic.Int32
	file     string
	relay    *prototest.Relay
	server   *httptest.Server
	requests []string
	session  *Session
	// blobs are the room's encrypted images by URL path, served on GET.
	blobs sync.Map
}

type setupOpts struct {
	watch      bool
	writeDelay time.Duration
	// wrap wraps the host's connections.
	wrap func(protocol.Conn) protocol.Conn
	// name is the shared file's name; notes.md by default.
	name     string
	onNotice func(Notice)
	onError  func(error)
}

func setup(t *testing.T, content string, o setupOpts) *fixture {
	t.Helper()
	f := &fixture{relay: prototest.NewRelay(true)}
	if o.name == "" {
		o.name = "notes.md"
	}
	f.file = filepath.Join(t.TempDir(), o.name)
	if err := os.WriteFile(f.file, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
	var mu sync.Mutex
	f.server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodPut {
			f.puts.Add(1)
		}
		mu.Lock()
		f.requests = append(f.requests, r.Method+" "+r.URL.String())
		mu.Unlock()
		if blob, ok := f.blobs.Load(r.URL.Path); ok && r.Method == http.MethodGet {
			_, _ = w.Write(blob.([]byte))
			return
		}
		w.WriteHeader(http.StatusCreated)
		_ = json.NewEncoder(w).Encode(map[string]string{"id": "AAAAAAAAAAAAAAAAAAAAAA", "hostToken": "host-token"})
	}))
	t.Cleanup(f.server.Close)
	if o.writeDelay == 0 {
		o.writeDelay = 20 * time.Millisecond
	}
	s, err := Start(context.Background(), Options{
		File:       f.file,
		Server:     f.server.URL + "/",
		WriteDelay: o.writeDelay,
		Watch:      o.watch,
		OnNotice:   o.onNotice,
		OnError:    o.onError,
		Dial: func(ctx context.Context, url string, header http.Header) (protocol.Conn, error) {
			c, err := f.relay.Dial(ctx, url, header)
			if err == nil && o.wrap != nil {
				c = o.wrap(c)
			}
			return c, err
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = s.Stop() })
	f.session = s
	// Guests are turned away until the host is in the room.
	prototest.WaitFor(t, wait, func() bool { return s.Client.Status() == protocol.StatusConnected }, "host connected")
	return f
}

func TestUnrelatedLocalEditDoesNotAuthorizePeerImageReference(t *testing.T) {
	f := setup(t, "public\n", setupOpts{})
	image := []byte("\x89PNG\r\n\x1a\n private sibling")
	hash := protocol.ContentHash(image)
	dir := filepath.Join(filepath.Dir(f.file), attach.Dir)
	if err := os.Mkdir(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, hash+".png"), image, 0o600); err != nil {
		t.Fatal(err)
	}
	g := joinAsGuest(t, f.relay, f.session.URL)
	prototest.WaitFor(t, wait, func() bool { return g.String() == "public\n" }, "initial document")
	link := "![](assets/" + hash + ".png)\n"
	g.insert(0, link)
	prototest.WaitFor(t, wait, func() bool { return readFile(t, f.file) == link+"public\n" }, "peer reference saved")
	if err := os.WriteFile(f.file, []byte(link+"public\nlocal edit\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	f.session.syncing.Lock()
	f.session.syncFromDisk()
	f.session.syncing.Unlock()
	f.session.attachments.Handle(protocol.Attachment{Kind: protocol.AttachmentWant, Hashes: []string{hash}})
	time.Sleep(200 * time.Millisecond)
	if f.puts.Load() != 0 {
		t.Fatal("uploaded an unauthorized peer reference after a local edit")
	}
}

type guest struct {
	*protocol.Client
	doc  *crdt.Doc
	text *crdt.YText
	aw   *awareness.Awareness
}

func TestDeletingNeighborDoesNotAuthorizePeerImageReference(t *testing.T) {
	f := setup(t, "public\n", setupOpts{})
	image := []byte("\x89PNG\r\n\x1a\n private sibling")
	hash := protocol.ContentHash(image)
	dir := filepath.Join(filepath.Dir(f.file), attach.Dir)
	if err := os.Mkdir(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, hash+".png"), image, 0o600); err != nil {
		t.Fatal(err)
	}
	g := joinAsGuest(t, f.relay, f.session.URL)
	prototest.WaitFor(t, wait, func() bool { return g.String() == "public\n" }, "initial document")
	retained := "assets/" + hash + ".png\n"
	neighbor := "assets/" + protocol.ContentHash([]byte("dummy")) + ".png "
	g.insert(0, neighbor+retained)
	prototest.WaitFor(t, wait, func() bool { return readFile(t, f.file) == neighbor+retained+"public\n" }, "adjacent peer references saved")
	if err := os.WriteFile(f.file, []byte(retained+"public\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	f.session.syncing.Lock()
	f.session.syncFromDisk()
	f.session.syncing.Unlock()
	f.session.attachments.Handle(protocol.Attachment{Kind: protocol.AttachmentWant, Hashes: []string{hash}})
	time.Sleep(200 * time.Millisecond)
	if f.puts.Load() != 0 {
		t.Fatal("uploaded unchanged peer image after deleting its neighbor")
	}
}

func (g *guest) String() string { return g.text.ToString() }

func (g *guest) insert(index int, s string) {
	g.doc.Transact(func(txn *crdt.Transaction) { g.text.Insert(txn, index, s, nil) })
}

func joinAsGuest(t *testing.T, relay *prototest.Relay, shareURL string) *guest {
	t.Helper()
	return joinAsGuestHearing(t, relay, shareURL, nil)
}

// joinAsGuestHearing joins as a guest that is given the attachment messages
// from the room.
func joinAsGuestHearing(t *testing.T, relay *prototest.Relay, shareURL string, onAttachment func(protocol.Attachment)) *guest {
	t.Helper()
	u, err := url.Parse(shareURL)
	if err != nil {
		t.Fatal(err)
	}
	key, err := protocol.DecodeKey(u.Fragment)
	if err != nil {
		t.Fatal(err)
	}
	doc := crdt.New()
	aw := awareness.New(uint64(doc.ClientID()))
	aw.SetLocalState(map[string]any{}) // like a JavaScript Awareness starts
	c, err := protocol.NewClient(protocol.ClientOptions{
		URL: "ws://guest", Key: key, Doc: doc, Awareness: aw, Dial: relay.Dial, OnAttachment: onAttachment,
	})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(c.Destroy)
	c.Connect()
	return &guest{Client: c, doc: doc, text: doc.GetText("content"), aw: aw}
}

func readFile(t *testing.T, path string) string {
	t.Helper()
	b, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}

// noticeLog collects the notices a session tells.
type noticeLog struct {
	t    *testing.T
	mu   sync.Mutex
	list []Notice
}

func newNoticeLog(t *testing.T) *noticeLog { return &noticeLog{t: t} }

func (l *noticeLog) add(n Notice) {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.list = append(l.list, n)
}

func (l *noticeLog) all() []Notice {
	l.mu.Lock()
	defer l.mu.Unlock()
	return append([]Notice{}, l.list...)
}

// kinds lists the kinds told so far, in order.
func (l *noticeLog) kinds() []NoticeKind {
	var kinds []NoticeKind
	for _, n := range l.all() {
		kinds = append(kinds, n.Kind)
	}
	return kinds
}

// waitFor waits for a notice of kind, and returns the first.
func (l *noticeLog) waitFor(kind NoticeKind) Notice {
	l.t.Helper()
	var found Notice
	prototest.WaitFor(l.t, wait, func() bool {
		for _, n := range l.all() {
			if n.Kind == kind {
				found = n
				return true
			}
		}
		return false
	}, "a notice of "+string(kind))
	return found
}

// blockWithDirectory replaces the file with a directory, which pedit cannot
// save over. Removing the directory unblocks it.
func blockWithDirectory(t *testing.T, path string) {
	t.Helper()
	if err := os.Remove(path); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(path, 0o755); err != nil {
		t.Fatal(err)
	}
}

func TestShareURLKeyNeverReachesServer(t *testing.T) {
	f := setup(t, "# hi", setupOpts{})
	u, _ := url.Parse(f.session.URL)
	if origin := u.Scheme + "://" + u.Host; origin != f.server.URL {
		t.Fatalf("origin = %q", origin)
	}
	if u.Path != "/r/AAAAAAAAAAAAAAAAAAAAAA" {
		t.Fatalf("path = %q", u.Path)
	}
	key := u.Fragment
	if len(key) != 43 {
		t.Fatalf("key = %q", key)
	}
	if len(f.requests) != 1 || f.requests[0] != "POST /api/rooms" {
		t.Fatalf("requests = %v", f.requests)
	}
	prototest.WaitFor(t, wait, func() bool { return len(f.relay.URLs()) == 1 }, "dial")
	wsURL := "ws" + strings.TrimPrefix(f.server.URL, "http") + "/api/rooms/AAAAAAAAAAAAAAAAAAAAAA/ws"
	if got := f.relay.URLs()[0]; got != wsURL {
		t.Fatalf("ws url = %q", got)
	}
	header := f.relay.Headers()[0]
	if got := header.Get("Authorization"); got != "Bearer host-token" {
		t.Fatalf("Authorization = %q", got)
	}
	for _, s := range append(append(f.requests, f.relay.URLs()...), header.Get("Authorization")) {
		if strings.Contains(s, key) {
			t.Fatalf("key leaked in %q", s)
		}
	}
}

func TestExplainsWhyRoomCannotBeCreated(t *testing.T) {
	tests := []struct {
		name   string
		status int
		body   string
		want   string
	}{
		{"server error", http.StatusServiceUnavailable, "nope", "503 Service Unavailable: nope"},
		{"rate limited", http.StatusTooManyRequests, "Too many rooms were created from your network.\nTry again in a minute.\n", "429 Too Many Requests: Too many rooms were created from your network. Try again in a minute."},
		// Sent as text/plain, though not sniffed as text.
		{"control characters", http.StatusForbidden, "no\x1b[31m way\x07", "403 Forbidden: no [31m way"},
		{"HTML", http.StatusBadGateway, "<!doctype html><title>Bad gateway</title>", "502 Bad Gateway"},
		{"not JSON", http.StatusOK, "<html>", "did not answer like a pedit server (check server in .pedit/config.yaml)"},
		{"no room id", http.StatusCreated, `{"hostToken":"t"}`, "did not answer like a pedit server"},
		{"no host token", http.StatusCreated, `{"id":"AAAAAAAAAAAAAAAAAAAAAA"}`, "did not return a host token; the server is older than this pedit"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			file := filepath.Join(t.TempDir(), "notes.md")
			_ = os.WriteFile(file, []byte("x"), 0o644)
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
				if tt.name == "control characters" {
					w.Header().Set("Content-Type", "text/plain; charset=utf-8")
				}
				w.WriteHeader(tt.status)
				_, _ = w.Write([]byte(tt.body))
			}))
			defer server.Close()
			_, err := Start(context.Background(), Options{File: file, Server: server.URL})
			if err == nil || !strings.Contains(err.Error(), tt.want) || !strings.Contains(err.Error(), server.URL) {
				t.Fatalf("err = %v", err)
			}
			// Only plain text is shown, never markup or terminal escapes.
			if strings.ContainsAny(err.Error(), "<\x1b\x07") {
				t.Fatalf("err = %q", err)
			}
		})
	}
}

func TestSendsHeaderToServer(t *testing.T) {
	relay := prototest.NewRelay(true)
	var got http.Header
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		got = r.Header.Clone()
		w.WriteHeader(http.StatusCreated)
		_ = json.NewEncoder(w).Encode(map[string]string{"id": "AAAAAAAAAAAAAAAAAAAAAA", "hostToken": "host-token"})
	}))
	defer server.Close()
	file := filepath.Join(t.TempDir(), "notes.md")
	_ = os.WriteFile(file, []byte("x"), 0o644)
	header := http.Header{"Cf-Access-Token": {"user-token"}}
	s, err := Start(context.Background(), Options{File: file, Server: server.URL, Header: header, Dial: relay.Dial})
	if err != nil {
		t.Fatal(err)
	}
	defer s.Stop()
	if v := got.Get("Cf-Access-Token"); v != "user-token" {
		t.Fatalf("room request Cf-Access-Token = %q", v)
	}
	prototest.WaitFor(t, wait, func() bool { return len(relay.Headers()) == 1 }, "dial")
	ws := relay.Headers()[0]
	if v := ws.Get("Cf-Access-Token"); v != "user-token" {
		t.Fatalf("WebSocket Cf-Access-Token = %q", v)
	}
	if v := ws.Get("Authorization"); v != "Bearer host-token" {
		t.Fatalf("WebSocket Authorization = %q", v)
	}
	if header.Get("Authorization") != "" {
		t.Fatal("the caller's header was modified")
	}
}

func TestExplainsCloudflareAccess(t *testing.T) {
	tests := []struct {
		name   string
		header http.Header
		want   string
	}{
		{"no credentials", nil, "Cloudflare Access sent us to its login page"},
		{"rejected user token", http.Header{"Cf-Access-Token": {"expired"}}, "Cloudflare Access sent us to its login page"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			// Access redirects to its login page instead of letting the request through.
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if strings.HasPrefix(r.URL.Path, "/cdn-cgi/access/") {
					_, _ = w.Write([]byte("<html>Sign in</html>"))
					return
				}
				http.Redirect(w, r, "/cdn-cgi/access/login/edit-lab.example", http.StatusFound)
			}))
			defer server.Close()
			file := filepath.Join(t.TempDir(), "notes.md")
			_ = os.WriteFile(file, []byte("x"), 0o644)
			_, err := Start(context.Background(), Options{File: file, Server: server.URL, Header: tt.header})
			if err == nil || !strings.Contains(err.Error(), tt.want) || !strings.Contains(err.Error(), server.URL) {
				t.Fatalf("err = %v", err)
			}
			if !errors.Is(err, ErrBehindAccess) {
				t.Fatalf("err = %v, want ErrBehindAccess", err)
			}
		})
	}
}

func TestCreateRoomDoesNotForwardAccessTokenOnRedirect(t *testing.T) {
	for _, status := range []int{http.StatusFound, http.StatusTemporaryRedirect, http.StatusPermanentRedirect} {
		t.Run(fmt.Sprint(status), func(t *testing.T) {
			var hits atomic.Int32
			destination := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				hits.Add(1)
				if r.Header.Get("Cf-Access-Token") != "" {
					t.Error("destination received Access token")
				}
			}))
			defer destination.Close()
			target := strings.Replace(destination.URL, "127.0.0.1", "localhost", 1)
			origin := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.Header.Get("Cf-Access-Token") != "synthetic-token" {
					t.Error("origin missing Access token")
				}
				http.Redirect(w, r, target+"/capture", status)
			}))
			defer origin.Close()
			client := origin.Client()
			if _, err := createRoom(context.Background(), client, origin.URL, http.Header{"Cf-Access-Token": {"synthetic-token"}}); err == nil {
				t.Fatal("accepted redirect as a room")
			}
			if hits.Load() != 0 {
				t.Fatal("followed redirect")
			}
			if client.CheckRedirect != nil {
				t.Fatal("changed the shared HTTP client")
			}
		})
	}
}

func TestServesFileAndWritesBackGuestEdits(t *testing.T) {
	f := setup(t, "# notes\n", setupOpts{})
	g := joinAsGuest(t, f.relay, f.session.URL)
	prototest.WaitFor(t, wait, func() bool { return g.String() == "# notes\n" }, "guest to sync")
	g.insert(len("# notes\n"), "- from guest\n")
	prototest.WaitFor(t, wait, func() bool { return readFile(t, f.file) == "# notes\n- from guest\n" }, "write back")
}

func TestWritesFinalStateOnStop(t *testing.T) {
	f := setup(t, "a", setupOpts{writeDelay: time.Minute})
	g := joinAsGuest(t, f.relay, f.session.URL)
	prototest.WaitFor(t, wait, func() bool { return g.String() == "a" }, "guest to sync")
	g.insert(1, "b")
	prototest.WaitFor(t, wait, func() bool { return f.session.Text.ToString() == "ab" }, "host to see the edit")
	if err := f.session.Stop(); err != nil {
		t.Fatal(err)
	}
	if got := readFile(t, f.file); got != "ab" {
		t.Fatalf("content = %q", got)
	}
}

func TestShowsHostAvatar(t *testing.T) {
	relay := prototest.NewRelay(true)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusCreated)
		_ = json.NewEncoder(w).Encode(map[string]string{"id": "AAAAAAAAAAAAAAAAAAAAAA", "hostToken": "host-token"})
	}))
	defer server.Close()
	file := filepath.Join(t.TempDir(), "notes.md")
	_ = os.WriteFile(file, []byte("x"), 0o644)
	s, err := Start(context.Background(), Options{
		File: file, Server: server.URL, Name: "kfly8", Avatar: "https://gravatar.com/avatar/x", Dial: relay.Dial,
	})
	if err != nil {
		t.Fatal(err)
	}
	defer s.Stop()
	// Guests are turned away until the host is in the room.
	prototest.WaitFor(t, wait, func() bool { return s.Client.Status() == protocol.StatusConnected }, "host connected")
	g := joinAsGuest(t, relay, s.URL)
	prototest.WaitFor(t, wait, func() bool {
		for _, st := range g.aw.GetStates() {
			user, _ := st.State["user"].(map[string]any)
			if st.State["role"] == "host" && user["name"] == "kfly8" && user["avatar"] == "https://gravatar.com/avatar/x" {
				return true
			}
		}
		return false
	}, "host avatar")
}

func TestDisplayName(t *testing.T) {
	tests := []struct {
		state map[string]any
		want  string
	}{
		{map[string]any{"user": map[string]any{"name": " Alice "}}, "Alice"},
		{map[string]any{"name": "kfly8"}, "kfly8"},
		{map[string]any{"user": map[string]any{"name": ""}, "name": "bob"}, "bob"},
		{map[string]any{"user": "x"}, "Someone"},
		// Names reach the host's terminal: no escapes, cursor moves or bidi tricks.
		{map[string]any{"user": map[string]any{"name": "\x1b[2J\x1b]0;pwned\x07Eve"}}, "[2J]0;pwnedEve"},
		{map[string]any{"user": map[string]any{"name": "Eve\r\nMallory"}}, "EveMallory"},
		{map[string]any{"user": map[string]any{"name": "\u202eevE"}}, "evE"},
		{map[string]any{"user": map[string]any{"name": "\x1b\x07"}, "name": "bob"}, "bob"},
		{map[string]any{"user": map[string]any{"name": strings.Repeat("あ", 50)}}, strings.Repeat("あ", 40) + "…"},
		{map[string]any{}, "Someone"},
	}
	for _, tt := range tests {
		if got := displayName(tt.state); got != tt.want {
			t.Errorf("displayName(%v) = %q, want %q", tt.state, got, tt.want)
		}
	}
}

func TestAnnouncesItselfAsHost(t *testing.T) {
	f := setup(t, "", setupOpts{})
	g := joinAsGuest(t, f.relay, f.session.URL)
	prototest.WaitFor(t, wait, func() bool {
		for _, s := range g.aw.GetStates() {
			if s.State["role"] == "host" && s.State["file"] == "notes.md" {
				return true
			}
		}
		return false
	}, "host awareness")
}

func TestAdvertisesAttachments(t *testing.T) {
	f := setup(t, "", setupOpts{})
	g := joinAsGuest(t, f.relay, f.session.URL)
	prototest.WaitFor(t, wait, func() bool {
		for _, s := range g.aw.GetStates() {
			a, _ := s.State["attachments"].(map[string]any)
			if s.State["role"] == "host" && a["dir"] == "assets" && a["maxBytes"] == float64(10<<20) {
				return true
			}
		}
		return false
	}, "attachments in host awareness")
}

func TestStreamsExternalEditsToGuests(t *testing.T) {
	f := setup(t, "# notes\n", setupOpts{watch: true})
	g := joinAsGuest(t, f.relay, f.session.URL)
	prototest.WaitFor(t, wait, func() bool { return g.String() == "# notes\n" }, "guest to sync")
	if err := os.WriteFile(f.file, []byte("# notes\n- edited in vim\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	prototest.WaitFor(t, wait, func() bool { return g.String() == "# notes\n- edited in vim\n" }, "external edit")
}

func TestMergesExternalEditWithConcurrentRemoteEdit(t *testing.T) {
	f := setup(t, "one\ntwo\n", setupOpts{watch: true, writeDelay: time.Second})
	g := joinAsGuest(t, f.relay, f.session.URL)
	prototest.WaitFor(t, wait, func() bool { return g.String() == "one\ntwo\n" }, "guest to sync")
	// The guest edits, and before it is written back the host edits the file.
	g.insert(0, "zero\n")
	prototest.WaitFor(t, wait, func() bool { return strings.Contains(f.session.Text.ToString(), "zero") }, "host to see the edit")
	if err := os.WriteFile(f.file, []byte("one\ntwo\nthree\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	const merged = "zero\none\ntwo\nthree\n"
	prototest.WaitFor(t, wait, func() bool { return g.String() == merged }, "merged doc")
	prototest.WaitFor(t, wait, func() bool { return readFile(t, f.file) == merged }, "merged file")
	g.Destroy()
	if err := f.session.Stop(); err != nil {
		t.Fatal(err)
	}
	if got := readFile(t, f.file); got != merged {
		t.Fatalf("content = %q", got)
	}
}

func TestNoLoopBetweenWriteBackAndWatch(t *testing.T) {
	f := setup(t, "a", setupOpts{watch: true})
	g := joinAsGuest(t, f.relay, f.session.URL)
	prototest.WaitFor(t, wait, func() bool { return g.String() == "a" }, "guest to sync")
	var mu sync.Mutex
	var origins []any
	f.session.Doc.OnUpdate(func(_ []byte, origin any) { mu.Lock(); origins = append(origins, origin); mu.Unlock() })
	g.insert(1, "b")
	prototest.WaitFor(t, wait, func() bool { return f.session.Writer.LastWritten() == "ab" }, "write back")
	time.Sleep(300 * time.Millisecond)
	mu.Lock()
	defer mu.Unlock()
	if len(origins) != 1 {
		t.Fatalf("updates = %v", origins)
	}
}

func TestClosesRoomForGuestsOnStop(t *testing.T) {
	f := setup(t, "bye", setupOpts{})
	g := joinAsGuest(t, f.relay, f.session.URL)
	prototest.WaitFor(t, wait, func() bool { return g.String() == "bye" }, "guest to sync")
	if err := f.session.Stop(); err != nil {
		t.Fatal(err)
	}
	prototest.WaitFor(t, wait, func() bool { return g.Status() == protocol.StatusClosed }, "guest closed")
}

// sjis is 議事録 in Shift_JIS, which is not UTF-8.
const sjis = "\x8b\x63\x8e\x96\x98\x5e\n"

func TestRefusesFileThatIsNotUTF8BeforeARoomIsMade(t *testing.T) {
	file := filepath.Join(t.TempDir(), "memo.txt")
	if err := os.WriteFile(file, []byte(sjis), 0o644); err != nil {
		t.Fatal(err)
	}
	var requests atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) { requests.Add(1) }))
	t.Cleanup(server.Close)
	if _, err := Start(context.Background(), Options{File: file, Server: server.URL}); err == nil || !strings.Contains(err.Error(), "is not UTF-8 text") {
		t.Fatalf("Start = %v", err)
	}
	if n := requests.Load(); n != 0 {
		t.Errorf("%d requests reached the server", n)
	}
	if got := readFile(t, file); got != sjis {
		t.Fatalf("file changed: %q", got)
	}
}

func TestKeepsAFileThatStopsBeingUTF8(t *testing.T) {
	n := newNoticeLog(t)
	f := setup(t, "notes\n", setupOpts{watch: true, onNotice: n.add})
	g := joinAsGuest(t, f.relay, f.session.URL)
	prototest.WaitFor(t, wait, func() bool { return g.String() == "notes\n" }, "guest to sync")

	// An editor saves the file in another encoding, then someone edits.
	if err := os.WriteFile(f.file, []byte(sjis), 0o644); err != nil {
		t.Fatal(err)
	}
	told := n.waitFor(ChangeHeld)
	g.insert(0, "guest: ")
	time.Sleep(300 * time.Millisecond)
	if got := readFile(t, f.file); got != sjis {
		t.Fatalf("saved over a file that is not UTF-8: %q", got)
	}
	if got := g.String(); got != "guest: notes\n" {
		t.Fatalf("guest got %q", got)
	}
	// Told once, though pedit looked at the file again when it skipped the save.
	if told.File != f.file || told.Reason != "it is not UTF-8 text" || told.Details != nil || told.Err == nil || len(n.all()) != 1 {
		t.Errorf("notices = %+v", n.all())
	}

	// Back to UTF-8: the guest's edit is saved on top of it.
	if err := os.WriteFile(f.file, []byte("notes\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	prototest.WaitFor(t, wait, func() bool { return readFile(t, f.file) == "guest: notes\n" }, "the guest's edit to be saved")
	n.waitFor(HoldReleased)
	if got := n.kinds(); !slices.Equal(got, []NoticeKind{ChangeHeld, HoldReleased}) {
		t.Errorf("kinds = %v", got)
	}
}

// A file that holds what pedit wrote is the echo of its own write, not a
// change that was fixed.
func TestTellsNothingWhenTheFileHoldsWhatPeditWrote(t *testing.T) {
	n := newNoticeLog(t)
	f := setup(t, "a", setupOpts{writeDelay: time.Minute, onNotice: n.add})
	f.session.syncing.Lock()
	f.session.syncFromDisk()
	f.session.syncing.Unlock()
	if got := n.all(); len(got) != 0 {
		t.Fatalf("notices = %+v", got)
	}
}

func TestTellsWhenSavingFailsAndWorksAgain(t *testing.T) {
	n := newNoticeLog(t)
	// Saves are tried again every 50ms.
	f := setup(t, "one\n", setupOpts{writeDelay: 10 * time.Millisecond, onNotice: n.add})
	g := joinAsGuest(t, f.relay, f.session.URL)
	prototest.WaitFor(t, wait, func() bool { return g.String() == "one\n" }, "guest to sync")

	blockWithDirectory(t, f.file)
	g.insert(0, "zero\n")
	// The first failure may fix itself: only the second is told.
	failed := n.waitFor(SaveFailed)
	if failed.File != f.file || failed.Reason != "it is no longer a regular file" || failed.Err == nil {
		t.Fatalf("notice = %+v", failed)
	}
	// Failing again for the same reason is not told again.
	time.Sleep(250 * time.Millisecond)
	if got := n.kinds(); !slices.Equal(got, []NoticeKind{SaveFailed}) {
		t.Fatalf("kinds = %v", got)
	}

	// Without a new edit, the next try saves.
	if err := os.Remove(f.file); err != nil {
		t.Fatal(err)
	}
	recovered := n.waitFor(SaveRecovered)
	if recovered.File != f.file {
		t.Errorf("notice = %+v", recovered)
	}
	if got := readFile(t, f.file); got != "zero\none\n" {
		t.Fatalf("file = %q", got)
	}
	if got := n.kinds(); !slices.Equal(got, []NoticeKind{SaveFailed, SaveRecovered}) {
		t.Fatalf("kinds = %v", got)
	}
}

// Stop returns what goes wrong while it saves, so nothing is told besides.
func TestStopTellsNothing(t *testing.T) {
	n := newNoticeLog(t)
	var mu sync.Mutex
	var debugged []error
	f := setup(t, "one\n", setupOpts{writeDelay: time.Minute, onNotice: n.add, onError: func(err error) {
		mu.Lock()
		defer mu.Unlock()
		debugged = append(debugged, err)
	}})
	g := joinAsGuest(t, f.relay, f.session.URL)
	prototest.WaitFor(t, wait, func() bool { return g.String() == "one\n" }, "guest to sync")
	g.insert(0, "zero\n")
	prototest.WaitFor(t, wait, func() bool { return f.session.Text.ToString() == "zero\none\n" }, "host to see the edit")

	blockWithDirectory(t, f.file)
	// Stop saves twice, and both fail: told as one, that would be a notice.
	err := f.session.Stop()
	if !errors.Is(err, filewriter.ErrNotRegular) {
		t.Fatalf("Stop = %v", err)
	}
	if got := n.all(); len(got) != 0 {
		t.Fatalf("notices = %+v", got)
	}
	mu.Lock()
	defer mu.Unlock()
	if len(debugged) != 2 {
		t.Fatalf("debugged = %v", debugged)
	}
}

func TestTellsWhenAnImageCannotBeSaved(t *testing.T) {
	n := newNoticeLog(t)
	f := setup(t, "x\n", setupOpts{onNotice: n.add})
	replies := make(chan protocol.Attachment, 16)
	g := joinAsGuestHearing(t, f.relay, f.session.URL, func(m protocol.Attachment) { replies <- m })
	prototest.WaitFor(t, wait, func() bool { return g.String() == "x\n" }, "guest to sync")

	u, _ := url.Parse(f.session.URL)
	raw, err := protocol.DecodeKey(u.Fragment)
	if err != nil {
		t.Fatal(err)
	}
	keys, err := protocol.DeriveBlobKeys(raw)
	if err != nil {
		t.Fatal(err)
	}
	// paste has the guest upload an image and announce it, and returns how the
	// host answered.
	paste := func(name string) protocol.Attachment {
		t.Helper()
		image := []byte("\x89PNG\r\n\x1a\n " + name)
		hash := protocol.ContentHash(image)
		id, err := keys.BlobID(hash)
		if err != nil {
			t.Fatal(err)
		}
		f.blobs.Store("/api/rooms/AAAAAAAAAAAAAAAAAAAAAA/blobs/"+id, keys.Encrypt(image))
		if err := g.SendAttachment(protocol.Attachment{Kind: protocol.AttachmentAnnounce, Hash: hash, Mime: "image/png"}); err != nil {
			t.Fatal(err)
		}
		select {
		case m := <-replies:
			if m.Hash != hash {
				t.Fatalf("reply to another image: %+v", m)
			}
			return m
		case <-time.After(wait):
			t.Fatal("the host did not answer")
			return protocol.Attachment{}
		}
	}

	assets := filepath.Join(filepath.Dir(f.file), attach.Dir)
	if err := os.WriteFile(assets, nil, 0o644); err != nil {
		t.Fatal(err)
	}
	if m := paste("one"); m.Kind != protocol.AttachmentRejected || m.Reason != attach.ReasonUnavailable {
		t.Fatalf("reply = %+v", m)
	}
	told := n.waitFor(ImageNotSaved)
	// The reason is cut down from the save error: it does not name the
	// directory, which the error does.
	if told.File != f.file || told.Reason == "" || strings.Contains(told.Reason, attach.Dir) || told.Err == nil {
		t.Fatalf("notice = %+v", told)
	}
	// The same cause again is not told again.
	paste("two")
	if got := n.kinds(); !slices.Equal(got, []NoticeKind{ImageNotSaved}) {
		t.Fatalf("kinds = %v", got)
	}

	// Once an image is saved, the next failure is told again.
	if err := os.Remove(assets); err != nil {
		t.Fatal(err)
	}
	if m := paste("three"); m.Kind != protocol.AttachmentStored {
		t.Fatalf("reply = %+v", m)
	}
	if err := os.RemoveAll(assets); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(assets, nil, 0o644); err != nil {
		t.Fatal(err)
	}
	paste("four")
	if got := n.kinds(); !slices.Equal(got, []NoticeKind{ImageNotSaved, ImageNotSaved}) {
		t.Fatalf("kinds = %v", got)
	}
}

// A save pedit moved aside and could not put back may be the user's: they are
// told where it is.
func TestTellsWhereASaveItCouldNotPutBackIsKept(t *testing.T) {
	needsExchange(t)
	n := newNoticeLog(t)
	f := setup(t, "one\n", setupOpts{onNotice: n.add})
	g := joinAsGuest(t, f.relay, f.session.URL)
	prototest.WaitFor(t, wait, func() bool { return g.String() == "one\n" }, "guest to sync")

	// A save lands at each point of the first writes, until the fifth.
	var saves atomic.Int32
	f.session.bound.SetTestHook(func(s filewriter.Step) {
		if (s != filewriter.StepBeforeReplace && s != filewriter.StepExchanged) || saves.Load() >= 5 {
			return
		}
		if err := saveAs(f.file, fmt.Sprintf("one\nsave %d\n", saves.Add(1)), true); err != nil {
			t.Error(err)
		}
	})
	g.insert(0, "zero\n")

	kept := n.waitFor(SaveKept)
	if got := n.all(); len(got) != 1 || kept.File != f.file || !strings.HasPrefix(kept.Kept, ".pedit-") || kept.Err == nil {
		t.Fatalf("notices = %+v", got)
	}
	if got := readFile(t, filepath.Join(filepath.Dir(f.file), kept.Kept)); got != "one\nsave 4\n" {
		t.Fatalf("kept file = %q", got)
	}
	// The newest save is merged and saved, which tells nothing more.
	prototest.WaitFor(t, wait, func() bool { return readFile(t, f.file) == "zero\none\nsave 5\n" }, "the newest save, merged")
	if got := n.all(); len(got) != 1 {
		t.Fatalf("notices = %+v", got)
	}
}

func TestStopReportsFailedFinalWrite(t *testing.T) {
	f := setup(t, "a", setupOpts{writeDelay: time.Minute})
	g := joinAsGuest(t, f.relay, f.session.URL)
	prototest.WaitFor(t, wait, func() bool { return g.String() == "a" }, "guest to sync")
	g.insert(1, "b")
	prototest.WaitFor(t, wait, func() bool { return f.session.Text.ToString() == "ab" }, "host to see the edit")
	// The atomic write needs a temp file next to the target.
	dir := filepath.Dir(f.file)
	if err := os.Chmod(dir, 0o555); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.Chmod(dir, 0o755) })
	if err := f.session.Stop(); err == nil {
		t.Fatal("Stop should report the failed write")
	}
}

func TestSettle(t *testing.T) {
	t.Run("returns once two reads agree", func(t *testing.T) {
		reads := []string{"half", "full", "full"}
		got, ok := settle(func() (string, bool) {
			r := reads[0]
			reads = reads[1:]
			return r, true
		}, 0, 10)
		if !ok || got != "full" {
			t.Fatalf("settle = %q, %v", got, ok)
		}
	})
	t.Run("gives up on content that keeps changing", func(t *testing.T) {
		n := 0
		got, ok := settle(func() (string, bool) {
			n++
			return fmt.Sprint(n), true
		}, 0, 10)
		if ok || n != 10 {
			t.Fatalf("settle = %q, %v after %d reads", got, ok, n)
		}
	})
}

func TestStopRetriesWhenFileChangesWhileSaving(t *testing.T) {
	f := setup(t, "one\n", setupOpts{writeDelay: time.Minute})
	attempts := 0
	f.session.beforeFinalWrite = func(attempt int) {
		attempts = attempt
		if attempt == 1 {
			// An edit that arrived while leaving, and someone saving the file.
			f.session.Doc.Transact(func(txn *crdt.Transaction) { f.session.Text.Insert(txn, 0, "zero\n", nil) })
			if err := os.WriteFile(f.file, []byte("one\ntwo\n"), 0o644); err != nil {
				t.Fatal(err)
			}
		}
	}
	if err := f.session.Stop(); err != nil {
		t.Fatal(err)
	}
	if got := readFile(t, f.file); got != "zero\none\ntwo\n" || attempts != 2 {
		t.Fatalf("content = %q after %d attempts", got, attempts)
	}
}

// blockingConn runs hook before its first write once armed.
type blockingConn struct {
	protocol.Conn
	armed atomic.Bool
	hook  func()
}

func (c *blockingConn) Write(ctx context.Context, data []byte) error {
	if c.armed.CompareAndSwap(true, false) {
		c.hook()
	}
	return c.Conn.Write(ctx, data)
}

func TestStopSavesEditsArrivingWhileLeaving(t *testing.T) {
	var conn *blockingConn
	f := setup(t, "a", setupOpts{writeDelay: time.Minute, wrap: func(c protocol.Conn) protocol.Conn {
		conn = &blockingConn{Conn: c}
		return conn
	}})
	g := joinAsGuest(t, f.relay, f.session.URL)
	prototest.WaitFor(t, wait, func() bool { return g.String() == "a" }, "guest to sync")
	// Destroy sends our departure; hold it until a guest edit has come in. The
	// hook runs on the outbox goroutine, so it must not fail the test itself.
	arrived := false
	conn.hook = func() {
		g.insert(1, " late")
		deadline := time.Now().Add(wait)
		for !arrived && time.Now().Before(deadline) {
			arrived = f.session.Text.ToString() == "a late"
			time.Sleep(5 * time.Millisecond)
		}
	}
	f.session.beforeDestroy = func() { conn.armed.Store(true) }
	if err := f.session.Stop(); err != nil {
		t.Fatal(err)
	}
	if !arrived {
		t.Fatal("the late edit never reached the host")
	}
	if got := readFile(t, f.file); got != "a late" {
		t.Fatalf("content = %q", got)
	}
}

func TestSyncsFromDiskDoNotOverlapOrOutliveStop(t *testing.T) {
	f := setup(t, "one\n", setupOpts{})
	s := f.session
	// Stand in for a sync in flight. Registered after setup, so it runs before
	// cleanup's Stop even when an assertion fails with the lock held.
	unlock := holdLock(t, &s.syncing)
	if err := os.WriteFile(f.file, []byte("one\ntwo\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	s.scheduleSyncFromDisk()
	time.Sleep(200 * time.Millisecond) // the timer fires
	if got := s.Text.ToString(); got != "one\n" {
		t.Fatalf("a sync ran while another was in flight: %q", got)
	}
	// Stop begins while the timer's sync waits; that sync must then do nothing.
	s.mu.Lock()
	s.stopped = true
	s.mu.Unlock()
	unlock()
	time.Sleep(200 * time.Millisecond)
	if got := s.Text.ToString(); got != "one\n" {
		t.Fatalf("a sync ran after Stop began: %q", got)
	}
}

func TestStopWaitsForSyncInFlight(t *testing.T) {
	f := setup(t, "one\n", setupOpts{})
	s := f.session
	unlock := holdLock(t, &s.syncing)
	if err := os.WriteFile(f.file, []byte("one\ntwo\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	done := make(chan error, 1)
	go func() { done <- s.Stop() }()
	select {
	case <-done:
		t.Fatal("Stop returned while a sync was in flight")
	case <-time.After(200 * time.Millisecond):
	}
	unlock()
	if err := <-done; err != nil {
		t.Fatal(err)
	}
	if got := readFile(t, f.file); got != "one\ntwo\n" {
		t.Fatalf("content = %q", got)
	}
}

// holdLock locks mu and returns an idempotent unlock, which also runs on cleanup.
func holdLock(t *testing.T, mu *sync.Mutex) func() {
	mu.Lock()
	var once sync.Once
	unlock := func() { once.Do(mu.Unlock) }
	t.Cleanup(unlock)
	return unlock
}
