// Package interop checks the Go host against the web client's JavaScript RoomClient.
package interop

import (
	"bufio"
	"context"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/piconic-ai/pedit/internal/meta"
	"github.com/piconic-ai/pedit/internal/protocol"
	"github.com/piconic-ai/pedit/internal/protocol/prototest"
	"github.com/piconic-ai/pedit/internal/session"
	"github.com/reearth/ygo/awareness"
	"github.com/reearth/ygo/crdt"
)

const roomID = "AAAAAAAAAAAAAAAAAAAAAA"

// newServer stands in for the Worker: it creates rooms, relays frames between
// sockets and keeps blobs.
func newServer(t *testing.T) *httptest.Server {
	var mu sync.Mutex
	conns := map[*websocket.Conn]bool{}
	blobs := map[string][]byte{}
	admission := ""
	checkAdmission := func(r *http.Request) bool {
		mu.Lock()
		defer mu.Unlock()
		return admission != "" && r.Header.Get(protocol.AdmissionHeader) == admission
	}
	mux := http.NewServeMux()
	mux.HandleFunc("PUT /api/rooms/{id}/blobs/{blob}", func(w http.ResponseWriter, r *http.Request) {
		if !checkAdmission(r) {
			w.WriteHeader(http.StatusForbidden)
			return
		}
		body, err := io.ReadAll(r.Body)
		if err != nil {
			w.WriteHeader(http.StatusBadRequest)
			return
		}
		mu.Lock()
		defer mu.Unlock()
		if _, ok := blobs[r.URL.Path]; ok {
			return
		}
		blobs[r.URL.Path] = body
		w.WriteHeader(http.StatusCreated)
	})
	mux.HandleFunc("GET /api/rooms/{id}/blobs/{blob}", func(w http.ResponseWriter, r *http.Request) {
		if !checkAdmission(r) {
			w.WriteHeader(http.StatusForbidden)
			return
		}
		mu.Lock()
		body, ok := blobs[r.URL.Path]
		mu.Unlock()
		if !ok {
			w.WriteHeader(http.StatusNotFound)
			return
		}
		_, _ = w.Write(body)
	})
	mux.HandleFunc("POST /api/rooms", func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusCreated)
		_ = json.NewEncoder(w).Encode(map[string]string{"id": roomID, "hostToken": "host-token"})
	})
	mux.HandleFunc("GET /api/rooms/{id}/ws", func(w http.ResponseWriter, r *http.Request) {
		token := ""
		for _, p := range strings.Split(r.Header.Get("Sec-WebSocket-Protocol"), ",") {
			if v, ok := strings.CutPrefix(strings.TrimSpace(p), protocol.AdmissionProtocolPrefix); ok {
				token = v
			}
		}
		mu.Lock()
		if admission == "" && r.Header.Get("Authorization") == "Bearer host-token" && len(token) == 43 {
			admission = token
		}
		allowed := admission != "" && admission == token
		mu.Unlock()
		if !allowed {
			w.WriteHeader(http.StatusForbidden)
			return
		}
		c, err := websocket.Accept(w, r, &websocket.AcceptOptions{Subprotocols: []string{protocol.SocketProtocol}})
		if err != nil {
			return
		}
		c.SetReadLimit(-1)
		mu.Lock()
		conns[c] = true
		mu.Unlock()
		defer func() {
			mu.Lock()
			delete(conns, c)
			mu.Unlock()
		}()
		for {
			typ, data, err := c.Read(context.Background())
			if err != nil {
				return
			}
			mu.Lock()
			for peer := range conns {
				if peer != c {
					_ = peer.Write(context.Background(), typ, data)
				}
			}
			mu.Unlock()
		}
	})
	s := httptest.NewServer(mux)
	t.Cleanup(s.Close)
	return s
}

// protocolDir returns packages/protocol, or skips the test when its
// dependencies or Node.js are missing (unless PEDIT_INTEROP requires it).
func protocolDir(t *testing.T) string {
	dir, err := filepath.Abs("../../packages/protocol")
	if err != nil {
		t.Fatal(err)
	}
	_, nodeErr := exec.LookPath("node")
	_, depsErr := os.Stat(filepath.Join(dir, "node_modules", "yjs"))
	if nodeErr != nil || depsErr != nil {
		if os.Getenv("PEDIT_INTEROP") != "" {
			t.Fatalf("node or packages/protocol dependencies missing (run pnpm install)")
		}
		t.Skip("needs node and pnpm install")
	}
	return dir
}

func TestGoHostWithJavaScriptGuest(t *testing.T) {
	dir := protocolDir(t)
	server := newServer(t)
	file := filepath.Join(t.TempDir(), "notes.md")
	if err := os.WriteFile(file, []byte("こんにちは🌏 world\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	s, err := session.Start(context.Background(), session.Options{
		File:       file,
		Server:     server.URL,
		WriteDelay: 20 * time.Millisecond,
		Watch:      true,
	})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = s.Stop() })
	prototest.WaitFor(t, 5*time.Second, func() bool { return s.Client.Status() == protocol.StatusConnected }, "host connected")

	share, _ := url.Parse(s.URL)
	guest := startGuest(t, "testdata/guest.mjs", dir, wsURL(server), share.Fragment)

	read := func() string {
		b, _ := os.ReadFile(file)
		return string(b)
	}
	const edited = "こにちは🌏[X] world\n"
	prototest.WaitFor(t, 10*time.Second, func() bool { return read() == edited }, "the guest's edit on disk")

	const final = edited + "from file 🐹\n"
	if err := os.WriteFile(file, []byte(final), 0o644); err != nil {
		t.Fatal(err)
	}
	var got string
	if line := guest.next("the final text"); json.Unmarshal([]byte(line), &got) != nil || got != final {
		t.Fatalf("guest ended with %q\n%s", line, guest.stderr.String())
	}
	if err := s.Stop(); err != nil {
		t.Fatal(err)
	}
	if line := guest.next("the host to leave"); line != "host left" {
		t.Fatalf("guest said %q\n%s", line, guest.stderr.String())
	}
	guest.wait()
	if read() != final {
		t.Fatalf("file = %q", read())
	}
}

func TestAttachmentsWithJavaScriptGuest(t *testing.T) {
	dir := protocolDir(t)
	server := newServer(t)
	key := protocol.GenerateKey()
	raw, _ := protocol.DecodeKey(key)
	keys, err := protocol.DeriveBlobKeys(raw)
	if err != nil {
		t.Fatal(err)
	}
	doc := crdt.New()
	attachments := make(chan protocol.Attachment, 1)
	host, err := protocol.NewClient(protocol.ClientOptions{
		URL:          wsURL(server),
		Header:       http.Header{"Authorization": {"Bearer host-token"}},
		Key:          raw,
		Doc:          doc,
		Awareness:    awareness.New(uint64(doc.ClientID())),
		OnAttachment: func(a protocol.Attachment) { attachments <- a },
	})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(host.Destroy)
	host.Connect()
	prototest.WaitFor(t, 5*time.Second, func() bool { return host.Status() == protocol.StatusConnected }, "host connected")

	guest := startGuest(t, "testdata/attachment.mjs", dir, wsURL(server), key)
	var uploaded struct{ Hash, BlobID, Blob string }
	if line := guest.next("the upload"); json.Unmarshal([]byte(line), &uploaded) != nil {
		t.Fatalf("guest said %q\n%s", line, guest.stderr.String())
	}
	// The guest encrypted and named the blob the way the host does.
	const content = "\x89PNG\r\n\x1a\npedit 居間"
	if uploaded.Hash != protocol.ContentHash([]byte(content)) {
		t.Fatalf("hash = %s", uploaded.Hash)
	}
	if id, _ := keys.BlobID(uploaded.Hash); uploaded.BlobID != id {
		t.Fatalf("blob id = %s, want %s", uploaded.BlobID, id)
	}
	blob, _ := base64.RawURLEncoding.DecodeString(uploaded.Blob)
	if got, err := keys.Decrypt(blob, uploaded.Hash); err != nil || string(got) != content {
		t.Fatalf("Decrypt = %q, %v", got, err)
	}

	select {
	case a := <-attachments:
		want := protocol.Attachment{Kind: protocol.AttachmentAnnounce, Hash: uploaded.Hash, Mime: "image/png"}
		if !reflect.DeepEqual(a, want) {
			t.Fatalf("host got %+v", a)
		}
	case <-time.After(10 * time.Second):
		t.Fatalf("no announcement\n%s", guest.stderr.String())
	}
	path := "assets/" + uploaded.Hash + ".png"
	if err := host.SendAttachment(protocol.Attachment{Kind: protocol.AttachmentStored, Hash: uploaded.Hash, Path: path}); err != nil {
		t.Fatal(err)
	}
	if line := guest.next("the stored reply"); line != "stored "+path {
		t.Fatalf("guest said %q\n%s", line, guest.stderr.String())
	}
	guest.wait()
}

func TestGoHostSavesImagesFromJavaScriptGuest(t *testing.T) {
	dir := protocolDir(t)
	server := newServer(t)
	file := filepath.Join(t.TempDir(), "notes.md")
	// An image referenced by this document from an earlier session, which a
	// guest will ask for after the room's blob store starts empty.
	earlier := []byte("\x89PNG\r\n\x1a\nearlier")
	if err := os.WriteFile(file, []byte("# notes\n![](assets/"+protocol.ContentHash(earlier)+".png)\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	assets := filepath.Join(filepath.Dir(file), "assets")
	_ = os.Mkdir(assets, 0o755)
	if err := os.WriteFile(filepath.Join(assets, protocol.ContentHash(earlier)+".png"), earlier, 0o644); err != nil {
		t.Fatal(err)
	}
	var saved []string
	var mu sync.Mutex
	s, err := session.Start(context.Background(), session.Options{
		File:    file,
		Server:  server.URL,
		OnSaved: func(path string) { mu.Lock(); saved = append(saved, path); mu.Unlock() },
	})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = s.Stop() })
	prototest.WaitFor(t, 5*time.Second, func() bool { return s.Client.Status() == protocol.StatusConnected }, "host connected")

	share, _ := url.Parse(s.URL)
	guest := startGuest(t, "testdata/upload.mjs", dir, server.URL, roomID, share.Fragment, protocol.ContentHash(earlier))

	// The guest pasted an image: the host saved it.
	pasted := []byte("\x89PNG\r\n\x1a\npedit 居間")
	path := "assets/" + protocol.ContentHash(pasted) + ".png"
	if line := guest.next("the stored reply"); line != "stored "+path {
		t.Fatalf("guest said %q\n%s", line, guest.stderr.String())
	}
	if got, err := os.ReadFile(filepath.Join(filepath.Dir(file), filepath.FromSlash(path))); err != nil || string(got) != string(pasted) {
		t.Fatalf("saved %q, %v", got, err)
	}
	mu.Lock()
	if !reflect.DeepEqual(saved, []string{path}) {
		t.Fatalf("OnSaved got %v", saved)
	}
	mu.Unlock()

	// The guest wanted the earlier image: the host uploaded it from disk.
	if line := guest.next("the wanted image"); line != "wanted "+hex.EncodeToString(earlier) {
		t.Fatalf("guest said %q\n%s", line, guest.stderr.String())
	}
	guest.wait()
}

func wsURL(server *httptest.Server) string {
	return "ws" + strings.TrimPrefix(server.URL, "http") + "/api/rooms/" + roomID + "/ws"
}

// guest is a Node.js script under testdata that reports by printing lines.
type guest struct {
	t      *testing.T
	cmd    *exec.Cmd
	ctx    context.Context
	lines  chan string
	stderr *syncBuffer
}

func startGuest(t *testing.T, script string, args ...string) *guest {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	t.Cleanup(cancel)
	g := &guest{
		t:      t,
		cmd:    exec.CommandContext(ctx, "node", append([]string{script}, args...)...),
		ctx:    ctx,
		lines:  make(chan string),
		stderr: &syncBuffer{},
	}
	g.cmd.Stderr = g.stderr
	stdout, err := g.cmd.StdoutPipe()
	if err != nil {
		t.Fatal(err)
	}
	if err := g.cmd.Start(); err != nil {
		t.Fatal(err)
	}
	go func() {
		defer close(g.lines)
		scanner := bufio.NewScanner(stdout)
		for scanner.Scan() {
			g.lines <- scanner.Text()
		}
	}()
	return g
}

func (g *guest) next(what string) string {
	g.t.Helper()
	select {
	case line, ok := <-g.lines:
		if !ok {
			g.t.Fatalf("guest exited before %s: %v\n%s", what, g.cmd.Wait(), g.stderr.String())
		}
		return line
	case <-g.ctx.Done():
		g.t.Fatalf("timed out waiting for %s\n%s", what, g.stderr.String())
		return ""
	}
}

func (g *guest) wait() {
	g.t.Helper()
	if err := g.cmd.Wait(); err != nil {
		g.t.Fatalf("guest failed: %v\n%s", err, g.stderr.String())
	}
}

// syncBuffer collects a guest's stderr, which the test may read while the
// guest is still writing to it.
type syncBuffer struct {
	mu sync.Mutex
	b  strings.Builder
}

func (s *syncBuffer) Write(p []byte) (int, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.b.Write(p)
}

func (s *syncBuffer) String() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.b.String()
}

func TestGoHostSharesACanvasWithJavaScriptGuest(t *testing.T) {
	dir := protocolDir(t)
	server := newServer(t)
	file := filepath.Join(t.TempDir(), "board.canvas")
	const board = "{\n" +
		"\t\"nodes\":[\n" +
		"\t\t{\"id\":\"a1\",\"type\":\"text\",\"text\":\"Hello\",\"x\":0,\"y\":0,\"width\":250,\"height\":60},\n" +
		"\t\t{\"id\":\"b2\",\"type\":\"file\",\"file\":\"b.md\",\"x\":300,\"y\":0,\"width\":400,\"height\":400}\n" +
		"\t],\n" +
		"\t\"edges\":[\n" +
		"\t\t{\"id\":\"e1\",\"fromNode\":\"a1\",\"toNode\":\"b2\"}\n" +
		"\t]\n" +
		"}"
	if err := os.WriteFile(file, []byte(board), 0o644); err != nil {
		t.Fatal(err)
	}
	s, err := session.Start(context.Background(), session.Options{File: file, Server: server.URL, WriteDelay: 20 * time.Millisecond})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = s.Stop() })
	prototest.WaitFor(t, 5*time.Second, func() bool { return s.Client.Status() == protocol.StatusConnected }, "host connected")

	share, _ := url.Parse(s.URL)
	next := strings.Replace(board, `"file":"b.md"`, `"file":"c.md"`, 1)
	guest := startGuest(t, "testdata/canvas.mjs", dir, wsURL(server), share.Fragment, board, next)

	var shared struct {
		Format      string
		Nodes       []map[string]any
		Edges       []map[string]any
		TextIsYText bool
	}
	if line := guest.next("the shared canvas"); json.Unmarshal([]byte(line), &shared) != nil {
		t.Fatalf("guest said %q\n%s", line, guest.stderr.String())
	}
	if shared.Format != "canvas" || len(shared.Nodes) != 2 || len(shared.Edges) != 1 || !shared.TextIsYText || shared.Nodes[0]["text"] != "Hello" {
		t.Fatalf("guest saw %+v", shared)
	}
	if line := guest.next("the reply"); line != "applied" {
		t.Fatalf("guest said %q\n%s", line, guest.stderr.String())
	}
	guest.wait()

	// The guest's move (1.5 comes as a float32), its typing and its hand-edited JSON, saved.
	want := strings.Replace(next, `"text":"Hello","x":0`, `"text":"居間: Hello","x":1.5`, 1)
	prototest.WaitFor(t, 5*time.Second, func() bool {
		b, _ := os.ReadFile(file)
		return string(b) == want
	}, "the guest's edits to be saved")
}

func TestGoHostSharesSeveralFilesWithJavaScriptGuest(t *testing.T) {
	dir := protocolDir(t)
	server := newServer(t)
	key := protocol.GenerateKey()
	raw, _ := protocol.DecodeKey(key)
	doc := crdt.New()
	attachments := make(chan string, 1)
	host, err := protocol.NewClient(protocol.ClientOptions{
		URL:       wsURL(server),
		Header:    http.Header{"Authorization": {"Bearer host-token"}},
		Key:       raw,
		Doc:       doc,
		Awareness: awareness.New(uint64(doc.ClientID())),
		OnFileAttachment: func(id uint64, a protocol.Attachment) {
			attachments <- fmt.Sprintf("%d %s %s", id, a.Hash, a.Mime)
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(host.Destroy)
	files := []protocol.FileEntry{
		{ID: 1, Path: "agenda.md", Format: protocol.FormatText},
		{ID: 7, Path: "議事録/notes.md", Format: protocol.FormatText},
	}
	texts := map[uint64]*crdt.YText{}
	for i, f := range files {
		fileDoc := crdt.New()
		texts[f.ID] = fileDoc.GetText("content")
		fileDoc.Transact(func(txn *crdt.Transaction) { texts[f.ID].Insert(txn, 0, fmt.Sprintf("# %d 🌏\n", i), nil) })
		if err := host.AddFile(f.ID, fileDoc); err != nil {
			t.Fatal(err)
		}
	}
	if err := host.SetManifest(files); err != nil {
		t.Fatal(err)
	}
	host.Connect()
	prototest.WaitFor(t, 5*time.Second, func() bool { return host.Status() == protocol.StatusConnected }, "host connected")

	guest := startGuest(t, "testdata/files.mjs", dir, wsURL(server), key)
	var got struct {
		Manifest []protocol.FileEntry
		Texts    map[string]string
		Room     string
	}
	if line := guest.next("the files"); json.Unmarshal([]byte(line), &got) != nil {
		t.Fatalf("guest said %q\n%s", line, guest.stderr.String())
	}
	want := map[string]string{"agenda.md": "# 0 🌏\n", "議事録/notes.md": "# 1 🌏\n"}
	if !reflect.DeepEqual(got.Manifest, files) || !reflect.DeepEqual(got.Texts, want) || got.Room != "" {
		t.Fatalf("guest got %+v", got)
	}
	prototest.WaitFor(t, 5*time.Second, func() bool { return texts[7].ToString() == "# 1 🌏\n- from JS\n" }, "the guest's edit")
	select {
	case a := <-attachments:
		if a != "7 0123456789abcdef0123456789abcdef image/png" {
			t.Fatalf("host got %q", a)
		}
	case <-time.After(10 * time.Second):
		t.Fatalf("no announcement\n%s", guest.stderr.String())
	}
	stored := protocol.Attachment{Kind: protocol.AttachmentStored, Hash: "0123456789abcdef0123456789abcdef", Path: "assets/0123456789abcdef0123456789abcdef.png"}
	if err := host.SendFileAttachment(7, stored); err != nil {
		t.Fatal(err)
	}
	if line := guest.next("the stored reply"); line != "stored 7 "+stored.Path {
		t.Fatalf("guest said %q\n%s", line, guest.stderr.String())
	}
	guest.wait()
}

func TestGoHostKeepsCommentsFromJavaScriptGuest(t *testing.T) {
	dir := protocolDir(t)
	server := newServer(t)
	project := t.TempDir()
	file := filepath.Join(project, "notes.md")
	if err := os.WriteFile(file, []byte("A new line 🌏.\nhello world!\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	metaFile := filepath.Join(project, ".pedit", "meta", "notes.md.json")
	if err := os.MkdirAll(filepath.Dir(metaFile), 0o755); err != nil {
		t.Fatal(err)
	}
	saved := `{"version":1,"path":"notes.md","comments":{"c1":{"anchor":{"type":"text","exact":"world","prefix":"hello ","suffix":"!","offset":6},"quote":"world","resolved":false,"messages":{}}}}`
	if err := os.WriteFile(metaFile, []byte(saved), 0o644); err != nil {
		t.Fatal(err)
	}
	s, err := session.Start(context.Background(), session.Options{
		File:       file,
		Project:    project,
		Server:     server.URL,
		WriteDelay: 20 * time.Millisecond,
	})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = s.Stop() })
	prototest.WaitFor(t, 5*time.Second, func() bool { return s.Client.Status() == protocol.StatusConnected }, "host connected")

	share, _ := url.Parse(s.URL)
	guest := startGuest(t, "testdata/comments.mjs", dir, wsURL(server), share.Fragment)
	// Positions the host made, resolved by Yjs.
	if line := guest.next("the loaded thread"); line != `{"quote":"world","anchored":"world"}` {
		t.Fatalf("guest said %q\n%s", line, guest.stderr.String())
	}
	// Positions Yjs made, resolved by the host.
	read := func() *meta.File {
		data, _ := os.ReadFile(metaFile)
		f, _ := meta.Parse(data)
		return f
	}
	prototest.WaitFor(t, 10*time.Second, func() bool {
		f := read()
		return f != nil && f.Comments["g1"].Anchor.Text != nil
	}, "the guest's thread on disk")
	if err := s.Stop(); err != nil {
		t.Fatal(err)
	}
	if line := guest.next("the host to leave"); line != "host left" {
		t.Fatalf("guest said %q\n%s", line, guest.stderr.String())
	}
	guest.wait()
	f := read()
	// "🌏" is two UTF-16 code units, as Yjs counts.
	want := meta.Selector{Exact: "hello", Prefix: "A new line 🌏.\n", Suffix: " world!\n", Offset: 15}
	if g := f.Comments["g1"]; *g.Anchor.Text != want || g.Messages["m1"].Body != "Hi from JS" {
		t.Fatalf("saved %+v %+v", *g.Anchor.Text, g.Messages)
	}
	if c := f.Comments["c1"].Anchor.Text; c.Offset != 21 {
		t.Fatalf("re-anchored %+v", c)
	}
}
