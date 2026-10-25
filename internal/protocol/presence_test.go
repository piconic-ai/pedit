package protocol_test

import (
	"testing"

	"github.com/piconic-ai/pedit/internal/protocol"
	"github.com/piconic-ai/pedit/internal/protocol/prototest"
	"github.com/reearth/ygo/awareness"
	"github.com/reearth/ygo/crdt"
	"github.com/reearth/ygo/encoding"
)

// stateFor is an awareness message with one entry for a client ID of the
// sender's choosing, at a clock of its choosing; a nil state removes it.
func stateFor(id, clock uint64, state string) []byte {
	update := encoding.NewEncoder()
	update.WriteVarUint(1)
	update.WriteVarUint(id)
	update.WriteVarUint(clock)
	update.WriteVarString(state)
	msg := encoding.NewEncoder()
	msg.WriteVarBytes(update.Bytes())
	return protocol.EncodeMessage(protocol.MessageAwareness, msg.Bytes())
}

func TestEveryoneIsListedWithTheirAccess(t *testing.T) {
	relay := prototest.NewRelay(false)
	key := protocol.GenerateKey()
	host := join(t, relay, key, joinOpts{state: map[string]any{"name": "host"}})
	commenter := join(t, relay, key, joinOpts{state: map[string]any{"name": "c"}, link: lowerLink(t, key, protocol.AccessComment)})
	reader := join(t, relay, key, joinOpts{state: map[string]any{"name": "r"}, link: lowerLink(t, key, protocol.AccessRead)})
	prototest.WaitFor(t, wait, func() bool {
		return len(host.aw.GetStates()) == 3 && len(commenter.aw.GetStates()) == 3 && len(reader.aw.GetStates()) == 3
	}, "everyone to see everyone")
	for _, p := range []*peer{host, commenter, reader} {
		for id, want := range map[uint64]protocol.Access{
			host.aw.ClientID():      protocol.AccessEdit,
			commenter.aw.ClientID(): protocol.AccessComment,
			reader.aw.ClientID():    protocol.AccessRead,
		} {
			if got, ok := p.AccessOf(id); !ok || got != want {
				t.Fatalf("%s says %d has %s access, want %s", p.Keys().Access, id, got, want)
			}
		}
	}
}

// Issue #122's B1: a state claimed first from below, at a clock far ahead,
// for an editor's client ID, neither holds back nor removes the editor's
// own.
func TestStatesFromBelowCannotTakeAnEditorsPlace(t *testing.T) {
	relay := prototest.NewRelay(false)
	key := protocol.GenerateKey()
	var errs errorLog
	newcomer := join(t, relay, key, joinOpts{onError: errs.add})
	prototest.WaitFor(t, wait, func() bool { return newcomer.Status() == protocol.StatusConnected }, "newcomer connected")
	conn, err := relay.Dial(t.Context(), "ws://test", nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = conn.Close() })

	// The host's client ID, known before it joins, as it is to anyone who
	// was in the room before.
	hostDoc := crdt.New()
	hostID := uint64(hostDoc.ClientID())
	read := lowerKeys(t, key, protocol.AccessRead)
	comment := lowerKeys(t, key, protocol.AccessComment)
	for i, frame := range [][]byte{
		protocol.SealFrame(read, protocol.Sender{1}, 1, stateFor(hostID, 1<<32, `{"role":"host","file":"evil.md"}`)),
		protocol.SealFrame(read, protocol.Sender{1}, 2, stateFor(hostID+1, 1<<32+1, `{"name":"far ahead"}`)),
	} {
		if err := conn.Write(t.Context(), frame); err != nil {
			t.Fatalf("frame %d: %v", i, err)
		}
	}
	prototest.WaitFor(t, wait, func() bool { return len(newcomer.aw.GetStates()) == 2 }, "the claim from below")

	aw := awareness.New(hostID)
	aw.SetLocalState(map[string]any{"role": "host", "file": "notes.md"})
	raw, _ := protocol.DecodeKey(key)
	host, err := protocol.NewClient(protocol.ClientOptions{URL: "ws://test", Key: raw, Doc: hostDoc, Awareness: aw, Dial: relay.Dial})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(host.Destroy)
	host.Connect()
	file := func() any { return newcomer.aw.GetStates()[hostID].State["file"] }
	prototest.WaitFor(t, wait, func() bool { return file() == "notes.md" }, "the host's own state")

	// Removals and states from below no longer touch it.
	for i, frame := range [][]byte{
		protocol.SealFrame(read, protocol.Sender{1}, 3, stateFor(hostID, 1<<32, "null")),
		protocol.SealFrame(comment, protocol.Sender{2}, 1, stateFor(hostID, 9, `{"role":"host","file":"evil.md"}`)),
	} {
		if err := conn.Write(t.Context(), frame); err != nil {
			t.Fatalf("frame %d: %v", i, err)
		}
	}
	prototest.WaitFor(t, wait, func() bool { return errs.count(protocol.ErrNotAllowed) == 3 }, "the claim far ahead and both later ones refused")
	if file() != "notes.md" {
		t.Fatalf("host state = %v", newcomer.aw.GetStates()[hostID].State)
	}
	if got, _ := newcomer.AccessOf(hostID); got != protocol.AccessEdit {
		t.Fatalf("the host is listed with %s access", got)
	}
}

// A frame holds the sender's own state only: nobody, an editor included,
// sends several, and a state for the receiver's own ID is dropped.
func TestAwarenessHoldsOneState(t *testing.T) {
	relay := prototest.NewRelay(false)
	key := protocol.GenerateKey()
	var errs errorLog
	p := join(t, relay, key, joinOpts{onError: errs.add, state: map[string]any{"name": "me"}})
	prototest.WaitFor(t, wait, func() bool { return p.Status() == protocol.StatusConnected }, "connected")
	conn, err := relay.Dial(t.Context(), "ws://test", nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = conn.Close() })
	other := awareness.New(7)
	other.SetLocalState(map[string]any{"name": "a"})
	several := encoding.NewEncoder()
	several.WriteVarBytes(awareness.New(8).EncodeUpdate([]uint64{7, 8}))
	edit := editKeys(t, key)
	for i, frame := range [][]byte{
		protocol.SealFrame(edit, protocol.Sender{1}, 1, protocol.EncodeMessage(protocol.MessageAwareness, several.Bytes())),
		protocol.SealFrame(edit, protocol.Sender{1}, 2, stateFor(p.aw.ClientID(), 1, "null")),
	} {
		if err := conn.Write(t.Context(), frame); err != nil {
			t.Fatalf("frame %d: %v", i, err)
		}
	}
	prototest.WaitFor(t, wait, func() bool { return errs.len() == 2 }, "both refused")
	if st := p.aw.GetStates()[p.aw.ClientID()].State; st["name"] != "me" {
		t.Fatalf("own state = %v", st)
	}
}
