package session

import (
	"net/url"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/piconic-ai/pedit/internal/protocol"
	"github.com/piconic-ai/pedit/internal/protocol/prototest"
	"github.com/reearth/ygo/awareness"
	"github.com/reearth/ygo/crdt"
)

// joinWith joins the room of shareURL by the link with this fragment, as the
// awareness client id (0: any).
func joinWith(t *testing.T, relay *prototest.Relay, shareURL, fragment string, id uint64) *guest {
	t.Helper()
	u, err := url.Parse(shareURL)
	if err != nil {
		t.Fatal(err)
	}
	link, err := protocol.ParseFragment(fragment)
	if err != nil {
		t.Fatal(err)
	}
	doc := crdt.New()
	if id == 0 {
		id = uint64(doc.ClientID())
	}
	aw := awareness.New(id)
	aw.SetLocalState(map[string]any{"name": "guest"})
	c, err := protocol.NewClient(protocol.ClientOptions{
		URL: "ws://guest", RoomID: strings.TrimPrefix(u.Path, "/r/"), Link: &link, Doc: doc, Awareness: aw, Dial: relay.Dial,
	})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(c.Destroy)
	c.Connect()
	return &guest{Client: c, doc: doc, text: doc.GetText("content"), aw: aw}
}

func readFragment(f *fixture) string {
	_, _, _, read := f.session.Fragments()
	return read
}

// sees waits until g holds a state for id and tells what access it has.
func (g *guest) sees(t *testing.T, id uint64, what string) protocol.Access {
	t.Helper()
	prototest.WaitFor(t, wait, func() bool { _, ok := g.aw.GetStates()[id]; return ok }, what)
	access, _ := g.AccessOf(id)
	return access
}

const pageID = 4242

func pageUpdate(clock uint64, name string) []byte {
	return protocol.EncodeState(pageID, clock, []byte(`{"name":"`+name+`"}`))
}

func TestAnEditPageIsSeenAsAnEditor(t *testing.T) {
	f, _ := shareSource(t, "x\n", setupOpts{})
	g := joinAsGuest(t, f.relay, f.session.URL)
	prototest.WaitFor(t, wait, func() bool { return g.String() == "x\n" }, "the text")
	if err := f.session.FromSourceAwareness(pageID, false, pageUpdate(1, "ann")); err != nil {
		t.Fatal(err)
	}
	if got := g.sees(t, pageID, "the page"); got != protocol.AccessEdit {
		t.Fatalf("access = %s", got)
	}
	if name := g.aw.GetStates()[pageID].State["name"]; name != "ann" {
		t.Fatalf("state = %v", name)
	}
}

func TestAReadPageIsNeverSeenAboveRead(t *testing.T) {
	f, _ := shareSource(t, "x\n", setupOpts{})
	g := joinAsGuest(t, f.relay, f.session.URL)
	prototest.WaitFor(t, wait, func() bool { return g.String() == "x\n" }, "the text")
	if err := f.session.FromSourceAwareness(pageID, true, pageUpdate(1, "rita")); err != nil {
		t.Fatal(err)
	}
	if got := g.sees(t, pageID, "the page"); got != protocol.AccessRead {
		t.Fatalf("access = %s", got)
	}
	name := func() any { return g.aw.GetStates()[pageID].State["name"] }
	// A renewal and a later update, from a page whose clock is behind.
	f.session.renewPages()
	if err := f.session.FromSourceAwareness(pageID, true, pageUpdate(1, "rita b")); err != nil {
		t.Fatal(err)
	}
	prototest.WaitFor(t, wait, func() bool { return name() == "rita b" }, "the later state")
	if got, _ := g.AccessOf(pageID); got != protocol.AccessRead {
		t.Fatalf("access after renewal and update = %s", got)
	}
}

func TestAPageStaysWithinWhatPeersTake(t *testing.T) {
	f, _ := shareSource(t, "x\n", setupOpts{})
	host := uint64(f.session.Doc.ClientID())
	if err := f.session.FromSourceAwareness(pageID, true, pageUpdate(1<<33, "far")); err == nil {
		t.Fatal("a read clock past what peers take was sent")
	}
	if err := f.session.FromSourceAwareness(pageID, false, protocol.EncodeState(pageID+1, 1, []byte("{}"))); err == nil {
		t.Fatal("an update of another client was sent")
	}
	if err := f.session.FromSourceAwareness(host, false, protocol.EncodeState(host, 1, []byte("{}"))); err == nil {
		t.Fatal("the host's own state was sent as a page's")
	}
}

func TestARemovedPageDisappearsForGuests(t *testing.T) {
	f, _ := shareSource(t, "x\n", setupOpts{})
	g := joinAsGuest(t, f.relay, f.session.URL)
	// Peers keep the highest access an ID spoke with, so each page has its own.
	for i, reader := range []bool{false, true} {
		id := uint64(pageID + i)
		if err := f.session.FromSourceAwareness(id, reader, protocol.EncodeState(id, 1, []byte(`{"name":"p"}`))); err != nil {
			t.Fatal(err)
		}
		g.sees(t, id, "the page")
		if err := f.session.FromSourceAwareness(id, reader, protocol.EncodeState(id, 1, []byte("null"))); err != nil {
			t.Fatal(err)
		}
		prototest.WaitFor(t, wait, func() bool { _, ok := g.aw.GetStates()[id]; return !ok }, "the page to go")
		f.session.renewPages() // a removed page is not renewed
		time.Sleep(50 * time.Millisecond)
		if _, ok := g.aw.GetStates()[id]; ok {
			t.Fatal("a removed page came back")
		}
	}
}

func TestANewcomerHearsThePagesWithoutWaitingForARenewal(t *testing.T) {
	f, _ := shareSource(t, "x\n", setupOpts{})
	if err := f.session.FromSourceAwareness(pageID, true, pageUpdate(1, "rita")); err != nil {
		t.Fatal(err)
	}
	g := joinAsGuest(t, f.relay, f.session.URL)
	if got := g.sees(t, pageID, "the page"); got != protocol.AccessRead {
		t.Fatalf("access = %s", got)
	}
}

type roomStates struct {
	mu      sync.Mutex
	states  map[uint64]protocol.Access
	removed map[uint64]protocol.Access
}

func (r *roomStates) add(id uint64, access protocol.Access, update []byte) {
	_, _, state, err := protocol.ParseState(update)
	r.mu.Lock()
	defer r.mu.Unlock()
	if err != nil {
		return
	}
	if r.states == nil {
		r.states, r.removed = map[uint64]protocol.Access{}, map[uint64]protocol.Access{}
	}
	if string(state) == "null" {
		r.removed[id] = access
		return
	}
	r.states[id] = access
}

func (r *roomStates) has(id uint64, removal bool) (protocol.Access, bool) {
	r.mu.Lock()
	defer r.mu.Unlock()
	m := r.states
	if removal {
		m = r.removed
	}
	a, ok := m[id]
	return a, ok
}

func TestTheRoomsStatesReachTheSourceWithTheirAccess(t *testing.T) {
	var states roomStates
	f, _ := shareSource(t, "x\n", setupOpts{onRoomAwareness: states.add})
	if err := f.session.FromSourceAwareness(pageID, false, pageUpdate(1, "ann")); err != nil {
		t.Fatal(err)
	}
	editor := joinAsGuest(t, f.relay, f.session.URL)
	reader := joinWith(t, f.relay, f.session.URL, readFragment(f), 0)
	// A guest that takes a page's ID stands for the room echoing it back.
	joinWith(t, f.relay, f.session.URL, readFragment(f), pageID)
	editorID, readerID := editor.aw.ClientID(), reader.aw.ClientID()
	prototest.WaitFor(t, wait, func() bool {
		a, ok := states.has(editorID, false)
		b, ok2 := states.has(readerID, false)
		return ok && ok2 && a == protocol.AccessEdit && b == protocol.AccessRead
	}, "both guests' states")
	time.Sleep(100 * time.Millisecond)
	if _, ok := states.has(pageID, false); ok {
		t.Fatal("the source's own page was handed back")
	}
	if _, ok := states.has(uint64(f.session.Doc.ClientID()), false); ok {
		t.Fatal("the host's state was handed to the source")
	}

	// A guest that leaves is removed, at the access it had.
	reader.Destroy()
	prototest.WaitFor(t, wait, func() bool { a, ok := states.has(readerID, true); return ok && a == protocol.AccessRead }, "the removal")
}

func TestPagesAreNotListedAmongThePeople(t *testing.T) {
	var mu sync.Mutex
	var people []string
	f, _ := shareSource(t, "x\n", setupOpts{onPeople: func(p []string) { mu.Lock(); people = p; mu.Unlock() }})
	joinAsGuest(t, f.relay, f.session.URL)
	if err := f.session.FromSourceAwareness(pageID, false, pageUpdate(1, "ann")); err != nil {
		t.Fatal(err)
	}
	prototest.WaitFor(t, wait, func() bool { mu.Lock(); defer mu.Unlock(); return len(people) == 1 }, "the guest")
	time.Sleep(100 * time.Millisecond)
	f.session.reportPeople(func(p []string) {
		if len(p) != 1 {
			t.Errorf("people = %v", p)
		}
	})
}

// Peers keep the clock of a removed state, so a page that comes back with
// the clock of its own, behind ours, must still be applied.
func TestAPageThatComesBackAtALowerClockIsApplied(t *testing.T) {
	f, _ := shareSource(t, "x\n", setupOpts{})
	g := joinAsGuest(t, f.relay, f.session.URL)
	if err := f.session.FromSourceAwareness(pageID, true, pageUpdate(1, "rita")); err != nil {
		t.Fatal(err)
	}
	g.sees(t, pageID, "the page")
	for range 5 {
		f.session.renewPages()
	}
	if err := f.session.FromSourceAwareness(pageID, true, protocol.EncodeState(pageID, 2, []byte("null"))); err != nil {
		t.Fatal(err)
	}
	prototest.WaitFor(t, wait, func() bool { _, ok := g.aw.GetStates()[pageID]; return !ok }, "the page to go")
	if err := f.session.FromSourceAwareness(pageID, true, pageUpdate(1, "rita again")); err != nil {
		t.Fatal(err)
	}
	prototest.WaitFor(t, wait, func() bool {
		st, ok := g.aw.GetStates()[pageID]
		return ok && st.State["name"] == "rita again"
	}, "the page to come back")
}

func TestGoneClocksAreForgottenInTime(t *testing.T) {
	f, _ := shareSource(t, "x\n", setupOpts{})
	s := f.session
	_ = s.FromSourceAwareness(pageID, true, pageUpdate(1, "a"))
	_ = s.FromSourceAwareness(pageID, true, protocol.EncodeState(pageID, 2, []byte("null")))
	s.srcAw.mu.Lock()
	s.srcAw.pages[pageID].goneAt = time.Now().Add(-goneFor - time.Second)
	s.srcAw.mu.Unlock()
	s.renewPages()
	s.srcAw.mu.Lock()
	defer s.srcAw.mu.Unlock()
	if len(s.srcAw.pages) != 0 {
		t.Fatal("a clock outlived its tombstone")
	}
}

// Clients that come and go cannot make the host renew every page for each.
func TestNewcomersCauseBoundedBatches(t *testing.T) {
	f, _ := shareSource(t, "x\n", setupOpts{})
	s := f.session
	s.srcAw.mu.Lock()
	s.srcAw.every = 300 * time.Millisecond
	s.srcAw.last = time.Time{}
	before := s.srcAw.batches
	s.srcAw.mu.Unlock()
	batches := func() int { s.srcAw.mu.Lock(); defer s.srcAw.mu.Unlock(); return s.srcAw.batches - before }
	for i := range 200 {
		s.roomAwareness(awareness.UpdateEvent{Added: []uint64{uint64(9000 + i)}, Origin: s.Client})
	}
	if n := batches(); n != 1 {
		t.Fatalf("the first newcomer was served with %d batches", n)
	}
	prototest.WaitFor(t, wait, func() bool { return batches() == 2 }, "the trailing batch")
	time.Sleep(400 * time.Millisecond)
	if n := batches(); n != 2 {
		t.Fatalf("a burst of 200 newcomers caused %d batches", n)
	}
}
