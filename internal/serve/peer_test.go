package serve

import (
	"fmt"
	"os"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/reearth/ygo/awareness"
	"github.com/reearth/ygo/crdt"
	"github.com/reearth/ygo/encoding"
)

// room stands in for a room session: a doc of its own kept in step with the
// server's through a peer.
type room struct {
	t     *testing.T
	mu    sync.Mutex
	doc   *crdt.Doc
	text  *crdt.YText
	aw    *awareness.Awareness
	peer  *Peer
	local *remote
	// updates counts what Update delivered.
	updates atomic.Int32
}

func attachRoom(t *testing.T, s *Server) *room {
	t.Helper()
	r := &room{t: t, doc: crdt.New(), local: &remote{}}
	r.text = r.doc.GetText("content")
	r.aw = awareness.New(uint64(r.doc.ClientID()))
	var err error
	r.peer, err = s.AttachPeer(PeerHandler{
		Update: func(u []byte) {
			r.updates.Add(1)
			r.mu.Lock()
			defer r.mu.Unlock()
			if err := crdt.ApplyUpdateV1(r.doc, u, r.local); err != nil {
				t.Error(err)
			}
		},
		Awareness: func(u []byte) {
			r.mu.Lock()
			defer r.mu.Unlock()
			if err := r.aw.ApplyUpdate(u, r.local); err != nil {
				t.Error(err)
			}
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	r.mu.Lock()
	if err := crdt.ApplyUpdateV1(r.doc, r.peer.State(), r.local); err != nil {
		t.Fatal(err)
	}
	if err := r.aw.ApplyUpdate(r.peer.AwarenessState(), r.local); err != nil {
		t.Fatal(err)
	}
	r.mu.Unlock()
	// Edits of the room go to the server through Apply.
	r.doc.OnUpdate(func(u []byte, origin any) {
		if origin != r.local {
			if err := r.peer.Apply(u); err != nil {
				t.Error(err)
			}
		}
	})
	t.Cleanup(r.peer.Close)
	return r
}

func (r *room) get() string {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.text.ToString()
}

func (r *room) insert(at int, s string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.doc.Transact(func(txn *crdt.Transaction) { r.text.Insert(txn, at, s, nil) })
}

func (r *room) setState(state map[string]any) {
	r.mu.Lock()
	r.aw.SetLocalState(state)
	u := r.aw.EncodeUpdate([]uint64{r.aw.ClientID()})
	r.mu.Unlock()
	if err := r.peer.ApplyAwareness(u); err != nil {
		r.t.Error(err)
	}
}

func (r *room) sees(id uint64) bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	_, ok := r.aw.GetStates()[id]
	return ok
}

func (c *tclient) sees(id uint64) bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	st, ok := c.aw.GetStates()[id]
	return ok && st.State != nil
}

func TestPeerApplyReachesStreamsAndFileButNotUpdate(t *testing.T) {
	s, file, _ := open(t, "hello\n")
	c := dial(t, s)
	r := attachRoom(t, s)
	eventually(t, "stream synced", func() bool { return c.get() == "hello\n" })
	if r.get() != "hello\n" {
		t.Fatalf("state: %q", r.get())
	}
	// The stream's own handshake may still produce an (empty) update.
	time.Sleep(100 * time.Millisecond)
	before := r.updates.Load()
	r.insert(0, "room:")
	eventually(t, "stream has the room's edit", func() bool { return c.get() == "room:hello\n" })
	eventually(t, "file has the room's edit", fileIs(t, file, "room:hello\n"))
	time.Sleep(50 * time.Millisecond)
	if n := r.updates.Load(); n != before {
		t.Fatalf("Update got %d updates for the peer's own edit", n-before)
	}
}

func TestStreamEditAndExternalSaveReachUpdate(t *testing.T) {
	s, file, _ := open(t, "a\n")
	c := dial(t, s)
	r := attachRoom(t, s)
	eventually(t, "stream synced", func() bool { return c.get() == "a\n" })
	c.insert(0, "s:")
	eventually(t, "stream edit in the room", func() bool { return r.get() == "s:a\n" })
	eventually(t, "file written", fileIs(t, file, "s:a\n"))
	saveElsewhere(t, file, "s:a\nexternal\n")
	eventually(t, "external save in the room", func() bool { return r.get() == "s:a\nexternal\n" })
}

func TestPeerStartsFromStateAndConverges(t *testing.T) {
	s, file, _ := open(t, "base\n")
	c := dial(t, s)
	eventually(t, "stream synced", func() bool { return c.get() == "base\n" })
	c.insert(0, "before:")
	eventually(t, "file written", fileIs(t, file, "before:base\n"))
	r := attachRoom(t, s)
	if r.get() != "before:base\n" {
		t.Fatalf("State(): %q", r.get())
	}
	var wg sync.WaitGroup
	for i := range 20 {
		wg.Add(2)
		go func() { defer wg.Done(); c.insert(0, fmt.Sprintf("c%d;", i)) }()
		go func() { defer wg.Done(); r.insert(0, fmt.Sprintf("r%d;", i)) }()
	}
	wg.Wait()
	eventually(t, "both docs equal", func() bool {
		a, b := r.get(), c.get()
		return a == b && countOf(a, ";") == 40 && a == s.render()
	})
	got := r.get()
	for i := range 20 {
		for _, p := range []string{"c", "r"} {
			if n := countOf(got, fmt.Sprintf("%s%d;", p, i)); n != 1 {
				t.Fatalf("%s%d; appears %d times in %q", p, i, n, got)
			}
		}
	}
	eventually(t, "file equal", fileIs(t, file, got))
}

func countOf(s, sub string) int {
	n := 0
	for i := 0; i+len(sub) <= len(s); i++ {
		if s[i:i+len(sub)] == sub {
			n++
		}
	}
	return n
}

func TestPeerAwarenessBothWaysAndOwnership(t *testing.T) {
	s, _, _ := open(t, "x\n")
	c := dial(t, s)
	c.setState(map[string]any{"user": "stream"})
	eventually(t, "server has the stream's state", func() bool {
		s.mu.Lock()
		defer s.mu.Unlock()
		_, ok := s.aw.GetStates()[c.aw.ClientID()]
		return ok
	})
	r := attachRoom(t, s)
	// The state present at attach is in AwarenessState.
	if !r.sees(c.aw.ClientID()) {
		t.Fatal("the room does not see the stream's state from AwarenessState")
	}
	c.setState(map[string]any{"user": "stream2"})
	eventually(t, "stream update reaches the room", func() bool {
		r.mu.Lock()
		defer r.mu.Unlock()
		st := r.aw.GetStates()[c.aw.ClientID()]
		return st.State["user"] == "stream2"
	})
	r.setState(map[string]any{"user": "room"})
	rid := r.aw.ClientID()
	eventually(t, "room state reaches the stream", func() bool { return c.sees(rid) })
	r.peer.Close()
	eventually(t, "room state removed from the stream", func() bool { return !c.sees(rid) })
	s.mu.Lock()
	_, present := s.aw.GetStates()[rid]
	s.mu.Unlock()
	if present {
		t.Fatal("the peer's state is still in the server's awareness")
	}
}

func TestPeerIsNeverRetiredAndSkipsStreamCaps(t *testing.T) {
	s, file, _ := open(t, "")
	r := attachRoom(t, s)
	for i := range 5000 {
		r.insert(i, "x")
	}
	// More IDs than one stream may announce.
	for i := range maxConnAwareness + 20 {
		enc := encoding.NewEncoder()
		enc.WriteVarUint(1)
		enc.WriteVarUint(uint64(1000 + i))
		enc.WriteVarUint(1)
		enc.WriteVarString(`{"n":1}`)
		if err := r.peer.ApplyAwareness(enc.Bytes()); err != nil {
			t.Fatal(err)
		}
	}
	if err := r.peer.Apply(nil); err == nil {
		// An empty update is not an error in ygo; any other call must work.
		t.Log("empty update accepted")
	}
	eventually(t, "file has all edits", fileIs(t, file, repeat("x", 5000)))
	s.mu.Lock()
	open := s.peer != nil && !s.peer.closed
	s.mu.Unlock()
	if !open {
		t.Fatal("the peer was retired")
	}
}

func repeat(s string, n int) string {
	b := make([]byte, 0, n*len(s))
	for range n {
		b = append(b, s...)
	}
	return string(b)
}

func TestPeerMalformedUpdateLeavesDocAsItWas(t *testing.T) {
	s, _, _ := open(t, "keep\n")
	r := attachRoom(t, s)
	for _, bad := range [][]byte{{0xff, 0xff, 0xff, 0xff, 0xff}, {1, 2, 3}, {0x05, 0x01, 0x80}} {
		_ = r.peer.Apply(bad) // an error or not, never a crash
	}
	if err := r.peer.Apply([]byte{0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff}); err == nil {
		t.Fatal("garbage was accepted")
	}
	if got := s.render(); got != "keep\n" {
		t.Fatalf("doc changed: %q", got)
	}
	if err := r.peer.ApplyAwareness([]byte{0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff}); err == nil {
		t.Fatal("garbage awareness was accepted")
	}
	r.insert(0, "ok:")
	eventually(t, "still works", func() bool { return s.render() == "ok:keep\n" })
}

func TestPeerLifecycle(t *testing.T) {
	s, _, _ := open(t, "x\n")
	r := attachRoom(t, s)
	if _, err := s.AttachPeer(PeerHandler{}); err == nil {
		t.Fatal("a second peer was accepted")
	}
	r.peer.Close()
	r.peer.Close() // idempotent
	if err := r.peer.Apply(nil); err == nil {
		t.Fatal("Apply after Close succeeded")
	}
	if err := r.peer.ApplyAwareness(nil); err == nil {
		t.Fatal("ApplyAwareness after Close succeeded")
	}
	c := dial(t, s)
	eventually(t, "synced", func() bool { return c.get() == "x\n" })
	c.insert(0, "late:")
	eventually(t, "edit made", func() bool { return s.render() == "late:x\n" })
	time.Sleep(30 * time.Millisecond)
	if n := r.updates.Load(); n != 0 {
		t.Fatalf("handler called after Close: %d", n)
	}
	p2, err := s.AttachPeer(PeerHandler{})
	if err != nil {
		t.Fatalf("a new peer after Close: %v", err)
	}
	p2.Close()
}

func TestServerCloseClosesPeerFirstAndSavesItsEdits(t *testing.T) {
	s, file, _ := openWith(t, "x\n", func(o *Options) { o.WriteDelay = time.Hour })
	var calls atomic.Int32
	var after atomic.Bool
	c := dial(t, s)
	p, err := s.AttachPeer(PeerHandler{Update: func([]byte) {
		calls.Add(1)
		if after.Load() {
			t.Error("handler called after Close returned")
		}
	}})
	if err != nil {
		t.Fatal(err)
	}
	eventually(t, "synced", func() bool { return c.get() == "x\n" })
	c.insert(0, "s:")
	doc := crdt.New()
	if err := crdt.ApplyUpdateV1(doc, p.State(), nil); err != nil {
		t.Fatal(err)
	}
	doc.OnUpdate(func(u []byte, _ any) { _ = p.Apply(u) })
	text := doc.GetText("content")
	doc.Transact(func(txn *crdt.Transaction) { text.Insert(txn, 0, "p:", nil) })
	if err := s.Close(); err != nil {
		t.Fatal(err)
	}
	after.Store(true)
	if _, err := s.AttachPeer(PeerHandler{}); err == nil {
		t.Fatal("AttachPeer on a closed server succeeded")
	}
	if err := p.Apply(nil); err == nil {
		t.Fatal("Apply after Server.Close succeeded")
	}
	b, _ := os.ReadFile(file)
	if countOf(string(b), "p:") != 1 || countOf(string(b), "s:") != 1 {
		t.Fatalf("an edit is not in the final save: %q", b)
	}
	time.Sleep(30 * time.Millisecond)
}

// Two servers whose peers forward straight into each other's Apply, with
// edits on both: no deadlock, and the docs converge.
func TestPeerHandlersMayCallApplyWithoutDeadlock(t *testing.T) {
	a, _, _ := open(t, "seed\n")
	b, _, _ := open(t, "seed\n")
	// Both start from one history.
	var pa, pb *Peer
	var err error
	pa, err = a.AttachPeer(PeerHandler{
		Update:    func(u []byte) { _ = pb.Apply(u) },
		Awareness: func(u []byte) { _ = pb.ApplyAwareness(u) },
	})
	if err != nil {
		t.Fatal(err)
	}
	pb, err = b.AttachPeer(PeerHandler{
		Update:    func(u []byte) { _ = pa.Apply(u) },
		Awareness: func(u []byte) { _ = pa.ApplyAwareness(u) },
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := pb.Apply(pa.State()); err != nil {
		t.Fatal(err)
	}
	if err := pa.Apply(pb.State()); err != nil {
		t.Fatal(err)
	}
	ca, cb := dial(t, a), dial(t, b)
	eventually(t, "streams synced", func() bool { return ca.get() != "" && cb.get() != "" })
	done := make(chan struct{})
	go func() {
		defer close(done)
		var wg sync.WaitGroup
		for i := range 30 {
			wg.Add(2)
			go func() { defer wg.Done(); ca.insert(0, fmt.Sprintf("a%d;", i)) }()
			go func() { defer wg.Done(); cb.insert(0, fmt.Sprintf("b%d;", i)) }()
		}
		wg.Wait()
	}()
	select {
	case <-done:
	case <-time.After(20 * time.Second):
		t.Fatal("deadlock")
	}
	eventually(t, "servers converge", func() bool {
		x, y := a.render(), b.render()
		return x == y && countOf(x, ";") == 60
	})
	pa.Close()
	pb.Close()
}
