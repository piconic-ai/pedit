package session

import (
	"errors"
	"os"
	"testing"

	"github.com/piconic-ai/pedit/internal/meta"
	"github.com/piconic-ai/pedit/internal/protocol/prototest"
)

func TestTheHostRepliesAndResolvesFromTheCommandLine(t *testing.T) {
	var got changesOf
	f := setup(t, "hello world!\n", setupOpts{project: true, onComments: got.add})
	f.session.opts.Name = "tate-pm"
	g := joinFiles(t, f.relay, f.session.URL)
	metaDoc := g.open(t, 1)
	prototest.WaitFor(t, wait, func() bool { return g.String() == "hello world!\n" }, "the text")
	comment(t, metaDoc, g.doc, "c1", 6, 11, "Which world?")
	prototest.WaitFor(t, wait, func() bool {
		c := f.session.Comments()
		return len(c) == 1 && len(c[0].Threads) == 1
	}, "the thread at the host")

	res, err := f.session.Reply("", "c1", "r1", "This one.")
	if err != nil || !res.Delivered {
		t.Fatalf("%+v %v", res, err)
	}
	// Sent again, it is written once.
	if _, err := f.session.Reply("notes.md", "c1", "r1", "This one."); err != nil {
		t.Fatal(err)
	}
	if _, err := f.session.Resolve("", "c1", true); err != nil {
		t.Fatal(err)
	}
	prototest.WaitFor(t, wait, func() bool {
		th := meta.ShownThreads(metaDoc)
		return len(th) == 1 && th[0].Resolved && len(th[0].Messages) == 2 && th[0].Messages[1].Author == "tate-pm"
	}, "the reply and the resolving at the guest")

	path := metaPathOf(f, "notes.md")
	prototest.WaitFor(t, wait, func() bool {
		data, err := os.ReadFile(path)
		if err != nil {
			return false
		}
		file, err := meta.Parse(data)
		return err == nil && file.Comments["c1"].Resolved && file.Comments["c1"].Messages["r1"].Body == "This one."
	}, "the host's own writes saved")

	for _, tc := range []struct {
		file, thread string
		want         error
	}{
		{"", "nope", meta.ErrNoThread},
		{"other.md", "c1", ErrNoFile},
	} {
		if _, err := f.session.Reply(tc.file, tc.thread, "r2", "x"); !errors.Is(err, tc.want) {
			t.Fatalf("%+v: %v", tc, err)
		}
	}
	if err := f.session.Stop(); err != nil {
		t.Fatal(err)
	}
	want := []string{
		"comment notes.md c1 m1 Which world?",
		"comment notes.md c1 r1 This one.",
		"resolved notes.md c1  ",
	}
	if l := got.list(); len(l) != len(want) || l[0] != want[0] || l[1] != want[1] || l[2] != want[2] {
		t.Fatalf("events %q", l)
	}
}
