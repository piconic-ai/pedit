package session

import (
	"context"
	"net/http"
	"os"
	"strings"
	"sync"
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
	err := CloseKept(context.Background(), closeOptions(a))
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

// closeAsks makes the relay answer --close's request with the status that
// answer gives for the n-th ask, and, once it answered 200, turn the host away
// as it does a room that was ended. tails holds what each ask named.
func (a *awayRoom) closeAsks(answer func(n int) int) (tails *[]string) {
	tails = new([]string)
	var mu sync.Mutex
	ended := false
	a.server.Config.Handler = http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/rooms/"+a.id+"/keep/close" {
			_, _ = w.Write([]byte("{}"))
			return
		}
		mu.Lock()
		defer mu.Unlock()
		*tails = append(*tails, r.Header.Get("X-Pedit-Tail"))
		status := answer(len(*tails))
		ended = ended || status == http.StatusOK
		w.WriteHeader(status)
		_, _ = w.Write([]byte("{}"))
	})
	before := a.relay.OnDial
	a.relay.OnDial = func(c *prototest.ScriptConn) {
		mu.Lock()
		over := ended
		mu.Unlock()
		if over {
			c.CloseWith(protocol.RoomClosed)
			return
		}
		before(c)
	}
	return tails
}

func closeOptions(a *awayRoom) KeptTextOptions {
	return KeptTextOptions{Project: a.project, Resume: a.id, Dial: a.relay.Dial}
}

func TestCloseKeepsRoomAndRecordWhenTheWriteFails(t *testing.T) {
	a := newAwayRoom(t, "notes\n")
	_, guest := keepAndLeave(t, a)
	a.script(1, protocol.EncodeLogged(1, guest.insert(0, "guest ")), protocol.EncodeLogEnd(1))
	tails := a.closeAsks(func(int) int { return http.StatusOK })
	// A write was under way when the host left, and the file was changed by
	// another editor since: the host cannot tell which edit is whose.
	record := a.record()
	pending := "guest notes\n"
	record.Files[0].Pending = &pending
	if err := saveKeptState(keptTestStatePath(t, a.project, a.id), record); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(a.file, []byte("external\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := CloseKept(context.Background(), closeOptions(a)); err == nil {
		t.Fatal("closed after a failed write")
	}
	if len(*tails) != 0 {
		t.Fatalf("asked the relay to end the room: %v", *tails)
	}
	if got := readText(t, a.file); got != "external\n" {
		t.Fatalf("file = %q", got)
	}
	if _, err := os.Stat(keptTestStatePath(t, a.project, a.id)); err != nil {
		t.Fatal("record removed although the room stayed open")
	}
}

func TestCloseKeepsTheRecordWhenTheRelayRefuses(t *testing.T) {
	a := newAwayRoom(t, "notes\n")
	_, guest := keepAndLeave(t, a)
	a.script(1, protocol.EncodeLogged(1, guest.insert(0, "guest ")), protocol.EncodeLogEnd(1))
	tails := a.closeAsks(func(int) int { return http.StatusServiceUnavailable })
	if err := CloseKept(context.Background(), closeOptions(a)); err == nil {
		t.Fatal("reported a close the relay refused")
	}
	if len(*tails) != 1 || readText(t, a.file) != "guest notes\n" {
		t.Fatalf("asked %v, file %q", *tails, readText(t, a.file))
	}
	if _, err := os.Stat(keptTestStatePath(t, a.project, a.id)); err != nil {
		t.Fatal("record removed although the relay did not close")
	}
}

// A guest edit that arrived after the host's last read makes the relay answer
// 409 and keep the room: the host takes that edit in and asks again.
func TestCloseTakesInAnEditThatArrivedBeforeTheClose(t *testing.T) {
	a := newAwayRoom(t, "notes\n")
	_, guest := keepAndLeave(t, a)
	a.script(1, protocol.EncodeLogged(1, guest.insert(0, "one ")), protocol.EncodeLogEnd(1))
	tails := a.closeAsks(func(n int) int {
		if n == 1 {
			a.script(2, protocol.EncodeLogged(2, guest.insert(0, "two ")), protocol.EncodeLogEnd(2))
			return http.StatusConflict
		}
		return http.StatusOK
	})
	if err := CloseKept(context.Background(), closeOptions(a)); err != nil {
		t.Fatal(err)
	}
	if strings.Join(*tails, ",") != "1,2" || readText(t, a.file) != "two one notes\n" {
		t.Fatalf("asked %v, file %q", *tails, readText(t, a.file))
	}
	if _, err := os.Stat(keptTestStatePath(t, a.project, a.id)); err == nil {
		t.Fatal("record kept after a successful close")
	}
}
