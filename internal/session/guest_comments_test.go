package session

import (
	"context"
	"os"
	"sync/atomic"
	"testing"
	"time"

	"github.com/piconic-ai/pedit/internal/meta"
	"github.com/piconic-ai/pedit/internal/protocol"
	"github.com/piconic-ai/pedit/internal/protocol/prototest"
)

// commentLink is the host's comment link.
func commentLink(t *testing.T, s *Session) string {
	t.Helper()
	for _, l := range s.Links() {
		if l.Access == protocol.AccessComment {
			return l.URL
		}
	}
	t.Fatal("no comment link")
	return ""
}

// deafConn drops what reaches its peer once deaf is set.
type deafConn struct {
	protocol.Conn
	deaf *atomic.Bool
}

func (c deafConn) Read(ctx context.Context) ([]byte, error) {
	for {
		data, err := c.Conn.Read(ctx)
		if err != nil || !c.deaf.Load() {
			return data, err
		}
	}
}

func TestAGuestWithACommentLinkAnswersComments(t *testing.T) {
	saved := `{"version":1,"path":"notes.md","comments":{"c0":{"anchor":{"type":"text","exact":"hello","prefix":"","suffix":" world","offset":0},"quote":"hello","resolved":false,"messages":{"m0":{"author":"Ada","time":"2026-10-20T00:00:00Z","body":"Saved before"}}}}}`
	f := setup(t, "hello world!\n", setupOpts{project: true, meta: saved})
	var got changesOf
	g, err := joinFromCLI(t, f, joinCLIOpts{JoinOptions: JoinOptions{URL: commentLink(t, f.session), Name: "tate-pm", Watch: true, OnComments: got.add}})
	if err != nil {
		t.Fatal(err)
	}
	prototest.WaitFor(t, wait, func() bool {
		c := g.Comments()
		return len(c) == 1 && c[0].File == "notes.md" && len(c[0].Threads) == 1
	}, "the saved thread at the guest")
	if g.watcher != nil {
		t.Fatal("a comment link's copy is watched")
	}

	res, err := g.Reply("", "c0", "r1", "From the agent")
	if err != nil || !res.Delivered {
		t.Fatalf("%+v %v", res, err)
	}
	// Sent again, it writes nothing and is confirmed the same way.
	if res, err := g.Reply("", "c0", "r1", "From the agent"); err != nil || !res.Delivered {
		t.Fatalf("again: %+v %v", res, err)
	}
	if res, err := g.Resolve("notes.md", "c0", true); err != nil || !res.Delivered {
		t.Fatalf("resolve: %+v %v", res, err)
	}
	path := metaPathOf(f, "notes.md")
	prototest.WaitFor(t, wait, func() bool {
		data, err := os.ReadFile(path)
		if err != nil {
			return false
		}
		file, err := meta.Parse(data)
		return err == nil && file.Comments["c0"].Resolved && file.Comments["c0"].Messages["r1"].Author == "tate-pm"
	}, "the guest's reply saved by the host")

	// The host's own reply reaches the guest as an event; what was there
	// when it came is not one.
	if _, err := f.session.Reply("", "c0", "h1", "From the host"); err != nil {
		t.Fatal(err)
	}
	prototest.WaitFor(t, wait, func() bool {
		for _, c := range got.list() {
			if c == "comment notes.md c0 h1 From the host" {
				return true
			}
		}
		return false
	}, "the host's reply as an event")
	for _, c := range got.list() {
		if c == "comment notes.md c0 m0 Saved before" {
			t.Fatalf("a thread there before is reported: %q", got.list())
		}
	}
}

func TestAGuestSaysWhenTheHostDoesNotHaveItsReplyYet(t *testing.T) {
	oldWait, oldEvery := deliveryWait, probeEvery
	deliveryWait, probeEvery = 300*time.Millisecond, 50*time.Millisecond
	t.Cleanup(func() { deliveryWait, probeEvery = oldWait, oldEvery })
	var deaf atomic.Bool
	saved := `{"version":1,"path":"notes.md","comments":{"c0":{"anchor":{"type":"text","exact":"hello","prefix":"","suffix":" world","offset":0},"quote":"hello","resolved":false,"messages":{}}}}`
	f := setup(t, "hello world!\n", setupOpts{project: true, meta: saved, wrap: func(c protocol.Conn) protocol.Conn { return deafConn{c, &deaf} }})
	g, err := joinFromCLI(t, f, joinCLIOpts{JoinOptions: JoinOptions{URL: commentLink(t, f.session), Name: "tate-pm"}})
	if err != nil {
		t.Fatal(err)
	}
	prototest.WaitFor(t, wait, func() bool { c := g.Comments(); return len(c) == 1 && len(c[0].Threads) == 1 }, "the thread")
	deaf.Store(true)
	res, err := g.Reply("", "c0", "r1", "Lost")
	if err != nil || res.Delivered {
		t.Fatalf("%+v %v", res, err)
	}
}
