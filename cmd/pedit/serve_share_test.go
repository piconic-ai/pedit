package main

import (
	"context"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/piconic-ai/pedit/internal/meta"
	"github.com/piconic-ai/pedit/internal/protocol"
	"github.com/piconic-ai/pedit/internal/protocol/prototest"
	"github.com/piconic-ai/pedit/internal/session"
	"github.com/reearth/ygo/crdt"
	ysync "github.com/reearth/ygo/sync"
)

const shareWait = 5 * time.Second

// shareEnv is a relay for serve to share to: room creation over HTTP, and the
// WebSocket side in memory.
type shareEnv struct {
	relay  *prototest.Relay
	server *httptest.Server
}

func newShareEnv(t *testing.T) *shareEnv {
	t.Helper()
	e := &shareEnv{relay: prototest.NewRelay(true)}
	var rooms atomic.Int32
	e.server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusCreated)
		_ = json.NewEncoder(w).Encode(map[string]string{"id": fmt.Sprintf("%022d", rooms.Add(1)), "hostToken": "host-token"})
	}))
	t.Cleanup(e.server.Close)
	serveDial = e.relay.Dial
	t.Cleanup(func() { serveDial = nil })
	return e
}

// app is the program that runs pedit serve.
type app struct {
	t      *testing.T
	in     *io.PipeWriter
	out    *lockedBuilder
	stderr *lockedBuilder
	stop   func() int
	shares int
}

func startApp(t *testing.T, file string) *app {
	t.Helper()
	out, stderr, in, stop := startServe(t, "--no-update-check", "--", file)
	waitFor(t, out, 1)
	return &app{t: t, in: in, out: out, stderr: stderr, stop: stop}
}

func (a *app) send(kind byte, stream uint32, payload []byte) {
	a.t.Helper()
	b := []byte{kind, 0, 0, 0, 0, 0, 0, 0, 0}
	binary.BigEndian.PutUint32(b[1:], stream)
	binary.BigEndian.PutUint32(b[5:], uint32(len(payload)))
	if _, err := a.in.Write(append(b, payload...)); err != nil {
		a.t.Fatal(err)
	}
}

func (a *app) command(js string) { a.t.Helper(); a.send(5, 0, []byte(js)) }

// wholeFrames are the complete frames in out so far.
func wholeFrames(out string) []frame {
	var got []frame
	b := []byte(out)
	for len(b) >= 9 && len(b) >= 9+int(binary.BigEndian.Uint32(b[5:])) {
		n := int(binary.BigEndian.Uint32(b[5:]))
		got = append(got, frame{kind: b[0], stream: binary.BigEndian.Uint32(b[1:]), payload: b[9 : 9+n]})
		b = b[9+n:]
	}
	return got
}

// event waits for the n-th event with this name (from 1) and returns it.
func (a *app) event(name string, n int) map[string]any {
	a.t.Helper()
	deadline := time.Now().Add(shareWait)
	for {
		seen := 0
		for _, f := range wholeFrames(a.out.String()) {
			var e map[string]any
			if f.kind == 4 && json.Unmarshal(f.payload, &e) == nil && e["event"] == name {
				if seen++; seen == n {
					return e
				}
			}
		}
		if time.Now().After(deadline) {
			a.t.Fatalf("no %s event #%d in %q\nstderr: %s", name, n, a.out.String(), a.stderr.String())
		}
		time.Sleep(5 * time.Millisecond)
	}
}

func (a *app) share(args string) map[string]any {
	a.t.Helper()
	a.command(`{"cmd":"share","keep":"0"` + args + `}`)
	a.shares++
	return a.event("shared", a.shares)
}

// page is one page of the app: a stream with a doc.
type page struct {
	mu   sync.Mutex
	doc  *crdt.Doc
	text *crdt.YText
}

func (a *app) openPage(id uint32) *page {
	a.t.Helper()
	p := &page{doc: crdt.New()}
	p.text = p.doc.GetText("content")
	local := new(int)
	a.send(1, id, []byte{0})
	msg := func(kind byte, payload []byte) []byte { return append([]byte{kind}, payload...) }
	p.doc.OnUpdate(func(update []byte, origin any) {
		if origin != local {
			a.send(2, id, msg(0, ysync.EncodeUpdate(update)))
		}
	})
	a.send(2, id, msg(0, ysync.EncodeSyncStep1(p.doc)))
	done := make(chan struct{})
	a.t.Cleanup(func() { close(done) })
	go func() {
		seen := 0
		for {
			select {
			case <-done:
				return
			case <-time.After(5 * time.Millisecond):
			}
			all := wholeFrames(a.out.String())
			for _, f := range all[seen:] {
				if f.kind != 2 || f.stream != id || f.payload[0] != 0 {
					continue
				}
				p.mu.Lock()
				reply, err := ysync.ApplySyncMessage(p.doc, f.payload[1:], local)
				p.mu.Unlock()
				if err == nil && len(reply) > 0 {
					a.send(2, id, msg(0, reply))
				}
			}
			seen = len(all)
		}
	}()
	return p
}

func (p *page) get() string {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.text.ToString()
}

func (p *page) insert(at int, s string) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.doc.Transact(func(txn *crdt.Transaction) { p.text.Insert(txn, at, s, nil) })
}

func eventually(t *testing.T, what string, cond func() bool) {
	t.Helper()
	prototest.WaitFor(t, shareWait, cond, what)
}

// join joins the room of a link from the shared event, as a guest.
func (e *shareEnv) join(t *testing.T, link, name string) *session.Session {
	t.Helper()
	room, frag, _ := strings.Cut(link, ".")
	g, err := session.Join(context.Background(), session.JoinOptions{
		URL: e.server.URL + "/r/" + room + "#" + frag, Name: name, Dial: e.relay.Dial, WriteDelay: 20 * time.Millisecond,
	})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = g.Stop() })
	return g
}

func guestInsert(g *session.Session, at int, s string) {
	g.Client.Do(func() {
		g.Doc.Transact(func(txn *crdt.Transaction) { g.Text.Insert(txn, at, s, nil) })
	})
}

func guestText(g *session.Session) string {
	var s string
	g.Client.Do(func() { s = g.Text.ToString() })
	return s
}

func linkOf(ev map[string]any, access string) string {
	links, _ := ev["links"].(map[string]any)
	s, _ := links[access].(string)
	return s
}

func readText(t *testing.T, path string) string {
	t.Helper()
	b, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}

// holds is whether the file holds want now. A read that fails counts as not
// yet: on Windows the file cannot be opened while pedit replaces it.
func holds(path, want string) bool {
	b, err := os.ReadFile(path)
	return err == nil && string(b) == want
}

func TestServeShareRoomEndToEnd(t *testing.T) {
	env := newShareEnv(t)
	file := writeFile(t, "hello\n")
	a := startApp(t, file)
	p := a.openPage(1)
	eventually(t, "the page's text", func() bool { return p.get() == "hello\n" })

	shared := a.share(fmt.Sprintf(`,"relay":%q,"origins":["https://cms.example.com"]`, env.server.URL))
	if shared["resumed"] != false || shared["keptUntil"] != float64(0) || linkOf(shared, "edit") == "" || linkOf(shared, "read") == "" {
		t.Fatalf("shared %v", shared)
	}
	if !strings.HasPrefix(linkOf(shared, "edit"), shared["room"].(string)+".") {
		t.Fatalf("link %v", shared)
	}
	if got := env.relay.Headers()[0].Get(protocol.OriginsHeader); got != "https://cms.example.com" {
		t.Fatalf("origins header %q", got)
	}

	g := env.join(t, linkOf(shared, "edit"), "ada")
	eventually(t, "the guest's text", func() bool { return guestText(g) == "hello\n" })

	// The guest's edit reaches the page and the file.
	guestInsert(g, 0, "oh, ")
	eventually(t, "the page gets the guest's edit", func() bool { return p.get() == "oh, hello\n" })
	eventually(t, "the file gets it", func() bool { return holds(file, "oh, hello\n") })
	// The page's edit reaches the guest.
	p.insert(len("oh, hello\n"), "bye\n")
	eventually(t, "the guest gets the page's edit", func() bool { return guestText(g) == "oh, hello\nbye\n" })

	// Who is in the room, with the access of the link.
	eventually(t, "a peers event with the guest", func() bool {
		for _, f := range wholeFrames(a.out.String()) {
			var e struct {
				Event string              `json:"event"`
				Peers []map[string]string `json:"peers"`
			}
			if f.kind == 4 && json.Unmarshal(f.payload, &e) == nil && e.Event == "peers" &&
				len(e.Peers) == 1 && e.Peers[0]["name"] == "ada" && e.Peers[0]["access"] == "edit" {
				return true
			}
		}
		return false
	})

	// unshare ends the room for the guest, and a second share opens another.
	a.command(`{"cmd":"unshare"}`)
	eventually(t, "the guest sees the host leave", func() bool { return g.Client.Status() == protocol.StatusClosed })
	second := a.share(fmt.Sprintf(`,"relay":%q`, env.server.URL))
	if second["room"] == shared["room"] {
		t.Fatalf("same room twice: %v", second)
	}
	eventually(t, "the file has the page edit", func() bool { return holds(file, "oh, hello\nbye\n") })
	if got := readText(t, file); got != "oh, hello\nbye\n" {
		t.Fatalf("file %q", got)
	}
	if code := a.stop(); code != 0 {
		t.Fatalf("code %d, stderr %s", code, a.stderr.String())
	}
}

func TestServeShareRefusalsKeepServing(t *testing.T) {
	env := newShareEnv(t)
	file := writeFile(t, "hi\n")
	a := startApp(t, file)
	p := a.openPage(1)

	a.command(`{"cmd":"unshare"}`)
	if e := a.event("error", 1); e["cmd"] != "unshare" || !strings.Contains(e["message"].(string), "not shared") {
		t.Fatalf("%v", e)
	}
	// Kept rooms are not built yet; the default keep is one.
	a.command(fmt.Sprintf(`{"cmd":"share","relay":%q}`, env.server.URL))
	if e := a.event("error", 2); e["cmd"] != "share" || !strings.Contains(e["message"].(string), "not available yet") {
		t.Fatalf("%v", e)
	}
	a.command(`{"cmd":"share","keep":"0","relay":"http://127.0.0.1:1"}`)
	if e := a.event("error", 3); e["cmd"] != "share" {
		t.Fatalf("%v", e)
	}
	// Still serving, and the failed share left no peer behind.
	p.insert(0, "x")
	eventually(t, "the file", func() bool { return holds(file, "xhi\n") })
	a.share(fmt.Sprintf(`,"relay":%q`, env.server.URL))
	a.command(fmt.Sprintf(`{"cmd":"share","keep":"0","relay":%q}`, env.server.URL))
	if e := a.event("error", 4); !strings.Contains(e["message"].(string), "already shared") {
		t.Fatalf("%v", e)
	}
	if code := a.stop(); code != 0 {
		t.Fatalf("code %d, stderr %s", code, a.stderr.String())
	}
}

func TestServeShareFindsTheProjectAboveTheFile(t *testing.T) {
	env := newShareEnv(t)
	root := t.TempDir()
	if err := os.MkdirAll(filepath.Join(root, ".pedit", "meta", "docs"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(root, "docs"), 0o755); err != nil {
		t.Fatal(err)
	}
	// The config's server is unreachable: the share command's relay wins.
	if err := os.WriteFile(filepath.Join(root, ".pedit", "config.yaml"), []byte("server: http://127.0.0.1:1\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	saved := `{"version":1,"path":"docs/a.md","comments":{"c0":{"anchor":{"type":"text","exact":"hello","prefix":"","suffix":" world","offset":0},"quote":"hello","resolved":false,"messages":{"m0":{"author":"Ada","time":"2026-10-20T00:00:00Z","body":"Saved before"}}}}}`
	metaFile := filepath.Join(root, ".pedit", "meta", "docs", "a.md.json")
	if err := os.WriteFile(metaFile, []byte(saved), 0o644); err != nil {
		t.Fatal(err)
	}
	file := filepath.Join(root, "docs", "a.md")
	if err := os.WriteFile(file, []byte("hello world!\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	a := startApp(t, file)
	shared := a.share(fmt.Sprintf(`,"relay":%q`, env.server.URL))
	comment := linkOf(shared, "comment")
	if comment == "" {
		t.Fatalf("no comment link: %v", shared)
	}
	g := env.join(t, comment, "tate")
	eventually(t, "the thread at the guest", func() bool {
		c := g.Comments()
		return len(c) == 1 && len(c[0].Threads) == 1
	})
	if res, err := g.Reply("", "c0", "r1", "From the guest"); err != nil || !res.Delivered {
		t.Fatalf("%+v %v", res, err)
	}
	eventually(t, "the reply in the project's meta", func() bool {
		data, err := os.ReadFile(metaFile)
		if err != nil {
			return false
		}
		f, err := meta.Parse(data)
		return err == nil && f.Comments["c0"].Messages["r1"].Author == "tate"
	})
	if code := a.stop(); code != 0 {
		t.Fatalf("code %d, stderr %s", code, a.stderr.String())
	}
}

func TestServeShareCreatesNoConfiguration(t *testing.T) {
	env := newShareEnv(t)
	root := t.TempDir()
	if err := os.Mkdir(filepath.Join(root, ".git"), 0o755); err != nil {
		t.Fatal(err)
	}
	file := filepath.Join(root, "a.md")
	if err := os.WriteFile(file, []byte("hi\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	a := startApp(t, file)
	a.share(fmt.Sprintf(`,"relay":%q`, env.server.URL))
	if _, err := os.Stat(filepath.Join(root, ".pedit")); !os.IsNotExist(err) {
		t.Fatalf("serve created .pedit: %v", err)
	}
	// With no configuration, the project is the Git root.
	sub := filepath.Join(root, "sub", "dir")
	if cfg, err := loadProject(sub); err != nil || cfg.root != root || cfg.Server != defaultServer {
		t.Fatalf("git root: %+v %v", cfg, err)
	}
	// Outside a repository it is the directory itself.
	if cfg, err := loadProject(sub[:0] + t.TempDir()); err != nil {
		t.Fatal(err)
	} else if _, err := os.Stat(filepath.Join(cfg.root, ".pedit")); !os.IsNotExist(err) {
		t.Fatalf("loadProject created .pedit: %v", err)
	}
	if code := a.stop(); code != 0 {
		t.Fatalf("code %d, stderr %s", code, a.stderr.String())
	}
}

func TestServeStdinClosingLeavesTheRoomAndSavesEveryEdit(t *testing.T) {
	env := newShareEnv(t)
	file := writeFile(t, "hello\n")
	a := startApp(t, file)
	shared := a.share(fmt.Sprintf(`,"relay":%q`, env.server.URL))
	g := env.join(t, linkOf(shared, "edit"), "ada")
	eventually(t, "the guest's text", func() bool { return guestText(g) == "hello\n" })
	guestInsert(g, 0, "last edit; ")
	// No wait for the file: stdin closes while the edit may be on its way.
	time.Sleep(50 * time.Millisecond)
	if code := a.stop(); code != 0 {
		t.Fatalf("code %d, stderr %s", code, a.stderr.String())
	}
	eventually(t, "the guest sees the room end", func() bool { return g.Client.Status() == protocol.StatusClosed })
	if got := readText(t, file); got != "last edit; hello\n" {
		t.Fatalf("file %q", got)
	}
}

func TestServeShareRoomEndedByTheRelay(t *testing.T) {
	for code, reason := range map[int]string{protocol.RoomExpired: "expired", protocol.RelayMaintenance: "maintenance", protocol.RoomClosed: "closed"} {
		t.Run(reason, func(t *testing.T) {
			env := newShareEnv(t)
			file := writeFile(t, "hi\n")
			a := startApp(t, file)
			a.share(fmt.Sprintf(`,"relay":%q`, env.server.URL))
			env.relay.CloseAll(code, "")
			if e := a.event("room_ended", 1); e["reason"] != reason {
				t.Fatalf("%v", e)
			}
			// The share is over: another can start.
			eventually(t, "unshare refused", func() bool {
				a.command(`{"cmd":"unshare"}`)
				return strings.Contains(a.stderr.String()+a.out.String(), "not shared")
			})
			a.share(fmt.Sprintf(`,"relay":%q`, env.server.URL))
			if c := a.stop(); c != 0 {
				t.Fatalf("code %d, stderr %s", c, a.stderr.String())
			}
		})
	}
}

// What a page writes while the room starts is not lost nor applied twice.
func TestServeShareKeepsEditsMadeWhileTheRoomStarts(t *testing.T) {
	env := newShareEnv(t)
	file := writeFile(t, "\n")
	a := startApp(t, file)
	p := a.openPage(1)
	var typed sync.WaitGroup
	typed.Add(1)
	go func() {
		defer typed.Done()
		for i := 0; i < 60; i++ {
			p.insert(0, "a")
			time.Sleep(time.Millisecond)
		}
	}()
	a.command(fmt.Sprintf(`{"cmd":"share","keep":"0","relay":%q}`, env.server.URL))
	shared := a.event("shared", 1)
	typed.Wait()
	g := env.join(t, linkOf(shared, "edit"), "ada")
	// The page typed before it had the file's newline, so where that falls is
	// the doc's to decide: all three must agree, with every edit in them.
	whole := func(s string) bool { return strings.Count(s, "a") == 60 && strings.Count(s, "\n") == 1 }
	eventually(t, "the guest has every edit", func() bool { return whole(guestText(g)) })
	eventually(t, "the file agrees", func() bool { return holds(file, guestText(g)) })
	eventually(t, "the page agrees", func() bool { return p.get() == guestText(g) })
	if code := a.stop(); code != 0 {
		t.Fatalf("code %d, stderr %s", code, a.stderr.String())
	}
}
