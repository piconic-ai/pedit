package session

import (
	"slices"
	"sync"
	"testing"

	"github.com/piconic-ai/pedit/internal/meta"
	"github.com/piconic-ai/pedit/internal/protocol/prototest"
	"github.com/reearth/ygo/crdt"
)

// changesOf collects what OnComments reports.
type changesOf struct {
	mu  sync.Mutex
	all []string
}

func (c *changesOf) add(x CommentChange) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.all = append(c.all, x.Kind+" "+x.File+" "+x.Thread.ID+" "+x.Message.ID+" "+x.Message.Body)
}

func (c *changesOf) list() []string {
	c.mu.Lock()
	defer c.mu.Unlock()
	return slices.Clone(c.all)
}

func TestTheHostReportsChangesToTheComments(t *testing.T) {
	saved := `{"version":1,"path":"notes.md","comments":{"c0":{"anchor":{"type":"text","exact":"hello","prefix":"","suffix":" world","offset":0},"quote":"hello","resolved":false,"messages":{"m0":{"author":"Ada","time":"2026-10-20T00:00:00Z","body":"Saved before"}}}}}`
	var got changesOf
	f := setup(t, "hello world!\n", setupOpts{project: true, meta: saved, onComments: got.add})
	g := joinFiles(t, f.relay, f.session.URL)
	metaDoc := g.open(t, 1)
	prototest.WaitFor(t, wait, func() bool { return g.String() == "hello world!\n" }, "the text")
	prototest.WaitFor(t, wait, func() bool { return len(meta.ShownThreads(metaDoc)) == 1 }, "the saved thread")

	comment(t, metaDoc, g.doc, "c1", 6, 11, "Which world?")
	prototest.WaitFor(t, wait, func() bool { return len(got.list()) == 1 }, "the new thread")

	thread := metaDoc.GetMap(meta.CommentsKey)
	v, _ := thread.Get("c0")
	c0 := v.(*crdt.YMap)
	mv, _ := c0.Get(meta.MessagesKey)
	ms := mv.(*crdt.YMap)
	metaDoc.Transact(func(txn *crdt.Transaction) {
		ms.Set(txn, "m1", map[string]any{"author": "Bo", "time": "2026-10-21T00:00:00Z", "body": "A reply"})
		c0.Set(txn, meta.ResolvedKey, true)
	})
	prototest.WaitFor(t, wait, func() bool { return len(got.list()) == 3 }, "the reply and the resolving")

	if err := f.session.Stop(); err != nil {
		t.Fatal(err)
	}
	want := []string{
		"comment notes.md c1 m1 Which world?",
		"comment notes.md c0 m1 A reply",
		"resolved notes.md c0  ",
	}
	if l := got.list(); !slices.Equal(l, want) {
		t.Fatalf("got  %q\nwant %q", l, want)
	}
}
