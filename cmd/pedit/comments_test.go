package main

import (
	"bytes"
	"errors"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/piconic-ai/pedit/internal/meta"
	"github.com/piconic-ai/pedit/internal/session"
	"github.com/piconic-ai/pedit/internal/sessiondir"
)

// fakeSession answers as a session would, and records the writes.
type fakeSession struct {
	mu        sync.Mutex
	writes    []string
	delivered bool
	fail      error
}

func (f *fakeSession) Comments() []session.FileThreads {
	return []session.FileThreads{{File: "board.canvas", Threads: []meta.Shown{
		{ID: "t1", Kind: meta.AnchorNode, Node: "n1", Quote: "Ideas", Messages: []meta.ShownMessage{{ID: "m1", Author: "Ada", Time: "2026-10-21T00:00:00Z", Body: "Which one?\nThis?"}}},
		{ID: "t2", Kind: meta.AnchorText, Quote: "done\nlong", Resolved: true},
	}}}
}

func (f *fakeSession) Reply(file, thread, id, body string) (session.WriteResult, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.writes = append(f.writes, "reply "+file+" "+thread+" "+id+" "+body)
	return session.WriteResult{Delivered: f.delivered}, f.fail
}

func (f *fakeSession) Resolve(file, thread string, resolved bool) (session.WriteResult, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.writes = append(f.writes, map[bool]string{true: "resolve ", false: "reopen "}[resolved]+file+" "+thread)
	return session.WriteResult{Delivered: f.delivered}, f.fail
}

// withSessions has sessions register under a directory of the test's.
func withSessions(t *testing.T) {
	base := filepath.Join(t.TempDir(), "sessions")
	old, oldWait := sessionBase, waitAnswer
	sessionBase = func() (string, error) { return base, nil }
	waitAnswer = 5 * time.Second
	t.Cleanup(func() { sessionBase, waitAnswer = old, oldWait })
}

func runCommentsCmd(args ...string) (int, string, string) {
	var out, errOut bytes.Buffer
	code := runComments(args, &out, &errOut)
	return code, out.String(), errOut.String()
}

func TestCommentsReachTheSession(t *testing.T) {
	withSessions(t)
	if code, _, errOut := runCommentsCmd(); code != 1 || !strings.Contains(errOut, "pedit <file> --json") {
		t.Fatalf("without a session: %d %q", code, errOut)
	}
	s := &fakeSession{delivered: true}
	var stderr bytes.Buffer
	id, stop := commentsChannel(s, sessiondir.Info{Room: "ROOM", Access: "edit", Name: "tate-pm"}, &stderr)
	defer stop()
	if id == "" {
		t.Fatalf("not registered: %s", stderr.String())
	}

	code, out, _ := runCommentsCmd()
	if code != 0 || out != "t1  board.canvas  \"node n1\"\n  Ada, 2026-10-21T00:00:00Z:\n    Which one?\n    This?\n" {
		t.Fatalf("list: %d %q", code, out)
	}
	if code, out, _ := runCommentsCmd("list", "--file", "other.md", "--json"); code != 0 || out != "[]\n" {
		t.Fatalf("another file's threads: %d %q", code, out)
	}
	code, out, _ = runCommentsCmd("list", "--all", "--json")
	if code != 0 || !strings.HasPrefix(out, `[{"file":"board.canvas","thread":"t1","anchor":{"type":"node","id":"n1"},"quote":"Ideas","resolved":false,"messages":[{"id":"m1","author":"Ada"`) || !strings.Contains(out, `"thread":"t2"`) {
		t.Fatalf("list --all --json: %d %s", code, out)
	}
	code, out, _ = runCommentsCmd("reply", "--room", "ROOM", "--id", "r1", "t1", "This one.")
	if code != 0 || out != "r1\n" {
		t.Fatalf("reply: %d %q", code, out)
	}
	if code, _, _ := runCommentsCmd("resolve", "--file", "board.canvas", "t1"); code != 0 {
		t.Fatal(code)
	}
	if code, _, _ := runCommentsCmd("reopen", "--room", id, "t1"); code != 0 {
		t.Fatal(code)
	}
	want := []string{"reply  t1 r1 This one.", "resolve board.canvas t1", "reopen  t1"}
	if strings.Join(s.writes, "|") != strings.Join(want, "|") {
		t.Fatalf("%q", s.writes)
	}

	s.delivered = false
	if code, _, errOut := runCommentsCmd("reply", "--id", "r2", "t1", "Again"); code != 3 || !strings.Contains(errOut, "--id r2") {
		t.Fatalf("not confirmed: %d %q", code, errOut)
	}
	s.fail = errors.New("no such thread")
	if code, _, errOut := runCommentsCmd("resolve", "t9"); code != 1 || !strings.Contains(errOut, "no such thread") {
		t.Fatalf("failed: %d %q", code, errOut)
	}
	if code, _, _ := runCommentsCmd("--room", "OTHER"); code != 1 {
		t.Fatal("another room's session was used")
	}
}

func TestSeveralSessionsAskForARoom(t *testing.T) {
	withSessions(t)
	var stderr bytes.Buffer
	_, stop1 := commentsChannel(&fakeSession{}, sessiondir.Info{Room: "ROOM1", Files: []string{"a.md"}}, &stderr)
	defer stop1()
	_, stop2 := commentsChannel(&fakeSession{}, sessiondir.Info{Room: "ROOM2", Files: []string{"b.md"}}, &stderr)
	defer stop2()
	if code, _, errOut := runCommentsCmd(); code != 1 || !strings.Contains(errOut, "--room ROOM1") || !strings.Contains(errOut, "--room ROOM2") {
		t.Fatalf("%d %q", code, errOut)
	}
	if code, _, _ := runCommentsCmd("--room", "ROOM2"); code != 0 {
		t.Fatal(code)
	}
}

func TestParseCommentsArgs(t *testing.T) {
	a, err := parseCommentsArgs([]string{"reply", "t1", "-"}, strings.NewReader("from stdin\n"))
	if err != nil || a.body != "from stdin" || a.thread != "t1" || len(a.id) != 16 {
		t.Fatalf("%+v %v", a, err)
	}
	for _, args := range [][]string{
		{"delete", "t1"},
		{"reply", "t1"},
		{"resolve"},
		{"resolve", "t1", "--json"},
		{"list", "--id", "x"},
		{"list", "--room"},
		{"list", "--bogus"},
		{"list", "extra"},
	} {
		if _, err := parseCommentsArgs(args, strings.NewReader("")); err == nil {
			t.Fatalf("%q was taken", args)
		}
	}
}
