package session

import (
	"context"
	"encoding/binary"
	"net/http"
	"sync/atomic"
	"testing"

	"github.com/piconic-ai/pedit/internal/protocol"
	"github.com/piconic-ai/pedit/internal/protocol/prototest"
)

// A host that dropped for so long that the room was kept without it is sent
// the log when its session reconnects, with no guest left to sync it by Yjs:
// it takes the entries in, and checkpoints.
func TestReconnectingHostTakesInTheLogAndCheckpoints(t *testing.T) {
	a := newAwayRoom(t, "notes\n")
	opts := a.options()
	opts.Keep = 3600e9
	s, err := Start(context.Background(), opts)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = s.Stop() })
	a.waitSent(protocol.KindSnapshot, 1)
	prototest.WaitFor(t, wait, func() bool { return !s.KeptUntil().IsZero() }, "the keep")
	guest := newGuestDoc(t, s.Client.Keys(), a.sent(protocol.KindSnapshot)[0])
	first := guest.insert(0, "first ")
	second := guest.insert(0, "second ")

	// The log holds two entries when the connection comes back; one is not valid.
	a.script(2, protocol.EncodeLogged(1, first), protocol.EncodeLogged(2, []byte("not an entry")), protocol.EncodeLogEnd(2))
	a.relay.Conns()[0].CloseWith(1006)
	prototest.WaitFor(t, wait, func() bool { return readText(t, a.file) == "first notes\n" }, "the logged entry in the file")
	a.waitSent(protocol.KindCheckpoint, 1)
	checkpoint := a.sent(protocol.KindCheckpoint)[0]
	if binary.BigEndian.Uint64(checkpoint) != 2 {
		t.Fatalf("checkpoint at %d", binary.BigEndian.Uint64(checkpoint))
	}
	if got := bundleText(t, s.Client.Keys(), checkpoint[8:]); got != "first notes\n" {
		t.Fatalf("checkpoint holds %q", got)
	}
	prototest.WaitFor(t, wait, func() bool { return a.record().After == 2 }, "the record to follow the checkpoint")

	// An entry the host already holds is not taken in twice, and a log that
	// brings nothing new is not checkpointed again.
	a.script(2, protocol.EncodeLogged(1, first), protocol.EncodeLogged(2, second), protocol.EncodeLogEnd(2))
	a.relay.Conns()[1].CloseWith(1006)
	prototest.WaitFor(t, wait, func() bool { return len(a.relay.Conns()) == 3 }, "a third connection")
	if got := readText(t, a.file); got != "first notes\n" {
		t.Fatalf("file = %q", got)
	}
	if n := len(a.sent(protocol.KindCheckpoint)); n != 1 {
		t.Fatalf("%d checkpoints", n)
	}
}

// An entry that reaches the host after its replay, while --close checkpoints,
// is not in the relay's log: it must be saved before the room is ended.
func TestCloseSavesAnEntryThatCameWhileCheckpointing(t *testing.T) {
	a := newAwayRoom(t, "notes\n")
	_, guest := keepAndLeave(t, a)
	late := guest.insert(0, "late ")
	a.script(0, protocol.EncodeLogEnd(0))
	a.mu.Lock()
	a.onCheckpoint = func(c *prototest.ScriptConn) { c.Push(protocol.WithKind(protocol.KindEntry, late)) }
	a.mu.Unlock()
	var closed atomic.Bool
	a.server.Config.Handler = http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/api/rooms/"+a.id+"/keep/close" {
			closed.Store(true)
		}
		_, _ = w.Write([]byte("{}"))
	})
	before := a.relay.OnDial
	a.relay.OnDial = func(c *prototest.ScriptConn) {
		if closed.Load() {
			c.CloseWith(protocol.RoomClosed)
			return
		}
		before(c)
	}
	if err := CloseKept(context.Background(), closeOptions(a)); err != nil {
		t.Fatal(err)
	}
	if got := readText(t, a.file); got != "late notes\n" {
		t.Fatalf("file = %q, the late entry was dropped", got)
	}
}
