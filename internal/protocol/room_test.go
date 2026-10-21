package protocol_test

import (
	"errors"
	"fmt"
	"net/http"
	"reflect"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/piconic-ai/pedit/internal/protocol"
	"github.com/piconic-ai/pedit/internal/protocol/prototest"
	"github.com/reearth/ygo/awareness"
	"github.com/reearth/ygo/crdt"
)

const wait = 3 * time.Second

type peer struct {
	*protocol.Client
	doc  *crdt.Doc
	aw   *awareness.Awareness
	text *crdt.YText
}

func (p *peer) String() string { return p.text.ToString() }

func (p *peer) insert(index int, s string) {
	p.doc.Transact(func(txn *crdt.Transaction) { p.text.Insert(txn, index, s, nil) })
}

type joinOpts struct {
	init         string
	state        map[string]any
	header       http.Header
	onError      func(error)
	onAttachment func(protocol.Attachment)
	onCanvas     func(protocol.CanvasMessage)
	onSynced     func()
	busyBackoff  time.Duration
	onStatus     func(protocol.Status)

	onManifest       func([]protocol.FileEntry)
	onFileSynced     func(uint64)
	onFileAttachment func(uint64, protocol.Attachment)
	onFileCanvas     func(uint64, protocol.CanvasMessage)
	bytes            protocol.Rate
}

func join(t *testing.T, relay *prototest.Relay, key string, o joinOpts) *peer {
	t.Helper()
	raw, err := protocol.DecodeKey(key)
	if err != nil {
		t.Fatal(err)
	}
	doc := crdt.New()
	text := doc.GetText("content")
	if o.init != "" {
		doc.Transact(func(txn *crdt.Transaction) { text.Insert(txn, 0, o.init, nil) })
	}
	aw := awareness.New(uint64(doc.ClientID()))
	if o.state == nil {
		o.state = map[string]any{} // like a JavaScript Awareness starts
	}
	aw.SetLocalState(o.state)
	client, err := protocol.NewClient(protocol.ClientOptions{
		URL:          "ws://test",
		Key:          raw,
		Doc:          doc,
		Awareness:    aw,
		Header:       o.header,
		Dial:         relay.Dial,
		MinBackoff:   20 * time.Millisecond,
		BusyBackoff:  o.busyBackoff,
		OnStatus:     o.onStatus,
		OnError:      o.onError,
		OnAttachment: o.onAttachment,
		OnCanvas:     o.onCanvas,
		OnSynced:     o.onSynced,

		OnManifest:       o.onManifest,
		OnFileSynced:     o.onFileSynced,
		OnFileAttachment: o.onFileAttachment,
		OnFileCanvas:     o.onFileCanvas,
		Bytes:            o.bytes,
	})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(client.Destroy)
	client.Connect()
	return &peer{Client: client, doc: doc, aw: aw, text: text}
}

func hostHeader() http.Header { return http.Header{"Authorization": {"Bearer t"}} }

func TestLateJoinerGetsFullDocument(t *testing.T) {
	relay := prototest.NewRelay(false)
	key := protocol.GenerateKey()
	host := join(t, relay, key, joinOpts{init: "# notes\n"})
	prototest.WaitFor(t, wait, func() bool { return host.Status() == protocol.StatusConnected }, "host connected")
	guest := join(t, relay, key, joinOpts{})
	prototest.WaitFor(t, wait, func() bool { return guest.String() == "# notes\n" }, "guest to get the doc")
}

func TestReportsSyncedOnceWithTheDocument(t *testing.T) {
	relay := prototest.NewRelay(true)
	key := protocol.GenerateKey()
	host := join(t, relay, key, joinOpts{init: "# notes\n", header: hostHeader()})
	prototest.WaitFor(t, wait, func() bool { return host.Status() == protocol.StatusConnected }, "host connected")
	var mu sync.Mutex
	var seen []string
	var guest *peer
	guest = join(t, relay, key, joinOpts{onSynced: func() {
		mu.Lock()
		defer mu.Unlock()
		// The doc already holds the room's state when synced is reported.
		seen = append(seen, guest.String())
	}})
	prototest.WaitFor(t, wait, func() bool { mu.Lock(); defer mu.Unlock(); return len(seen) > 0 }, "synced")
	// Another peer's SyncStep2, and a reconnect, do not report it again.
	join(t, relay, key, joinOpts{})
	relay.DropAll()
	prototest.WaitFor(t, wait, func() bool { return guest.Status() == protocol.StatusConnected }, "reconnected")
	time.Sleep(100 * time.Millisecond)
	mu.Lock()
	defer mu.Unlock()
	if !reflect.DeepEqual(seen, []string{"# notes\n"}) {
		t.Fatalf("synced reports = %q", seen)
	}
}

// The relay's word on the host moves a guest between connected and waiting,
// neither of which ends the client.
func TestWaitsWhileTheRelaySaysTheHostIsAway(t *testing.T) {
	relay := prototest.NewRelay(false)
	key := protocol.GenerateKey()
	guest := join(t, relay, key, joinOpts{})
	prototest.WaitFor(t, wait, func() bool { return guest.Status() == protocol.StatusConnected }, "connected")
	relay.Signal(protocol.HostAway)
	prototest.WaitFor(t, wait, func() bool { return guest.Status() == protocol.StatusWaiting }, "waiting")
	if protocol.StatusWaiting.Final() {
		t.Fatal("waiting is final")
	}
	relay.Signal(protocol.HostBack)
	prototest.WaitFor(t, wait, func() bool { return guest.Status() == protocol.StatusConnected }, "connected again")
	if n := len(relay.URLs()); n != 1 {
		t.Fatalf("dialed %d times", n)
	}
}

// A connection dropped without a close reaching us still ends on the first
// write that fails, and the client reconnects instead of waiting on it.
func TestReconnectsWhenAWriteFails(t *testing.T) {
	relay := prototest.NewRelay(false)
	key := protocol.GenerateKey()
	host := join(t, relay, key, joinOpts{init: "a"})
	prototest.WaitFor(t, wait, func() bool { return host.Status() == protocol.StatusConnected }, "host connected")
	relay.SeverAll()
	host.insert(1, "b")
	prototest.WaitFor(t, wait, func() bool { return len(relay.URLs()) == 2 }, "a reconnect")
	guest := join(t, relay, key, joinOpts{})
	prototest.WaitFor(t, wait, func() bool { return guest.String() == "ab" }, "the edit, after the reconnect")
}

func TestConcurrentEditsBothWays(t *testing.T) {
	relay := prototest.NewRelay(false)
	key := protocol.GenerateKey()
	a := join(t, relay, key, joinOpts{init: "hello"})
	b := join(t, relay, key, joinOpts{})
	prototest.WaitFor(t, wait, func() bool { return b.String() == "hello" }, "b to sync")
	a.insert(0, "A")
	b.insert(5, "B")
	prototest.WaitFor(t, wait, func() bool {
		sa, sb := a.String(), b.String()
		return sa == sb && strings.Contains(sa, "A") && strings.Contains(sa, "B")
	}, "convergence")
}

func TestUTF16Offsets(t *testing.T) {
	relay := prototest.NewRelay(false)
	key := protocol.GenerateKey()
	a := join(t, relay, key, joinOpts{init: "🌏 world"})
	b := join(t, relay, key, joinOpts{})
	prototest.WaitFor(t, wait, func() bool { return b.String() == "🌏 world" }, "b to sync")
	b.insert(2, "!") // right after the surrogate pair
	prototest.WaitFor(t, wait, func() bool { return a.String() == "🌏! world" }, "a to see the edit")
}

func TestPushesOfflineEditsOfReconnectingHost(t *testing.T) {
	relay := prototest.NewRelay(false)
	key := protocol.GenerateKey()
	guest := join(t, relay, key, joinOpts{})
	join(t, relay, key, joinOpts{init: "written before anyone joined"})
	prototest.WaitFor(t, wait, func() bool { return guest.String() == "written before anyone joined" }, "guest to sync")
}

func TestAwareness(t *testing.T) {
	relay := prototest.NewRelay(false)
	key := protocol.GenerateKey()
	host := join(t, relay, key, joinOpts{state: map[string]any{"role": "host"}})
	prototest.WaitFor(t, wait, func() bool { return host.Status() == protocol.StatusConnected }, "host connected")
	guest := join(t, relay, key, joinOpts{state: map[string]any{"name": "guest"}})
	stateOf := func(p, of *peer) map[string]any {
		return p.aw.GetStates()[of.aw.ClientID()].State
	}
	prototest.WaitFor(t, wait, func() bool {
		return reflect.DeepEqual(stateOf(guest, host), map[string]any{"role": "host"}) &&
			reflect.DeepEqual(stateOf(host, guest), map[string]any{"name": "guest"})
	}, "awareness exchange")
	host.Destroy()
	prototest.WaitFor(t, wait, func() bool {
		_, ok := guest.aw.GetStates()[host.aw.ClientID()]
		return !ok
	}, "host to leave")
}

func TestOnlyCiphertextOnTheWire(t *testing.T) {
	relay := prototest.NewRelay(false)
	key := protocol.GenerateKey()
	join(t, relay, key, joinOpts{init: "top secret plaintext"})
	b := join(t, relay, key, joinOpts{})
	prototest.WaitFor(t, wait, func() bool { return b.String() == "top secret plaintext" }, "b to sync")
	for _, f := range relay.Frames() {
		if strings.Contains(string(f), "top secret") {
			t.Fatal("plaintext leaked onto the wire")
		}
	}
}

func TestIgnoresPeersWithDifferentKey(t *testing.T) {
	relay := prototest.NewRelay(false)
	a := join(t, relay, protocol.GenerateKey(), joinOpts{init: "mine"})
	var mu sync.Mutex
	var errs []error
	b := join(t, relay, protocol.GenerateKey(), joinOpts{onError: func(err error) {
		mu.Lock()
		defer mu.Unlock()
		errs = append(errs, err)
	}})
	prototest.WaitFor(t, wait, func() bool { return b.Status() == protocol.StatusConnected }, "b connected")
	a.insert(4, "!") // reaches b as a frame it cannot decrypt
	prototest.WaitFor(t, wait, func() bool { mu.Lock(); defer mu.Unlock(); return len(errs) > 0 }, "a decrypt error")
	if b.String() != "" || a.String() != "mine!" {
		t.Fatalf("a=%q b=%q", a.String(), b.String())
	}
}

func TestAttachments(t *testing.T) {
	relay := prototest.NewRelay(false)
	key := protocol.GenerateKey()
	var mu sync.Mutex
	var got []protocol.Attachment
	a := join(t, relay, key, joinOpts{})
	b := join(t, relay, key, joinOpts{onAttachment: func(at protocol.Attachment) {
		mu.Lock()
		defer mu.Unlock()
		got = append(got, at)
	}})
	prototest.WaitFor(t, wait, func() bool {
		return a.Status() == protocol.StatusConnected && b.Status() == protocol.StatusConnected
	}, "both connected")
	sent := protocol.Attachment{Kind: protocol.AttachmentAnnounce, Hash: hashA, Mime: "image/png"}
	if err := a.SendAttachment(sent); err != nil {
		t.Fatal(err)
	}
	prototest.WaitFor(t, wait, func() bool { mu.Lock(); defer mu.Unlock(); return len(got) > 0 }, "the attachment")
	mu.Lock()
	defer mu.Unlock()
	if !reflect.DeepEqual(got, []protocol.Attachment{sent}) {
		t.Fatalf("got %+v", got)
	}
	if err := a.SendAttachment(protocol.Attachment{Kind: protocol.AttachmentWant}); err == nil {
		t.Fatal("an invalid attachment should not be sent")
	}
}

func TestSkipsMessagesFromNewerPeers(t *testing.T) {
	relay := prototest.NewRelay(false)
	key := protocol.GenerateKey()
	var mu sync.Mutex
	var errs []error
	b := join(t, relay, key, joinOpts{onError: func(err error) {
		mu.Lock()
		defer mu.Unlock()
		errs = append(errs, err)
	}})
	prototest.WaitFor(t, wait, func() bool { return b.Status() == protocol.StatusConnected }, "b connected")

	// A newer peer sends a message type, an attachment kind, a canvas kind,
	// a files kind and a message about a file that b does not know, then an
	// edit.
	raw, _ := protocol.DecodeKey(key)
	c, _ := protocol.NewCipher(raw)
	conn, err := relay.Dial(t.Context(), "ws://test", nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = conn.Close() })
	for i, m := range [][]byte{
		protocol.EncodeMessage(9, []byte{1, 2, 3}),
		protocol.EncodeMessage(protocol.MessageAttachment, []byte{9, 1, 2, 3}),
		protocol.EncodeMessage(protocol.MessageCanvas, []byte{9, 1, 2, 3}),
		protocol.EncodeMessage(protocol.MessageFiles, []byte{9, 1, 2, 3}),
		protocol.EncodeMessage(protocol.MessageFiles, []byte{byte(protocol.FilesDoc), 1, 9, 1, 2, 3}),
	} {
		if err := conn.Write(t.Context(), c.Encrypt(protocol.EncodeFrame(protocol.Sender{1}, uint64(i+1), m))); err != nil {
			t.Fatal(err)
		}
	}
	a := join(t, relay, key, joinOpts{init: "after"})
	prototest.WaitFor(t, wait, func() bool { return b.String() == "after" && a.String() == "after" }, "b to keep syncing")
	mu.Lock()
	defer mu.Unlock()
	if len(errs) > 0 {
		t.Fatalf("errors: %v", errs)
	}
}

func TestReportsMalformedMessages(t *testing.T) {
	relay := prototest.NewRelay(false)
	key := protocol.GenerateKey()
	var mu sync.Mutex
	var errs []error
	b := join(t, relay, key, joinOpts{onError: func(err error) {
		mu.Lock()
		defer mu.Unlock()
		errs = append(errs, err)
	}})
	prototest.WaitFor(t, wait, func() bool { return b.Status() == protocol.StatusConnected }, "b connected")

	raw, _ := protocol.DecodeKey(key)
	c, _ := protocol.NewCipher(raw)
	conn, err := relay.Dial(t.Context(), "ws://test", nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = conn.Close() })
	for i, m := range [][]byte{
		protocol.EncodeMessage(protocol.MessageAttachment, nil),
		protocol.EncodeMessage(protocol.MessageCanvas, nil),
		protocol.EncodeMessage(protocol.MessageAwareness, nil),
	} {
		if err := conn.Write(t.Context(), c.Encrypt(protocol.EncodeFrame(protocol.Sender{1}, uint64(i+1), m))); err != nil {
			t.Fatal(err)
		}
	}
	prototest.WaitFor(t, wait, func() bool { mu.Lock(); defer mu.Unlock(); return len(errs) == 3 }, "an error for each message")
}

// TestDropsReplayedFrames: the relay can send any frame it relayed again, or
// back to the peer that sent it. A canvas edit applied twice is not the
// same as once, so peers take each frame once.
func TestDropsReplayedFrames(t *testing.T) {
	relay := prototest.NewRelay(false)
	key := protocol.GenerateKey()
	var mu sync.Mutex
	var edits []string
	var errs []error
	b := join(t, relay, key, joinOpts{
		onCanvas: func(m protocol.CanvasMessage) {
			mu.Lock()
			defer mu.Unlock()
			edits = append(edits, m.ID)
		},
		onError: func(err error) {
			mu.Lock()
			defer mu.Unlock()
			errs = append(errs, err)
		},
	})
	prototest.WaitFor(t, wait, func() bool { return b.Status() == protocol.StatusConnected }, "b connected")

	raw, _ := protocol.DecodeKey(key)
	c, _ := protocol.NewCipher(raw)
	conn, err := relay.Dial(t.Context(), "ws://test", nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = conn.Close() })
	edit := func(id string) []byte {
		payload, err := protocol.EncodeCanvas(protocol.CanvasMessage{Kind: protocol.CanvasEdit, ID: id, Base: "{}", Next: "{}"})
		if err != nil {
			t.Fatal(err)
		}
		return protocol.EncodeMessage(protocol.MessageCanvas, payload)
	}
	first := c.Encrypt(protocol.EncodeFrame(protocol.Sender{1}, 1, edit("first")))
	for _, frame := range [][]byte{
		first,
		c.Encrypt(protocol.EncodeFrame(protocol.Sender{1}, 2, edit("second"))),
		first, // sent again
		c.Encrypt(protocol.EncodeFrame(protocol.Sender{1}, 2, edit("same counter"))),
		c.Encrypt(protocol.EncodeFrame(protocol.Sender{2}, 1, edit("other sender"))),
	} {
		if err := conn.Write(t.Context(), frame); err != nil {
			t.Fatal(err)
		}
	}
	prototest.WaitFor(t, wait, func() bool {
		mu.Lock()
		defer mu.Unlock()
		return len(edits) == 3 && len(errs) == 2
	}, "the new frames, and the replays refused")
	mu.Lock()
	defer mu.Unlock()
	if !slices.Equal(edits, []string{"first", "second", "other sender"}) {
		t.Errorf("edits = %v", edits)
	}
	for _, err := range errs {
		if !errors.Is(err, protocol.ErrReplayedFrame) {
			t.Errorf("err = %v", err)
		}
	}
}

func TestReconnectsAfterDrop(t *testing.T) {
	relay := prototest.NewRelay(false)
	var mu sync.Mutex
	var statuses []protocol.Status
	raw, _ := protocol.DecodeKey(protocol.GenerateKey())
	doc := crdt.New()
	c, _ := protocol.NewClient(protocol.ClientOptions{
		URL: "ws://test", Key: raw, Doc: doc, Awareness: awareness.New(uint64(doc.ClientID())),
		Dial: relay.Dial, MinBackoff: 20 * time.Millisecond,
		OnStatus: func(s protocol.Status) { mu.Lock(); statuses = append(statuses, s); mu.Unlock() },
	})
	t.Cleanup(c.Destroy)
	c.Connect()
	prototest.WaitFor(t, wait, func() bool { return c.Status() == protocol.StatusConnected }, "connected")
	relay.DropAll()
	prototest.WaitFor(t, wait, func() bool { return len(relay.URLs()) == 2 && c.Status() == protocol.StatusConnected }, "reconnect")
	mu.Lock()
	defer mu.Unlock()
	want := []protocol.Status{"connecting", "connected", "disconnected", "connecting", "connected"}
	if !reflect.DeepEqual(statuses, want) {
		t.Fatalf("statuses = %v", statuses)
	}
}

func TestPassesHandshakeHeaders(t *testing.T) {
	relay := prototest.NewRelay(false)
	join(t, relay, protocol.GenerateKey(), joinOpts{header: hostHeader()})
	prototest.WaitFor(t, wait, func() bool { return len(relay.Headers()) == 1 }, "dial")
	if got := relay.Headers()[0].Get("Authorization"); got != "Bearer t" {
		t.Fatalf("Authorization = %q", got)
	}
}

func TestStopsForGoodWhenHostLeaves(t *testing.T) {
	relay := prototest.NewRelay(true)
	key := protocol.GenerateKey()
	host := join(t, relay, key, joinOpts{init: "x", header: hostHeader()})
	prototest.WaitFor(t, wait, func() bool { return host.Status() == protocol.StatusConnected }, "host connected")
	guest := join(t, relay, key, joinOpts{})
	prototest.WaitFor(t, wait, func() bool { return guest.String() == "x" }, "guest to sync")
	host.Destroy()
	prototest.WaitFor(t, wait, func() bool { return guest.Status() == protocol.StatusClosed }, "guest closed")
	time.Sleep(200 * time.Millisecond)
	if guest.Status() != protocol.StatusClosed || len(relay.URLs()) != 2 {
		t.Fatalf("status=%v dials=%d", guest.Status(), len(relay.URLs()))
	}
}

func TestStopsForGoodWhenRoomIsFull(t *testing.T) {
	relay := prototest.NewRelay(true)
	relay.Guests = 1
	key := protocol.GenerateKey()
	host := join(t, relay, key, joinOpts{init: "x", header: hostHeader()})
	prototest.WaitFor(t, wait, func() bool { return host.Status() == protocol.StatusConnected }, "host connected")
	first := join(t, relay, key, joinOpts{})
	prototest.WaitFor(t, wait, func() bool { return first.String() == "x" }, "first guest to sync")
	late := join(t, relay, key, joinOpts{})
	prototest.WaitFor(t, wait, func() bool { return late.Status() == protocol.StatusFull }, "late guest turned away")
	time.Sleep(200 * time.Millisecond)
	if late.Status() != protocol.StatusFull || len(relay.URLs()) != 3 {
		t.Fatalf("status=%v dials=%d", late.Status(), len(relay.URLs()))
	}
}

func TestWaitsOutABusyRelayLongerThanADrop(t *testing.T) {
	relay := prototest.NewRelay(false)
	relay.Busy = 1
	var mu sync.Mutex
	var seen []protocol.Status
	p := join(t, relay, protocol.GenerateKey(), joinOpts{
		busyBackoff: 300 * time.Millisecond,
		onStatus: func(s protocol.Status) {
			mu.Lock()
			seen = append(seen, s)
			mu.Unlock()
		},
	})
	prototest.WaitFor(t, wait, func() bool { return p.Status() == protocol.StatusBusy }, "busy")
	// A drop is retried after 10-20 ms here; a busy relay waits 150-300 ms.
	time.Sleep(100 * time.Millisecond)
	if n := len(relay.URLs()); n != 1 {
		t.Fatalf("dialed %d times while busy", n)
	}
	prototest.WaitFor(t, wait, func() bool { return p.Status() == protocol.StatusConnected }, "connected")
	mu.Lock()
	defer mu.Unlock()
	want := []protocol.Status{protocol.StatusConnecting, protocol.StatusBusy, protocol.StatusConnecting, protocol.StatusConnected}
	if fmt.Sprint(seen) != fmt.Sprint(want) {
		t.Fatalf("statuses = %v", seen)
	}
}

func TestResumesTheSameRoomAfterMaintenance(t *testing.T) {
	relay := prototest.NewRelay(false)
	key := protocol.GenerateKey()
	host := join(t, relay, key, joinOpts{init: "x"})
	prototest.WaitFor(t, wait, func() bool { return host.Status() == protocol.StatusConnected }, "host connected")
	host.Resume() // still connected: nothing to resume
	relay.SetRefuse(protocol.RelayMaintenance)
	relay.DropAll()
	prototest.WaitFor(t, wait, func() bool { return host.Status() == protocol.StatusMaintenance }, "maintenance")
	time.Sleep(100 * time.Millisecond)
	dials := len(relay.URLs())
	if host.Status() != protocol.StatusMaintenance || dials != 2 {
		t.Fatalf("status=%v dials=%d: reconnected on its own", host.Status(), dials)
	}
	relay.SetRefuse(0)
	host.Resume()
	prototest.WaitFor(t, wait, func() bool { return host.Status() == protocol.StatusConnected }, "resumed")
	if got := relay.URLs()[dials]; got != relay.URLs()[0] {
		t.Fatalf("resumed into %q, not %q", got, relay.URLs()[0])
	}
	guest := join(t, relay, key, joinOpts{})
	prototest.WaitFor(t, wait, func() bool { return guest.String() == "x" }, "guest to sync after resuming")
}

func TestResumeDoesNothingOnceDestroyed(t *testing.T) {
	relay := prototest.NewRelay(false)
	relay.Refuse = protocol.RelayMaintenance
	p := join(t, relay, protocol.GenerateKey(), joinOpts{})
	prototest.WaitFor(t, wait, func() bool { return p.Status() == protocol.StatusMaintenance }, "maintenance")
	p.Destroy()
	relay.SetRefuse(0)
	p.Resume()
	time.Sleep(100 * time.Millisecond)
	if n := len(relay.URLs()); n != 1 {
		t.Fatalf("dialed %d times after Destroy", n)
	}
}

func TestTurnedAwayWithoutHost(t *testing.T) {
	relay := prototest.NewRelay(true)
	guest := join(t, relay, protocol.GenerateKey(), joinOpts{})
	prototest.WaitFor(t, wait, func() bool { return guest.Status() == protocol.StatusClosed }, "guest closed")
}

func TestStopsForGoodOnProtocolVersionMismatch(t *testing.T) {
	for code, want := range map[int]protocol.Status{
		protocol.ClientOutdated: protocol.StatusClientOutdated,
		protocol.ServerOutdated: protocol.StatusServerOutdated,
	} {
		relay := prototest.NewRelay(false)
		relay.Refuse = code
		c := join(t, relay, protocol.GenerateKey(), joinOpts{})
		prototest.WaitFor(t, wait, func() bool { return c.Status() == want }, string(want))
		time.Sleep(200 * time.Millisecond)
		if c.Status() != want || len(relay.URLs()) != 1 || !want.Final() {
			t.Fatalf("status=%v dials=%d", c.Status(), len(relay.URLs()))
		}
	}
}

func TestStateFrameBytesIsWhatIsSent(t *testing.T) {
	relay := prototest.NewRelay(false)
	p := join(t, relay, protocol.GenerateKey(), joinOpts{init: strings.Repeat("z", 5000)})
	prototest.WaitFor(t, wait, func() bool { return len(relay.Frames()) >= 2 }, "the handshake")
	// The frames are SyncStep1, then the whole state.
	if got, want := len(relay.Frames()[1]), protocol.StateFrameBytes(p.doc); got != want {
		t.Fatalf("the state went as a frame of %d bytes, StateFrameBytes says %d", got, want)
	}
}

func TestStopsForGoodWhenTheStateDoesNotFit(t *testing.T) {
	relay := prototest.NewRelay(false)
	var mu sync.Mutex
	var statuses []protocol.Status
	p := join(t, relay, protocol.GenerateKey(), joinOpts{
		init: strings.Repeat("x", protocol.MaxFrameBytes),
		onStatus: func(s protocol.Status) {
			mu.Lock()
			statuses = append(statuses, s)
			mu.Unlock()
		},
	})
	prototest.WaitFor(t, wait, func() bool { return p.Status() == protocol.StatusTooLarge }, "too large")
	time.Sleep(200 * time.Millisecond)
	mu.Lock()
	defer mu.Unlock()
	want := []protocol.Status{protocol.StatusConnecting, protocol.StatusTooLarge}
	if !reflect.DeepEqual(statuses, want) || len(relay.URLs()) != 1 || len(relay.Frames()) != 0 {
		t.Fatalf("statuses=%v dials=%d frames=%d", statuses, len(relay.URLs()), len(relay.Frames()))
	}
	if !protocol.StatusTooLarge.Final() {
		t.Fatal("StatusTooLarge should be final")
	}
}

func TestStopsForGoodWhenAnEditDoesNotFit(t *testing.T) {
	relay := prototest.NewRelay(true)
	key := protocol.GenerateKey()
	host := join(t, relay, key, joinOpts{init: "x", header: hostHeader()})
	prototest.WaitFor(t, wait, func() bool { return host.Status() == protocol.StatusConnected }, "host connected")
	guest := join(t, relay, key, joinOpts{})
	prototest.WaitFor(t, wait, func() bool { return guest.String() == "x" }, "guest to sync")
	guest.insert(0, strings.Repeat("y", protocol.MaxFrameBytes))
	prototest.WaitFor(t, wait, func() bool { return guest.Status() == protocol.StatusTooLarge }, "guest too large")
	time.Sleep(200 * time.Millisecond)
	if guest.Status() != protocol.StatusTooLarge || len(relay.URLs()) != 2 {
		t.Fatalf("status=%v dials=%d", guest.Status(), len(relay.URLs()))
	}
	// The edit reached nobody, and the others stay in the room.
	if host.Status() != protocol.StatusConnected || host.String() != "x" {
		t.Fatalf("host status=%v text=%d bytes", host.Status(), len(host.String()))
	}
	for _, f := range relay.Frames() {
		if len(f) > protocol.MaxFrameBytes {
			t.Fatalf("a frame of %d bytes went to the relay", len(f))
		}
	}
}

func TestStopsForGoodWhenTheRelaySaysAFrameIsTooBig(t *testing.T) {
	relay := prototest.NewRelay(false)
	relay.MaxFrame = 100
	p := join(t, relay, protocol.GenerateKey(), joinOpts{init: strings.Repeat("x", 200)})
	prototest.WaitFor(t, wait, func() bool { return p.Status() == protocol.StatusTooLarge }, "too large")
	time.Sleep(200 * time.Millisecond)
	if p.Status() != protocol.StatusTooLarge || len(relay.URLs()) != 1 {
		t.Fatalf("status=%v dials=%d", p.Status(), len(relay.URLs()))
	}
}

func TestStopsForGoodWhenTheRoomExpires(t *testing.T) {
	relay := prototest.NewRelay(true)
	key := protocol.GenerateKey()
	host := join(t, relay, key, joinOpts{init: "x", header: hostHeader()})
	prototest.WaitFor(t, wait, func() bool { return host.Status() == protocol.StatusConnected }, "host connected")
	guest := join(t, relay, key, joinOpts{})
	prototest.WaitFor(t, wait, func() bool { return guest.String() == "x" }, "guest to sync")
	relay.CloseAll(protocol.RoomExpired, protocol.ExpiredReason(86400))
	prototest.WaitFor(t, wait, func() bool {
		return host.Status() == protocol.StatusExpired && guest.Status() == protocol.StatusExpired
	}, "both expired")
	time.Sleep(100 * time.Millisecond)
	if len(relay.URLs()) != 2 {
		t.Fatalf("redialed: %d dials", len(relay.URLs()))
	}
	if host.TimeLimit() != 24*time.Hour || guest.TimeLimit() != 24*time.Hour {
		t.Fatalf("limits = %v, %v", host.TimeLimit(), guest.TimeLimit())
	}
	if !protocol.StatusExpired.Final() {
		t.Fatal("StatusExpired should be final")
	}
}

func TestExpiredWithoutAReasonHasNoTimeLimit(t *testing.T) {
	relay := prototest.NewRelay(false)
	relay.Refuse = protocol.RoomExpired
	p := join(t, relay, protocol.GenerateKey(), joinOpts{})
	prototest.WaitFor(t, wait, func() bool { return p.Status() == protocol.StatusExpired }, "expired")
	time.Sleep(100 * time.Millisecond)
	if p.TimeLimit() != 0 || len(relay.URLs()) != 1 {
		t.Fatalf("limit=%v dials=%d", p.TimeLimit(), len(relay.URLs()))
	}
}
