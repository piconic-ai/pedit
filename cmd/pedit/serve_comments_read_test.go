package main

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"runtime"
	"strings"
	"testing"

	"github.com/piconic-ai/pedit/internal/meta"
	"github.com/piconic-ai/pedit/internal/session"
)

func (r *recorder) Comments(context.Context) error {
	r.calls = append(r.calls, "comments")
	return r.err
}

func (b *blocking) Comments(context.Context) error { b.note("comments"); return nil }

type commentsAnswer struct {
	Event string         `json:"event"`
	ID    string         `json:"id"`
	Seq   int            `json:"seq"`
	Done  bool           `json:"done"`
	Parts []commentsPart `json:"parts"`
}

func (a *app) readComments(id string) []threadView {
	a.t.Helper()
	a.command(fmt.Sprintf(`{"cmd":"comments","id":%q}`, id))
	var pages []commentsAnswer
	eventually(a.t, "all comments response pages", func() bool {
		pages = nil
		for _, f := range wholeFrames(a.out.String()) {
			var raw map[string]any
			if f.kind == 4 && json.Unmarshal(f.payload, &raw) == nil && raw["event"] == "error" && raw["id"] == id {
				a.t.Fatalf("comments error: %+v", raw)
			}
			var page commentsAnswer
			if f.kind == 4 && json.Unmarshal(f.payload, &page) == nil && page.Event == "comments_page" && page.ID == id {
				if len(f.payload) > 64<<10 {
					a.t.Fatalf("page has %d bytes", len(f.payload))
				}
				pages = append(pages, page)
				if page.Done {
					return true
				}
			}
		}
		return false
	})
	threads := []threadView{}
	for i, page := range pages {
		if page.Seq != i {
			a.t.Fatalf("sequence %d at %d", page.Seq, i)
		}
		for _, part := range page.Parts {
			if part.Offset == 0 {
				th := part.Thread
				th.Messages = []messageView{}
				threads = append(threads, th)
			}
			th := &threads[len(threads)-1]
			if len(th.Messages) != part.Offset {
				a.t.Fatalf("offset %d after %d messages", part.Offset, len(th.Messages))
			}
			th.Messages = append(th.Messages, part.Messages...)
		}
	}
	return threads
}

func TestServeReadSavedComments(t *testing.T) {
	root := t.TempDir()
	dir := filepath.Join(root, ".pedit", "meta")
	if err := os.MkdirAll(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, ".pedit", "config.yaml"), []byte("server: https://edit.piconic.ai\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	file := filepath.Join(root, "a.md")
	if err := os.WriteFile(file, []byte("😀\r\nhello wide world\r\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	saved := `{"version":1,"path":"a.md","comments":{"t1":{"anchor":{"type":"text","exact":"wide","prefix":"hello ","suffix":" world","offset":9},"quote":"wide","resolved":false,"messages":{"m1":{"author":"A\u202e","time":"2026-11-01T00:00:00Z","body":"Why?\u0001"}}},"t2":{"anchor":{"type":"text","exact":"missing","offset":0},"quote":"missing","resolved":true,"messages":{}}}}`
	name := filepath.Join(dir, "a.md.json")
	if err := os.WriteFile(name, []byte(saved), 0o600); err != nil {
		t.Fatal(err)
	}
	a := startApp(t, file)
	p := a.openPage(1)
	eventually(t, "the normalized page text", func() bool { return p.get() == "😀\nhello wide world\n" })
	p.insert(0, ">> ")
	eventually(t, "the changed document", func() bool { return strings.HasPrefix(p.get(), ">> ") })
	threads := a.readComments("saved")
	if len(threads) != 2 || threads[1].ID != "t1" || threads[1].From == nil || *threads[1].From != 12 || *threads[1].To != 16 || threads[1].Messages[0].Author != "A" || threads[1].Messages[0].Body != "Why?" || threads[0].From != nil || !threads[0].Resolved {
		t.Fatalf("saved threads %+v", threads)
	}
	if got, err := os.ReadFile(name); err != nil || string(got) != saved {
		t.Fatalf("metadata was changed: %s, %v", got, err)
	}
	if err := os.WriteFile(name, []byte(`{"version":99}`), 0o600); err != nil {
		t.Fatal(err)
	}
	a.command(`{"cmd":"comments","id":"invalid"}`)
	a.errorOf(1, "comments", "newer pedit")
	if err := os.Remove(name); err != nil {
		t.Fatal(err)
	}
	if got := a.readComments("absent"); len(got) != 0 {
		t.Fatalf("absent: %+v", got)
	}
	if runtime.GOOS != "windows" {
		outside := t.TempDir()
		if err := os.WriteFile(filepath.Join(outside, "a.md.json"), []byte(saved), 0o600); err != nil {
			t.Fatal(err)
		}
		if err := os.Remove(dir); err != nil {
			t.Fatal(err)
		}
		if err := os.Symlink(outside, dir); err != nil {
			t.Fatal(err)
		}
		a.command(`{"cmd":"comments","id":"link"}`)
		a.errorOf(2, "comments", "not a directory")
	}
	if a.countEvents("comments") != 0 {
		t.Fatal("a query published a live comments event")
	}
	if code := a.stop(); code != 0 {
		t.Fatalf("exit %d: %s", code, a.stderr.String())
	}
}

func TestServeReadLiveAndUnsharedComments(t *testing.T) {
	env := newShareEnv(t)
	root := t.TempDir()
	if err := os.Mkdir(filepath.Join(root, ".pedit"), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, ".pedit", "config.yaml"), []byte("server: https://edit.piconic.ai\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	file := filepath.Join(root, "a.md")
	if err := os.WriteFile(file, []byte("hello wide world\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	a := startApp(t, file)
	a.share(fmt.Sprintf(`,"relay":%q`, env.server.URL))
	a.command(`{"cmd":"comment","from":6,"to":10,"body":"live"}`)
	a.event("commented", 1)
	live := a.readComments("live")
	if len(live) != 1 || live[0].Messages[0].Body != "live" {
		t.Fatalf("live %+v", live)
	}
	a.command(`{"cmd":"unshare"}`)
	a.event("unshared", 1)
	if saved := a.readComments("away"); !reflect.DeepEqual(saved, live) {
		t.Fatalf("saved %+v, live %+v", saved, live)
	}
	a.command(`{"cmd":"comment","from":0,"to":1,"body":"refused"}`)
	a.errorOf(1, "comment", "not shared")
	if code := a.stop(); code != 0 {
		t.Fatalf("exit %d", code)
	}
}

func TestCommentsPagesKeepEveryMessageWithinTheLimit(t *testing.T) {
	from, to := 4, 5
	threads := []session.PlacedThread{}
	for i := range 15 {
		th := session.PlacedThread{Shown: meta.Shown{ID: fmt.Sprint(i), Quote: strings.Repeat("<", 1000), Resolved: i%2 == 0}, From: from, To: to, Placed: true}
		for j := range 200 {
			th.Messages = append(th.Messages, meta.ShownMessage{ID: fmt.Sprint(j), Author: strings.Repeat("&", 200), Time: "T", Body: strings.Repeat("<", 4000)})
		}
		threads = append(threads, th)
	}
	threads = append(threads, session.PlacedThread{Shown: meta.Shown{ID: "empty"}})
	got := []threadView{}
	pages := 0
	err := sendCommentsPages(threads, func(seq int, done bool, parts []commentsPart) error {
		payload, err := json.Marshal(map[string]any{"event": "comments_page", "id": strings.Repeat("\x00", 64), "seq": seq, "done": done, "parts": parts})
		if err != nil || len(payload) > 64<<10 {
			t.Fatalf("%d bytes, %v", len(payload), err)
		}
		if seq != pages {
			t.Fatalf("sequence %d at %d", seq, pages)
		}
		pages++
		for _, part := range parts {
			if part.Offset == 0 {
				th := part.Thread
				th.Messages = []messageView{}
				got = append(got, th)
			}
			th := &got[len(got)-1]
			if len(th.Messages) != part.Offset {
				t.Fatal("message offset")
			}
			th.Messages = append(th.Messages, part.Messages...)
		}
		return nil
	})
	if err != nil || pages < 2 || len(got) != len(threads) {
		t.Fatalf("pages %d threads %d error %v", pages, len(got), err)
	}
	for i, want := range threads {
		if !reflect.DeepEqual(got[i], viewOf(want)) {
			t.Fatalf("thread %d differs", i)
		}
	}
}

func TestCommentsCommandRejectsFields(t *testing.T) {
	for _, raw := range []string{`{"cmd":"comments","keep":"1d"}`, `{"cmd":"comments","thread":"t"}`, `{"cmd":"comments","cursor":"x"}`} {
		_, _, err := parseCommand([]byte(raw))
		if err == nil {
			t.Fatalf("accepted %s", raw)
		}
	}
	r := &recorder{}
	runCommands(t, r, `{"cmd":"comments"}`)
	if !reflect.DeepEqual(r.calls, []string{"comments"}) {
		t.Fatal(r.calls)
	}
}
