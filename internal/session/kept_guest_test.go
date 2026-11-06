package session

import (
	"context"
	"errors"
	"fmt"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/piconic-ai/pedit/internal/canvas"
	"github.com/piconic-ai/pedit/internal/meta"
	"github.com/piconic-ai/pedit/internal/protocol"
	"github.com/piconic-ai/pedit/internal/protocol/prototest"
	"github.com/reearth/ygo/crdt"
)

const keptRoomID = "AAAAAAAAAAAAAAAAAAAAAA"

// keptRelay is a relay keeping a room whose host is away: it says so to
// each connection, replays the snapshot and the log, and logs the entries
// editors send, as the Worker does (docs/design/rooms-away.md).
type keptRelay struct {
	t      *testing.T
	keys   *protocol.RoomKeys
	relay  *prototest.Scripted
	bundle []byte

	mu  sync.Mutex
	log [][]byte
	// hold keeps the entries editors send from being logged; live makes the
	// next connections those of a room whose host is back.
	hold, live bool
	replayEnd  <-chan struct{}
}

func newKeptRelay(t *testing.T) *keptRelay {
	t.Helper()
	content := crdt.New()
	text := content.GetText("content")
	content.Transact(func(txn *crdt.Transaction) { text.Insert(txn, 0, "hello world!\n", nil) })
	return newKeptRelayOf(t, "notes.md", content, "hello")
}

// newKeptRelayOf keeps a room whose first file, name, is content, with a
// saved thread whose quote is quote (a node id for a canvas).
func newKeptRelayOf(t *testing.T, name string, content *crdt.Doc, quote string) *keptRelay {
	t.Helper()
	raw, err := protocol.DecodeKey(protocol.GenerateKey())
	if err != nil {
		t.Fatal(err)
	}
	keys, err := protocol.EditKeys(raw, keptRoomID)
	if err != nil {
		t.Fatal(err)
	}
	comments := crdt.New()
	anchor := meta.Anchor{Type: meta.AnchorText, Text: &meta.Selector{Exact: quote, Suffix: " world", Offset: 0}}
	tracker := meta.NewTracker(content)
	if isCanvas(name) {
		anchor, tracker = meta.Anchor{Type: meta.AnchorNode, ID: quote}, nil
	}
	saved := &meta.File{Path: name, Comments: map[string]meta.Thread{"c0": {
		Anchor: anchor, Quote: quote, Messages: map[string]meta.Message{"m0": {Author: "Host", Time: "2026-10-20T00:00:00Z", Body: "Saved before"}},
	}}}
	meta.Load(comments, saved, tracker)
	bundle, err := protocol.SealKeptBundle(keys, []protocol.KeptFileSnapshot{
		{ID: 0, Path: name, Update: crdt.EncodeStateAsUpdateV1(content, nil)},
		{ID: 1024, Path: protocol.MetaPath(name), Update: crdt.EncodeStateAsUpdateV1(comments, nil)},
	})
	if err != nil {
		t.Fatal(err)
	}
	r := &keptRelay{t: t, keys: keys, relay: &prototest.Scripted{}, bundle: bundle}
	r.relay.OnDial = func(c *prototest.ScriptConn) { r.dialed(c) }
	return r
}

func (r *keptRelay) dialed(c *prototest.ScriptConn) {
	r.mu.Lock()
	log := append([][]byte{}, r.log...)
	live := r.live
	replayEnd := r.replayEnd
	r.mu.Unlock()
	if live {
		c.Push(protocol.WithKind(protocol.KindLive, []byte{0}))
		return
	}
	c.Say(fmt.Sprintf("kept %d", time.Now().Add(time.Hour).UnixMilli()))
	c.Push(protocol.WithKind(protocol.KindReplay, r.bundle))
	for i, entry := range log {
		c.Push(protocol.EncodeLogged(uint64(i+1), entry))
	}
	go func() {
		if replayEnd != nil {
			<-replayEnd
		}
		c.Push(protocol.EncodeLogEnd(uint64(len(log))))
		for m := range c.Sent {
			r.mu.Lock()
			hold := r.hold
			r.mu.Unlock()
			if m[0] == protocol.KindEntry && !hold {
				r.append(c, m[1:])
			}
		}
	}()
}

// append logs an entry and sends it to the connection, as kind 4.
func (r *keptRelay) append(c *prototest.ScriptConn, entry []byte) {
	r.mu.Lock()
	r.log = append(r.log, entry)
	id := uint64(len(r.log))
	r.mu.Unlock()
	c.Push(protocol.EncodeLogged(id, entry))
}

// entries opens the logged entries.
func (r *keptRelay) entries() (ids []uint32, updates [][]byte) {
	r.mu.Lock()
	defer r.mu.Unlock()
	for _, e := range r.log {
		id, update, err := protocol.OpenKeptFileUpdate(r.keys, e)
		if err != nil {
			r.t.Fatal(err)
		}
		ids, updates = append(ids, id), append(updates, update)
	}
	return ids, updates
}

func (r *keptRelay) link(access protocol.Access) string {
	return "http://relay.test/r/" + keptRoomID + "#" + r.keys.Fragments[access]
}

func (r *keptRelay) join(t *testing.T, access protocol.Access, on func(CommentChange)) *Session {
	t.Helper()
	s, err := Join(context.Background(), JoinOptions{URL: r.link(access), Name: "tate-pm", Dial: r.relay.Dial, dir: t.TempDir(), WriteDelay: 10 * time.Millisecond, Watch: true, OnComments: on})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = s.Stop() })
	return s
}

func TestAGuestAnswersCommentsWhileTheHostIsAway(t *testing.T) {
	r := newKeptRelay(t)
	var got changesOf
	g := r.join(t, protocol.AccessEdit, got.add)
	if g.Client.Status() != protocol.StatusKept {
		t.Fatalf("status %s", g.Client.Status())
	}
	if text := readFile(t, g.File()); text != "hello world!\n" {
		t.Fatalf("copy %q", text)
	}
	if files := g.Files(); len(files) != 1 || files[0].Path != "notes.md" {
		t.Fatalf("files %+v", files)
	}
	c := g.Comments()
	if len(c) != 1 || c[0].File != "notes.md" || len(c[0].Threads) != 1 || c[0].Threads[0].Messages[0].Body != "Saved before" {
		t.Fatalf("comments %+v", c)
	}

	res, err := g.Reply("", "c0", "r1", "From the agent")
	if err != nil || !res.Delivered {
		t.Fatalf("%+v %v", res, err)
	}
	if res, err := g.Resolve("", "c0", true); err != nil || !res.Delivered {
		t.Fatalf("resolve %+v %v", res, err)
	}
	// What the host takes in on its return: the entries, checked as the
	// host checks them.
	ids, updates := r.entries()
	if len(ids) != 2 || ids[0] != 1024 || ids[1] != 1024 {
		t.Fatalf("entries for %v", ids)
	}
	hostComments := crdt.New()
	_, bundled := r.bundled(t)
	if err := crdt.ApplyUpdateV1(hostComments, bundled, nil); err != nil {
		t.Fatal(err)
	}
	for _, u := range updates {
		if err := meta.CheckUpdate(hostComments, u); err != nil {
			t.Fatalf("the host would refuse: %v", err)
		}
		if err := crdt.ApplyUpdateV1(hostComments, u, nil); err != nil {
			t.Fatal(err)
		}
	}
	th := meta.ShownThreads(hostComments)
	if len(th) != 1 || !th[0].Resolved || len(th[0].Messages) != 2 || th[0].Messages[1].Author != "tate-pm" {
		t.Fatalf("at the host %+v", th)
	}

	// Another guest's reply, logged by the relay, reaches this one as an event.
	other := crdt.New()
	if err := crdt.ApplyUpdateV1(other, crdt.EncodeStateAsUpdateV1(hostComments, nil), nil); err != nil {
		t.Fatal(err)
	}
	u, err := meta.ReplyUpdate(other, "c0", "x1", "Ada", "2026-10-22T00:00:00.000Z", "From a browser")
	if err != nil {
		t.Fatal(err)
	}
	entry, err := protocol.SealKeptFileUpdate(r.keys, 1024, u)
	if err != nil {
		t.Fatal(err)
	}
	r.append(r.relay.Conns()[len(r.relay.Conns())-1], entry)
	prototest.WaitFor(t, wait, func() bool {
		for _, c := range got.list() {
			if c == "comment notes.md c0 x1 From a browser" {
				return true
			}
		}
		return false
	}, "the browser's reply as an event")
	for _, c := range got.list() {
		if strings.Contains(c, "Saved before") {
			t.Fatalf("the snapshot's thread is reported: %q", got.list())
		}
	}
}

// bundled is the comments doc of the relay's snapshot.
func (r *keptRelay) bundled(t *testing.T) (uint32, []byte) {
	t.Helper()
	files, err := protocol.OpenKeptBundle(r.keys, r.bundle)
	if err != nil {
		t.Fatal(err)
	}
	for _, f := range files {
		if f.ID == 1024 {
			return f.ID, f.Update
		}
	}
	t.Fatal("no comments in the bundle")
	return 0, nil
}

func TestACommentLinkWaitsForTheHost(t *testing.T) {
	r := newKeptRelay(t)
	g := r.join(t, protocol.AccessComment, nil)
	if _, err := g.Reply("", "c0", "r1", "Too early"); !errors.Is(err, ErrHostAway) {
		t.Fatal(err)
	}
	if ids, _ := r.entries(); len(ids) != 0 {
		t.Fatalf("a comment link sent %v", ids)
	}
}

func TestAGuestLiveWhenTheRoomIsKeptJoinsAgain(t *testing.T) {
	for _, delayReplayEnd := range []bool{false, true} {
		t.Run(fmt.Sprintf("delay-replay-end=%t", delayReplayEnd), func(t *testing.T) {
			r := newKeptRelay(t)
			g := r.join(t, protocol.AccessEdit, nil)
			if res, err := g.Reply("", "c0", "r1", "Logged"); err != nil || !res.Delivered {
				t.Fatalf("reply %+v %v", res, err)
			}
			replayEnd := make(chan struct{})
			r.mu.Lock()
			if delayReplayEnd {
				r.replayEnd = replayEnd
			}
			r.mu.Unlock()
			t.Cleanup(func() {
				select {
				case <-replayEnd:
				default:
					close(replayEnd)
				}
			})
			conn := r.relay.Conns()[0]
			// The room was live, then kept again: the guest connects anew, with
			// what it holds, and is replayed only what came after.
			conn.Say("host back")
			prototest.WaitFor(t, wait, func() bool { return g.Client.Status() == protocol.StatusConnected }, "the host back")
			conn.Say(fmt.Sprintf("kept %d", time.Now().Add(time.Hour).UnixMilli()))
			prototest.WaitFor(t, wait, func() bool { return len(r.relay.Conns()) == 2 }, "a new connection")
			prototest.WaitFor(t, wait, func() bool { return g.Client.Status() == protocol.StatusKept }, "kept again")
			done := make(chan WriteResult, 1)
			go func() {
				res, err := g.Resolve("", "c0", true)
				if err != nil {
					t.Error(err)
				}
				done <- res
			}()
			prototest.WaitFor(t, wait, func() bool {
				c := g.Comments()
				return len(c) == 1 && len(c[0].Threads) == 1 && c[0].Threads[0].Resolved
			}, "the resolve written locally")
			close(replayEnd)
			if res := <-done; !res.Delivered {
				t.Fatalf("%+v", res)
			}
			ids, updates := r.entries()
			if len(ids) < 2 {
				t.Fatalf("entries %v", ids)
			}
			hostComments := crdt.New()
			defer hostComments.Destroy()
			_, bundled := r.bundled(t)
			if err := crdt.ApplyUpdateV1(hostComments, bundled, nil); err != nil {
				t.Fatal(err)
			}
			for i, update := range updates {
				if ids[i] != 1024 {
					t.Fatalf("entry for %d", ids[i])
				}
				if err := meta.CheckUpdate(hostComments, update); err != nil {
					t.Fatalf("the host would refuse: %v", err)
				}
				if err := crdt.ApplyUpdateV1(hostComments, update, nil); err != nil {
					t.Fatal(err)
				}
			}
			threads := meta.ShownThreads(hostComments)
			if len(threads) != 1 || !threads[0].Resolved || len(threads[0].Messages) != 2 || threads[0].Messages[1].ID != "r1" || threads[0].Messages[1].Body != "Logged" {
				t.Fatalf("at the host %+v", threads)
			}
		})
	}
}

func TestTheHostBackBeforeTheRelayLoggedAReplyIsNotDelivery(t *testing.T) {
	oldWait, oldEvery := deliveryWait, probeEvery
	deliveryWait, probeEvery = 400*time.Millisecond, 50*time.Millisecond
	t.Cleanup(func() { deliveryWait, probeEvery = oldWait, oldEvery })
	r := newKeptRelay(t)
	g := r.join(t, protocol.AccessEdit, nil)
	r.mu.Lock()
	r.hold = true
	r.mu.Unlock()
	done := make(chan WriteResult, 1)
	go func() {
		res, _ := g.Reply("", "c0", "r1", "Not logged")
		done <- res
	}()
	time.Sleep(100 * time.Millisecond)
	// The host comes back; nobody here answers for it.
	r.relay.Conns()[0].Say("host back")
	if res := <-done; res.Delivered {
		t.Fatal("a reply the relay never logged, and no host has, counted as delivered")
	}
}

func TestALiveReconnectDropsWhatTheGuestHeldOfTheKeptRoom(t *testing.T) {
	r := newKeptRelay(t)
	g := r.join(t, protocol.AccessEdit, nil)
	if _, err := g.Reply("", "c0", "r1", "Logged"); err != nil {
		t.Fatal(err)
	}
	if _, held := g.kept.cursor(); !held {
		t.Fatal("no cursor after the replay")
	}
	r.mu.Lock()
	r.live = true
	r.mu.Unlock()
	// The connection drops; the host is back when the guest reconnects.
	r.relay.Conns()[0].CloseWith(1006)
	prototest.WaitFor(t, 5*time.Second, func() bool { _, held := g.kept.cursor(); return !held && len(r.relay.Conns()) == 2 }, "the kept baseline dropped")
	if has, held, _ := g.kept.relayHas(1024, crdt.New()); has || held {
		t.Fatal("the relay's copies stayed")
	}
}

func TestAGuestJoinsAKeptCanvasRoom(t *testing.T) {
	parsed, err := canvas.Parse([]byte(board))
	if err != nil {
		t.Fatal(err)
	}
	content := crdt.New()
	canvas.Apply(content, canvas.Canvas{}, parsed.Canvas, nil)
	r := newKeptRelayOf(t, "board.canvas", content, "a1")
	g := r.join(t, protocol.AccessEdit, nil)
	if filepath.Base(g.File()) != "00-board.json" || !strings.Contains(readFile(t, g.File()), `"Hello"`) {
		t.Fatalf("copy %s: %q", g.File(), readFile(t, g.File()))
	}
	if c := g.Comments(); len(c) != 1 || c[0].File != "board.canvas" || c[0].Threads[0].Node != "a1" {
		t.Fatalf("comments %+v", c)
	}
	if res, err := g.Reply("", "c0", "r1", "Seen while away."); err != nil || !res.Delivered {
		t.Fatalf("%+v %v", res, err)
	}
	if ids, _ := r.entries(); len(ids) != 1 || ids[0] != 1024 {
		t.Fatalf("entries %v", ids)
	}
}
