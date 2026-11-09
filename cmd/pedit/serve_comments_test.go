package main

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"

	"github.com/piconic-ai/pedit/internal/meta"
	"github.com/piconic-ai/pedit/internal/session"
)

// commentsWhere waits for a comments event that holds, and returns its threads.
func (a *app) commentsWhere(what string, ok func(threads []map[string]any) bool) []map[string]any {
	a.t.Helper()
	var found []map[string]any
	eventually(a.t, what, func() bool {
		for _, f := range wholeFrames(a.out.String()) {
			var e struct {
				Event   string           `json:"event"`
				Threads []map[string]any `json:"threads"`
			}
			if f.kind == 4 && json.Unmarshal(f.payload, &e) == nil && e.Event == "comments" && ok(e.Threads) {
				found = e.Threads
				return true
			}
		}
		return false
	})
	return found
}

func (a *app) countEvents(name string) int {
	n := 0
	for _, f := range wholeFrames(a.out.String()) {
		var e map[string]any
		if f.kind == 4 && json.Unmarshal(f.payload, &e) == nil && e["event"] == name {
			n++
		}
	}
	return n
}

func offsets(th map[string]any) string { return fmt.Sprint(th["from"], "-", th["to"]) }

func TestServeCommentsFromTheApp(t *testing.T) {
	env := newShareEnv(t)
	file := writeFile(t, "hello wide world\n")
	a := startApp(t, file)
	p := a.openPage(1)
	eventually(t, "the page's text", func() bool { return p.get() == "hello wide world\n" })
	shared := a.share(fmt.Sprintf(`,"relay":%q`, env.server.URL))

	// The threads as sharing starts: none.
	a.commentsWhere("the first comments event", func(th []map[string]any) bool { return len(th) == 0 })

	// A thread on "wide", as the browser makes it, answered with its id.
	a.command(`{"cmd":"comment","from":6,"to":10,"body":" Why wide? ","id":"c1"}`)
	started := a.event("commented", 1)
	thread, _ := started["thread"].(string)
	if started["id"] != "c1" || thread == "" || started["message"] == "" {
		t.Fatalf("commented %v", started)
	}
	th := a.commentsWhere("the new thread", func(th []map[string]any) bool { return len(th) == 1 })[0]
	msgs := th["messages"].([]any)
	if th["id"] != thread || th["quote"] != "wide" || th["resolved"] != false || offsets(th) != "6-10" ||
		len(msgs) != 1 || msgs[0].(map[string]any)["body"] != "Why wide?" || msgs[0].(map[string]any)["author"] == "" {
		t.Fatalf("thread %v", th)
	}

	// A reviewer sees it, and replies; the app hears.
	g := env.join(t, linkOf(shared, "comment"), "ada")
	eventually(t, "the thread at the guest", func() bool {
		c := g.Comments()
		return len(c) == 1 && len(c[0].Threads) == 1 && c[0].Threads[0].Quote == "wide"
	})
	if res, err := g.Reply("", thread, "r1", "Too wide"); err != nil || !res.Delivered {
		t.Fatalf("%+v %v", res, err)
	}
	a.commentsWhere("the guest's reply", func(th []map[string]any) bool {
		return len(th) == 1 && len(th[0]["messages"].([]any)) == 2
	})

	// The app replies and resolves; the answers carry its ids.
	a.command(fmt.Sprintf(`{"cmd":"reply","thread":%q,"body":"Fixed","id":"r"}`, thread))
	if e := a.event("replied", 1); e["id"] != "r" || e["thread"] != thread || e["message"] == "" {
		t.Fatalf("replied %v", e)
	}
	a.command(fmt.Sprintf(`{"cmd":"resolve","thread":%q,"resolved":true,"id":"s"}`, thread))
	if e := a.event("resolved", 1); e["id"] != "s" || e["resolved"] != true {
		t.Fatalf("resolved %v", e)
	}
	a.commentsWhere("resolved with three comments", func(th []map[string]any) bool {
		return len(th) == 1 && th[0]["resolved"] == true && len(th[0]["messages"].([]any)) == 3
	})
	eventually(t, "the guest sees it resolved", func() bool { return g.Comments()[0].Threads[0].Resolved })

	// Text typed in the page moves the anchor: an event with the new offsets,
	// and the same state is never sent twice.
	p.insert(0, ">> ")
	a.commentsWhere("the moved anchor", func(th []map[string]any) bool { return len(th) == 1 && offsets(th[0]) == "9-13" })
	before := a.countEvents("comments")
	a.command(fmt.Sprintf(`{"cmd":"resolve","thread":%q,"resolved":true}`, thread))
	a.event("resolved", 2)
	if after := a.countEvents("comments"); after != before {
		t.Fatalf("%d comments events, then %d for a change of nothing", before, after)
	}

	// Mistakes are errors, and the share goes on.
	for i, c := range []struct{ cmd, msg string }{
		{`{"cmd":"comment","from":0,"to":9999,"body":"x"}`, "outside the text"},
		{`{"cmd":"comment","from":0,"to":3,"body":"  "}`, "empty"},
		{`{"cmd":"reply","thread":"nope","body":"x"}`, "no such thread"},
		{`{"cmd":"resolve","thread":"nope","resolved":true}`, "no such thread"},
	} {
		a.command(c.cmd)
		name, _, _ := strings.Cut(strings.TrimPrefix(c.cmd, `{"cmd":"`), `"`)
		a.errorOf(i+1, name, c.msg)
	}

	// Not shared: refused.
	a.command(`{"cmd":"unshare"}`)
	a.event("unshared", 1)
	a.command(`{"cmd":"comment","from":0,"to":3,"body":"x"}`)
	a.errorOf(5, "comment", "not shared")
	a.command(`{"cmd":"reply","thread":"` + thread + `","body":"x"}`)
	a.errorOf(6, "reply", "not shared")
	if code := a.stop(); code != 0 {
		t.Fatalf("code %d, stderr %s", code, a.stderr.String())
	}
}

func TestServeCommentsOnATableAreRefused(t *testing.T) {
	env := newShareEnv(t)
	file := filepath.Join(t.TempDir(), "a.csv")
	if err := os.WriteFile(file, []byte("a,b\n1,2\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	a := startApp(t, file)
	a.share(fmt.Sprintf(`,"relay":%q`, env.server.URL))
	a.command(`{"cmd":"comment","from":0,"to":1,"body":"x"}`)
	a.errorOf(1, "comment", "text or Markdown")
	if code := a.stop(); code != 0 {
		t.Fatalf("code %d, stderr %s", code, a.stderr.String())
	}
}

func placed(id string, resolved bool, n int) session.PlacedThread {
	t := session.PlacedThread{Placed: true, From: 1, To: 2}
	t.ID, t.Resolved, t.Quote = id, resolved, "q"
	for i := range n {
		t.Messages = append(t.Messages, meta.ShownMessage{ID: fmt.Sprintf("m%d", i), Author: "a", Time: "2026-11-09T00:00:00.000Z", Body: "b"})
	}
	return t
}

func TestCommentsEventFitsTheLimit(t *testing.T) {
	big := strings.Repeat("x", 4000)
	var threads []session.PlacedThread
	old := placed("old", true, 1)
	old.Messages[0].Body = big
	threads = append(threads, old)
	for i := range 40 {
		th := placed(fmt.Sprintf("t%d", i), false, 3)
		th.Messages[2].Body = big
		threads = append(threads, th)
	}
	ev := commentsEvent(threads)
	b, _ := json.Marshal(ev)
	if len(b) > maxCommentsEvent {
		t.Fatalf("%d bytes", len(b))
	}
	shown := ev["threads"].([]threadView)
	if ev["more"] == nil || len(shown)+ev["more"].(int) != len(threads) {
		t.Fatalf("%d shown, more %v", len(shown), ev["more"])
	}
	// Open threads first: the resolved one is the one left out, and order is kept.
	if shown[0].ID != "t0" || slices.ContainsFunc(shown, func(v threadView) bool { return v.ID == "old" }) {
		t.Fatalf("shown %v", shown)
	}
}

func TestCommentsEventCutsTheOldestComments(t *testing.T) {
	th := placed("t", false, 20)
	for i := range th.Messages {
		th.Messages[i].Body = strings.Repeat("y", 4000)
	}
	ev := commentsEvent([]session.PlacedThread{th})
	b, _ := json.Marshal(ev)
	v := ev["threads"].([]threadView)[0]
	if len(b) > maxCommentsEvent || v.Cut == 0 || v.Cut+len(v.Messages) != 20 || v.Messages[len(v.Messages)-1].ID != "m19" {
		t.Fatalf("%d bytes, cut %d, kept %d", len(b), v.Cut, len(v.Messages))
	}
	if _, more := ev["more"]; more {
		t.Fatal("more with the thread shown")
	}
	// One comment that cannot fit leaves its thread out.
	huge := placed("h", false, 1)
	huge.Messages[0].Body = strings.Repeat("z", 70<<10)
	if got := commentsEvent([]session.PlacedThread{huge}); len(got["threads"].([]threadView)) != 0 || got["more"] != 1 {
		t.Fatalf("%v", got)
	}
}
