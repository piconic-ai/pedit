package serve

import (
	"context"
	"encoding/json"
	"errors"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"sort"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/reearth/ygo/awareness"
	"github.com/reearth/ygo/crdt"
	"github.com/reearth/ygo/encoding"
	ysync "github.com/reearth/ygo/sync"
)

// base is a short directory for sockets: t.TempDir can be too long for one.
func base(t *testing.T) string {
	t.Helper()
	dir, err := os.MkdirTemp("", "ps")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(dir) })
	return dir
}

func write(t *testing.T, path, content string) {
	t.Helper()
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
}

// open serves a file holding content, and reports each write of it.
func open(t *testing.T, content string) (*Server, string, chan struct{}) {
	t.Helper()
	file := filepath.Join(t.TempDir(), "doc.md")
	write(t, file, content)
	written := make(chan struct{}, 100)
	s, err := Open(file, Options{
		App:        "test",
		WriteDelay: 20 * time.Millisecond,
		SocketBase: base(t),
		OnError:    func(err error) { t.Log("serve error:", err) },
		OnWritten:  func() { written <- struct{}{} },
	})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = s.Close() })
	return s, file, written
}

// A tclient is a y-websocket client written from y-protocols' encoding.
type tclient struct {
	t    *testing.T
	conn *websocket.Conn
	mu   sync.Mutex
	doc  *crdt.Doc
	text *crdt.YText
	aw   *awareness.Awareness
}

type remote struct{ _ byte }

func dial(t *testing.T, sock string) *tclient {
	t.Helper()
	hc := &http.Client{Transport: &http.Transport{
		DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
			return (&net.Dialer{}).DialContext(ctx, "unix", sock)
		},
	}}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	conn, _, err := websocket.Dial(ctx, "ws://pedit/room", &websocket.DialOptions{HTTPClient: hc})
	if err != nil {
		t.Fatal(err)
	}
	conn.SetReadLimit(1 << 24)
	c := &tclient{t: t, conn: conn, doc: crdt.New()}
	c.text = c.doc.GetText("content")
	c.aw = awareness.New(uint64(c.doc.ClientID()))
	local := &remote{}
	c.doc.OnUpdate(func(update []byte, origin any) {
		if origin == local {
			return
		}
		c.send(msgSync, ysync.EncodeUpdate(update))
	})
	c.send(msgSync, ysync.EncodeSyncStep1(c.doc))
	go func() {
		for {
			_, data, err := conn.Read(context.Background())
			if err != nil {
				return
			}
			c.mu.Lock()
			switch data[0] {
			case msgSync:
				reply, err := ysync.ApplySyncMessage(c.doc, data[1:], local)
				if err != nil {
					t.Error(err)
				}
				if len(reply) > 0 {
					c.send(msgSync, reply)
				}
			case msgAwareness:
				u, _ := encoding.NewDecoder(data[1:]).ReadVarBytes()
				_ = c.aw.ApplyUpdate(u, local)
			}
			c.mu.Unlock()
		}
	}()
	t.Cleanup(func() { _ = conn.CloseNow() })
	return c
}

func (c *tclient) send(kind uint64, payload []byte) {
	_ = c.conn.Write(context.Background(), websocket.MessageBinary, frame(kind, payload))
}

func (c *tclient) get() string {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.text.ToString()
}

func (c *tclient) insert(at int, s string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.doc.Transact(func(txn *crdt.Transaction) { c.text.Insert(txn, at, s, nil) })
}

func (c *tclient) setState(state map[string]any) {
	c.mu.Lock()
	c.aw.SetLocalState(state)
	u := c.aw.EncodeUpdate([]uint64{c.aw.ClientID()})
	c.mu.Unlock()
	enc := encoding.NewEncoder()
	enc.WriteVarBytes(u)
	c.send(msgAwareness, enc.Bytes())
}

func eventually(t *testing.T, what string, ok func() bool) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for !ok() {
		if time.Now().After(deadline) {
			t.Fatalf("timed out waiting for %s", what)
		}
		time.Sleep(2 * time.Millisecond)
	}
}

func fileIs(t *testing.T, file, want string) func() bool {
	return func() bool {
		b, _ := os.ReadFile(file)
		return string(b) == want
	}
}

// saveElsewhere saves like another editor: a new file renamed over the old.
func saveElsewhere(t *testing.T, file, content string) {
	t.Helper()
	tmp := file + ".other"
	write(t, tmp, content)
	if err := os.Rename(tmp, file); err != nil {
		t.Fatal(err)
	}
}

func TestClientEditsReachFileAndExternalSaveReachesClient(t *testing.T) {
	s, file, _ := open(t, "alpha\nbeta\n")
	c := dial(t, s.SocketPath())
	eventually(t, "the file's text", func() bool { return c.get() == "alpha\nbeta\n" })

	c.insert(5, " one")
	eventually(t, "the client's edit in the file", fileIs(t, file, "alpha one\nbeta\n"))

	saveElsewhere(t, file, "alpha one\nbeta two\n")
	eventually(t, "the external save in the client", func() bool { return c.get() == "alpha one\nbeta two\n" })

	// Both write at once: neither is lost.
	c.insert(0, ">")
	saveElsewhere(t, file, "alpha one\nbeta two\ngamma\n")
	eventually(t, "both edits in the file", fileIs(t, file, ">alpha one\nbeta two\ngamma\n"))
	eventually(t, "both edits in the client", func() bool { return c.get() == ">alpha one\nbeta two\ngamma\n" })
}

func TestFrontmatterCRLFAndBOMSurvive(t *testing.T) {
	start := "\ufeff---\r\ntitle: Draft\r\ntags: [a, b]\r\n---\r\n\r\nFirst line\r\nSecond line\r\n"
	s, file, _ := open(t, start)
	c := dial(t, s.SocketPath())
	// The client sees LF: a CodeMirror client would miscount each CR.
	lf := func(s string) string { return strings.ReplaceAll(s, "\r\n", "\n") }
	eventually(t, "the file's text", func() bool { return c.get() == lf(start) })

	// A client edit in the body.
	at := len([]rune(lf("\ufeff---\r\ntitle: Draft\r\ntags: [a, b]\r\n---\r\n\r\nFirst")))
	c.insert(at, "!")
	afterClient := "\ufeff---\r\ntitle: Draft\r\ntags: [a, b]\r\n---\r\n\r\nFirst! line\r\nSecond line\r\n"
	eventually(t, "the client's edit, byte for byte", fileIs(t, file, afterClient))

	// An external save in the frontmatter.
	external := "\ufeff---\r\ntitle: Final\r\ntags: [a, b]\r\n---\r\n\r\nFirst! line\r\nSecond line\r\n"
	saveElsewhere(t, file, external)
	eventually(t, "the external save in the client", func() bool { return c.get() == lf(external) })
	// Nothing was rewritten on the way.
	time.Sleep(100 * time.Millisecond)
	if got, _ := os.ReadFile(file); string(got) != external {
		t.Fatalf("file = %q, want %q", got, external)
	}
}

func TestMixedLineEndingsAreHeldAsTheyAre(t *testing.T) {
	for s, want := range map[string]bool{"a\r\nb\r\n": true, "a\nb\n": false, "a\r\nb\n": false, "a\rb\r\n": false, "": false} {
		if isCRLF(s) != want {
			t.Errorf("isCRLF(%q) = %v", s, !want)
		}
	}
	mixed := "a\r\nb\nc\r\n"
	s, file, _ := open(t, mixed)
	c := dial(t, s.SocketPath())
	eventually(t, "the text as it is", func() bool { return c.get() == mixed })
	c.insert(0, "x")
	eventually(t, "the edit, endings kept", fileIs(t, file, "x"+mixed))
}

func TestSecondServeIsRefusedAndStaleLockTakenOver(t *testing.T) {
	s, file, _ := open(t, "x\n")
	_, err := Open(file, Options{App: "other", SocketBase: base(t)})
	var held *HeldError
	if !errors.As(err, &held) {
		t.Fatalf("second Open = %v, want *HeldError", err)
	}
	if held.Holder.PID != os.Getpid() || held.Holder.App != "test" {
		t.Fatalf("holder = %+v", held.Holder)
	}
	if msg := err.Error(); !strings.Contains(msg, "test") || !strings.Contains(msg, "pid") {
		t.Fatalf("message %q does not name the holder", msg)
	}

	if err := s.Close(); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(lockPath(file)); !os.IsNotExist(err) {
		t.Fatalf("lock left behind: %v", err)
	}
	if _, err := os.Stat(s.dir); !os.IsNotExist(err) {
		t.Fatalf("socket directory left behind: %v", err)
	}

	// A crash leaves the lock with a dead pid.
	cmd := exec.Command(os.Args[0], "-test.run=NONE")
	if err := cmd.Run(); err != nil {
		t.Fatal(err)
	}
	stale, _ := json.Marshal(holder{PID: cmd.Process.Pid, App: "crashed"})
	write(t, lockPath(file), string(stale))
	s2, err := Open(file, Options{SocketBase: base(t)})
	if err != nil {
		t.Fatalf("stale lock not taken over: %v", err)
	}
	_ = s2.Close()
}

func TestSocketDirectoryIsPrivate(t *testing.T) {
	s, _, _ := open(t, "x\n")
	info, err := os.Stat(s.dir)
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode().Perm() != 0o700 {
		t.Fatalf("socket directory mode = %v, want 0700", info.Mode().Perm())
	}
}

func TestTwoClientsSeeEachOtherAndAwareness(t *testing.T) {
	s, file, _ := open(t, "shared\n")
	a, b := dial(t, s.SocketPath()), dial(t, s.SocketPath())
	eventually(t, "both synced", func() bool { return a.get() == "shared\n" && b.get() == "shared\n" })

	a.insert(0, "A:")
	eventually(t, "A's edit in B", func() bool { return b.get() == "A:shared\n" })
	b.insert(len("A:shared\n"), "B")
	eventually(t, "B's edit in A", func() bool { return a.get() == "A:shared\nB" })
	eventually(t, "both in the file", fileIs(t, file, "A:shared\nB"))

	a.setState(map[string]any{"user": map[string]any{"name": "ann"}})
	aid := a.aw.ClientID()
	eventually(t, "A's awareness in B", func() bool {
		b.mu.Lock()
		defer b.mu.Unlock()
		_, ok := b.aw.GetStates()[aid]
		return ok
	})
	// A client that joins later is told who is there.
	c := dial(t, s.SocketPath())
	eventually(t, "A's awareness in a late client", func() bool {
		c.mu.Lock()
		defer c.mu.Unlock()
		_, ok := c.aw.GetStates()[aid]
		return ok
	})
	_ = a.conn.CloseNow()
	eventually(t, "A gone from B", func() bool {
		b.mu.Lock()
		defer b.mu.Unlock()
		_, ok := b.aw.GetStates()[aid]
		return !ok
	})
}

func TestMalformedFrameDoesNotStopServer(t *testing.T) {
	s, _, _ := open(t, "ok\n")
	bad := dial(t, s.SocketPath())
	bad.send(msgSync, []byte{2, 5, 1, 2})
	good := dial(t, s.SocketPath())
	eventually(t, "a good client", func() bool { return good.get() == "ok\n" })
}

// TestLatency prints how long a client's keystroke takes to reach the other
// client and the file (run with -v).
func TestLatency(t *testing.T) {
	s, file, written := open(t, "")
	a, b := dial(t, s.SocketPath()), dial(t, s.SocketPath())
	time.Sleep(100 * time.Millisecond)
	var toClient, toFile []time.Duration
	for i := range 20 {
		for len(written) > 0 {
			<-written
		}
		want := a.get() + "x"
		start := time.Now()
		a.insert(len(a.get()), "x")
		eventually(t, "B", func() bool { return b.get() == want })
		toClient = append(toClient, time.Since(start))
		eventually(t, "file", fileIs(t, file, want))
		toFile = append(toFile, time.Since(start))
		_ = i
	}
	median := func(d []time.Duration) time.Duration {
		d = slices.Clone(d)
		sort.Slice(d, func(i, j int) bool { return d[i] < d[j] })
		return d[len(d)/2]
	}
	t.Logf("client to client: median %v, max %v; client to file (write delay 20ms): median %v",
		median(toClient), slices.Max(toClient), median(toFile))
}
