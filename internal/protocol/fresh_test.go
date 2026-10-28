package protocol_test

import (
	"slices"
	"sync"
	"testing"
	"time"

	"github.com/piconic-ai/pedit/internal/protocol"
	"github.com/piconic-ai/pedit/internal/protocol/prototest"
	"github.com/reearth/ygo/awareness"
	"github.com/reearth/ygo/crdt"
)

func TestFreshMessagesRoundTrip(t *testing.T) {
	answer := protocol.Nonce{9}
	for _, m := range []protocol.FreshMessage{{Nonce: protocol.Nonce{1}}, {Nonce: protocol.Nonce{2}, Answer: &answer}} {
		got, err := protocol.DecodeFresh(protocol.EncodeFresh(m))
		if err != nil || got.Nonce != m.Nonce || (got.Answer == nil) != (m.Answer == nil) || (m.Answer != nil && *got.Answer != *m.Answer) {
			t.Fatalf("round trip of %+v = %+v, %v", m, got, err)
		}
	}
	for _, n := range []int{0, 15, 17, 31, 33} {
		if _, err := protocol.DecodeFresh(make([]byte, n)); err == nil {
			t.Errorf("%d bytes decoded", n)
		}
	}
}

// From the security review of #122: someone with a read link keeps an
// editor's frame and has it sent again to a peer that has just joined, which
// has no counter from that editor yet. The newcomer takes the editor's frames
// only from its answer to the newcomer's nonce on.
func TestNewcomersDropFramesKeptFromBefore(t *testing.T) {
	relay := prototest.NewRelay(false)
	key := protocol.GenerateKey()
	host := join(t, relay, key, joinOpts{})
	prototest.WaitFor(t, wait, func() bool { return host.Status() == protocol.StatusConnected }, "host connected")
	before := len(relay.Frames())
	if err := host.SendCanvas(protocol.CanvasMessage{Kind: protocol.CanvasEdit, ID: "old", Base: "{}", Next: "{}"}); err != nil {
		t.Fatal(err)
	}
	prototest.WaitFor(t, wait, func() bool { return len(relay.Frames()) == before+1 }, "the old edit sent")
	kept := relay.Frames()[before]

	conn, err := relay.Dial(t.Context(), "ws://test", nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = conn.Close() })
	var mu sync.Mutex
	var edits []string
	newcomer := join(t, relay, key, joinOpts{
		link: lowerLink(t, key, protocol.AccessRead),
		onCanvas: func(m protocol.CanvasMessage) {
			mu.Lock()
			defer mu.Unlock()
			edits = append(edits, m.ID)
		},
	})
	// Sent again before and after the newcomer heard from the host.
	stop := make(chan struct{})
	done := make(chan struct{})
	go func() {
		defer close(done)
		for {
			select {
			case <-stop:
				return
			case <-time.After(time.Millisecond):
				_ = conn.Write(t.Context(), kept)
			}
		}
	}()
	prototest.WaitFor(t, wait, func() bool { return newcomer.Status() == protocol.StatusConnected }, "newcomer connected")
	prototest.WaitFor(t, wait, func() bool { return newcomer.String() == host.String() && len(relay.Frames()) > before+20 }, "replays during the handshake")
	if err := host.SendCanvas(protocol.CanvasMessage{Kind: protocol.CanvasEdit, ID: "new", Base: "{}", Next: "{}"}); err != nil {
		t.Fatal(err)
	}
	prototest.WaitFor(t, wait, func() bool { mu.Lock(); defer mu.Unlock(); return len(edits) > 0 }, "the new edit")
	close(stop)
	<-done
	mu.Lock()
	defer mu.Unlock()
	if !slices.Equal(edits, []string{"new"}) {
		t.Fatalf("edits = %v", edits)
	}
}

// Only an answer to the nonce of the peer's own connection shows a signer
// is live: one to another nonce, or none, does not.
func TestOnlyAnAnswerToTheCurrentNonceVouches(t *testing.T) {
	relay := prototest.NewRelay(false)
	key := protocol.GenerateKey()
	var mu sync.Mutex
	var edits []string
	p := join(t, relay, key, joinOpts{onCanvas: func(m protocol.CanvasMessage) {
		mu.Lock()
		defer mu.Unlock()
		edits = append(edits, m.ID)
	}})
	prototest.WaitFor(t, wait, func() bool { return p.Status() == protocol.StatusConnected }, "connected")
	conn, err := relay.Dial(t.Context(), "ws://test", nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = conn.Close() })
	c := sealer(t, key)
	edit := func(id string) []byte {
		payload, _ := protocol.EncodeCanvas(protocol.CanvasMessage{Kind: protocol.CanvasEdit, ID: id, Base: "{}", Next: "{}"})
		return protocol.EncodeMessage(protocol.MessageCanvas, payload)
	}
	other := protocol.Nonce{1}
	wrong := protocol.EncodeMessage(protocol.MessageFresh, protocol.EncodeFresh(protocol.FreshMessage{Answer: &other}))
	for i, frame := range [][]byte{
		c(protocol.Sender{1}, 1, edit("before any answer")),
		c(protocol.Sender{1}, 2, wrong),
		c(protocol.Sender{1}, 3, edit("after another nonce's")),
		c(protocol.Sender{1}, 4, answer(p.Client)),
		c(protocol.Sender{1}, 5, edit("after the answer")),
	} {
		if err := conn.Write(t.Context(), frame); err != nil {
			t.Fatalf("frame %d: %v", i, err)
		}
	}
	prototest.WaitFor(t, wait, func() bool { mu.Lock(); defer mu.Unlock(); return len(edits) > 0 }, "the edit after the answer")
	mu.Lock()
	defer mu.Unlock()
	if !slices.Equal(edits, []string{"after the answer"}) {
		t.Fatalf("edits = %v", edits)
	}
}

// What a newcomer sends once right after connecting, before peers know it is
// live, still reaches them: the newcomer holds it until it settles.
func TestWhatIsSentOnceRightAfterConnectingArrives(t *testing.T) {
	relay := prototest.NewRelay(false)
	key := protocol.GenerateKey()
	var mu sync.Mutex
	var edits []string
	host := join(t, relay, key, joinOpts{onCanvas: func(m protocol.CanvasMessage) {
		mu.Lock()
		defer mu.Unlock()
		edits = append(edits, m.ID)
	}})
	prototest.WaitFor(t, wait, func() bool { return host.Status() == protocol.StatusConnected }, "host connected")
	raw, _ := protocol.DecodeKey(key)
	doc := crdt.New()
	var newcomer *protocol.Client
	newcomer, err := protocol.NewClient(protocol.ClientOptions{
		URL: "ws://test", Key: raw, Doc: doc, Awareness: awareness.New(uint64(doc.ClientID())), Dial: relay.Dial,
		// As soon as it is connected, before it heard from anyone.
		OnStatus: func(s protocol.Status) {
			if s != protocol.StatusConnected {
				return
			}
			for _, id := range []string{"first", "second"} {
				_ = newcomer.SendCanvas(protocol.CanvasMessage{Kind: protocol.CanvasEdit, ID: id, Base: "{}", Next: "{}"})
			}
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(newcomer.Destroy)
	newcomer.Connect()
	prototest.WaitFor(t, wait, func() bool { mu.Lock(); defer mu.Unlock(); return len(edits) == 2 }, "both edits at the host")
	mu.Lock()
	defer mu.Unlock()
	if !slices.Equal(edits, []string{"first", "second"}) {
		t.Fatalf("edits = %v", edits)
	}
}

// From review: a signer answers the nonce of every connection, a
// reconnection too, or frames it sent while the peer was away could be sent
// again to it.
func TestSignersShowTheyAreLiveOnEveryConnection(t *testing.T) {
	relay := prototest.NewRelay(false)
	key := protocol.GenerateKey()
	var mu sync.Mutex
	var edits []string
	p := join(t, relay, key, joinOpts{onCanvas: func(m protocol.CanvasMessage) {
		mu.Lock()
		defer mu.Unlock()
		edits = append(edits, m.ID)
	}})
	prototest.WaitFor(t, wait, func() bool { return p.Status() == protocol.StatusConnected }, "connected")
	c := sealer(t, key)
	edit := func(id string) []byte {
		payload, _ := protocol.EncodeCanvas(protocol.CanvasMessage{Kind: protocol.CanvasEdit, ID: id, Base: "{}", Next: "{}"})
		return protocol.EncodeMessage(protocol.MessageCanvas, payload)
	}
	write := func(frames ...[]byte) {
		conn, err := relay.Dial(t.Context(), "ws://test", nil)
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { _ = conn.Close() })
		for i, frame := range frames {
			if err := conn.Write(t.Context(), frame); err != nil {
				t.Fatalf("frame %d: %v", i, err)
			}
		}
	}
	write(c(protocol.Sender{1}, 1, answer(p.Client)), c(protocol.Sender{1}, 2, edit("before")))
	prototest.WaitFor(t, wait, func() bool { mu.Lock(); defer mu.Unlock(); return len(edits) == 1 }, "the edit before")

	// The signer goes on while p is away; someone keeps its frame.
	kept := c(protocol.Sender{1}, 3, edit("while away"))
	nonce := p.Nonce()
	relay.DropAll()
	prototest.WaitFor(t, wait, func() bool { return p.Status() == protocol.StatusConnected && p.Nonce() != nonce }, "reconnected")
	write(kept, c(protocol.Sender{1}, 4, answer(p.Client)), kept, c(protocol.Sender{1}, 5, edit("after")))
	prototest.WaitFor(t, wait, func() bool { mu.Lock(); defer mu.Unlock(); return len(edits) == 2 }, "the edit after")
	mu.Lock()
	defer mu.Unlock()
	if !slices.Equal(edits, []string{"before", "after"}) {
		t.Fatalf("edits = %v", edits)
	}
}

// From review: Destroy held the Client's lock while waiting for the one
// held messages are sent under, and sending takes the Client's lock.
func TestDestroyWhileSendingWhatWasHeld(t *testing.T) {
	relay := prototest.NewRelay(false)
	key := protocol.GenerateKey()
	for range 200 {
		p := join(t, relay, key, joinOpts{})
		prototest.WaitFor(t, wait, func() bool { return p.Status() == protocol.StatusConnected }, "connected")
		for range 20 {
			_ = p.SendCanvas(protocol.CanvasMessage{Kind: protocol.CanvasEdit, ID: "x", Base: "{}", Next: "{}"})
		}
		done := make(chan struct{})
		go func() {
			p.Settle()
			close(done)
		}()
		destroyed := make(chan struct{})
		go func() {
			p.Destroy()
			close(destroyed)
		}()
		for _, ch := range []chan struct{}{done, destroyed} {
			select {
			case <-ch:
			case <-time.After(5 * time.Second):
				t.Fatal("Destroy and sending what was held wait for each other")
			}
		}
	}
}
