package session

import (
	"context"
	"net/http"
	"os"
	"sync/atomic"
	"testing"

	"github.com/piconic-ai/pedit/internal/protocol"
	"github.com/piconic-ai/pedit/internal/protocol/prototest"
)

func TestResumeAgainHoldsTheLastEntryAndAcceptsASnapshotOfTheRelay(t *testing.T) {
	a := newAwayRoom(t, "notes\n")
	_, guest := keepAndLeave(t, a)
	a.script(1, protocol.EncodeLogged(1, guest.insert(0, "one ")), protocol.EncodeLogEnd(1))
	opts := a.options()
	opts.Resume = a.id
	s, err := Start(context.Background(), opts)
	if err != nil {
		t.Fatal(err)
	}
	if err := s.Stop(); err != nil {
		t.Fatal(err)
	}
	// The relay cut its log past what this host holds, so it sends the
	// snapshot first, as it does to a host with less than its cutoff.
	a.script(2, protocol.WithKind(protocol.KindReplay, mustSnapshot(t, a)), protocol.EncodeLogged(2, guest.insert(0, "two ")), protocol.EncodeLogEnd(2))
	s, err = Start(context.Background(), opts)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = s.Stop() })
	conns := a.relay.Conns()
	if got := conns[len(conns)-1].Header.Get(protocol.AfterHeader); got != "1" {
		t.Fatalf("%s = %q, want the entry the host took in", protocol.AfterHeader, got)
	}
	if got := readText(t, a.file); got != "two one notes\n" {
		t.Fatalf("file = %q", got)
	}
	prototest.WaitFor(t, wait, func() bool { return a.record().After == 2 }, "the checkpoint at 2")
}

func TestCloseTakesInTheLogLeavesAndAsksTheRelayToEndTheRoom(t *testing.T) {
	a := newAwayRoom(t, "notes\n")
	_, guest := keepAndLeave(t, a)
	var asked atomic.Int64
	a.server.Config.Handler = http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/api/rooms/"+a.id+"/keep/close" {
			if r.Header.Get("X-Pedit-Tail") != "1" || r.Header.Get("Authorization") != "Bearer "+a.token {
				t.Errorf("close: tail %q, authorization %q", r.Header.Get("X-Pedit-Tail"), r.Header.Get("Authorization"))
			}
			asked.Add(1)
		}
		_, _ = w.Write([]byte("{}"))
	})
	a.script(1, protocol.EncodeLogged(1, guest.insert(0, "guest ")), protocol.EncodeLogEnd(1))
	before := a.relay.OnDial
	a.relay.OnDial = func(c *prototest.ScriptConn) {
		// Once the room was ended, the relay turns the host away.
		if asked.Load() > 0 {
			c.CloseWith(protocol.RoomClosed)
			return
		}
		before(c)
	}
	err := RunKeptText(context.Background(), KeptTextOptions{Project: a.project, Resume: a.id, Close: true, Dial: a.relay.Dial}, nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	if asked.Load() != 1 || readText(t, a.file) != "guest notes\n" {
		t.Fatalf("asked %d times, file %q", asked.Load(), readText(t, a.file))
	}
	conns := a.relay.Conns()
	if !conns[len(conns)-2].Left() {
		t.Fatal("the host did not leave before asking the relay to end the room")
	}
	if _, err := os.Stat(keptTestStatePath(t, a.project, a.id)); err == nil {
		t.Fatal("the record outlived the room")
	}
}
