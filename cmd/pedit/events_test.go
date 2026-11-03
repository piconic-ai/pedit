package main

import (
	"bytes"
	"strings"
	"testing"

	"github.com/piconic-ai/pedit/internal/meta"
	"github.com/piconic-ai/pedit/internal/protocol"
	"github.com/piconic-ai/pedit/internal/session"
)

func TestEventsAreOneJSONObjectALine(t *testing.T) {
	var out bytes.Buffer
	ev := newEvents(&out)
	thread := meta.Shown{ID: "t1", Kind: meta.AnchorNode, Node: "n1", Quote: "Ideas <&>"}
	msg := meta.ShownMessage{ID: "m1", Author: "Ada", Time: "2026-10-21T00:00:00Z", Body: "Line one\nline two"}
	ev.ready("ROOM", protocol.AccessComment, []protocol.FileEntry{{Path: "notes.md"}}, nil)
	ev.status(protocol.StatusConnected)
	ev.comment(session.CommentChange{File: "a.canvas", Change: meta.Change{Kind: meta.ChangeComment, Thread: thread, Message: msg, NewThread: true}})
	ev.comment(session.CommentChange{File: "a.canvas", Change: meta.Change{Kind: meta.ChangeComment, Thread: meta.Shown{ID: "t2", Kind: meta.AnchorText}, Message: msg}})
	ev.comment(session.CommentChange{File: "a.canvas", Change: meta.Change{Kind: meta.ChangeEdited, Thread: thread, Message: msg}})
	ev.comment(session.CommentChange{File: "a.canvas", Change: meta.Change{Kind: meta.ChangeDeleted, Thread: thread}})
	ev.comment(session.CommentChange{File: "a.canvas", Change: meta.Change{Kind: meta.ChangeResolved, Thread: thread}})
	ev.ended("")
	ev.ended(protocol.StatusClosed)
	want := strings.Join([]string{
		`{"event":"ready","room":"ROOM","access":"comment","files":["notes.md"]}`,
		`{"event":"status","status":"connected"}`,
		`{"event":"comment","file":"a.canvas","thread":"t1","message":"m1","author":"Ada","time":"2026-10-21T00:00:00Z","body":"Line one\nline two","quote":"Ideas <&>","anchor":{"type":"node","id":"n1"},"new_thread":true}`,
		`{"event":"comment","file":"a.canvas","thread":"t2","message":"m1","author":"Ada","time":"2026-10-21T00:00:00Z","body":"Line one\nline two","quote":"","anchor":{"type":"text"},"new_thread":false}`,
		`{"event":"edited","file":"a.canvas","thread":"t1","message":"m1","body":"Line one\nline two"}`,
		`{"event":"deleted","file":"a.canvas","thread":"t1","message":""}`,
		`{"event":"resolved","file":"a.canvas","thread":"t1"}`,
		`{"event":"ended","reason":"stopped"}`,
		`{"event":"ended","reason":"closed"}`,
	}, "\n") + "\n"
	if out.String() != want {
		t.Fatalf("got\n%s\nwant\n%s", out.String(), want)
	}
}

func TestNoEventsWithoutJSON(t *testing.T) {
	var ev *events
	ev.ready("ROOM", protocol.AccessEdit, nil, nil)
	ev.status(protocol.StatusConnected)
	ev.ended("")
	if ev.commentHook() != nil {
		t.Fatal("a session without --json reads comments for nobody")
	}
}

func TestParseJSONAndName(t *testing.T) {
	opts, err := parseArgs([]string{"notes.md", "--json", "--name", " tate‮-pm\x1b "})
	if err != nil || !opts.JSON || opts.Name != "tate-pm" || opts.File != "notes.md" {
		t.Fatalf("%+v %v", opts, err)
	}
	opts, err = parseArgs([]string{"--name=" + strings.Repeat("😀", 150), "https://edit.piconic.ai/r/ROOM#key"})
	if err != nil || opts.Name != strings.Repeat("😀", 100) || opts.Room == "" {
		t.Fatalf("a name is cut to 200 UTF-16 code units: %d %v", len(opts.Name), err)
	}
	if nameOf(commandArgs{Name: "agent"}) != "agent" || nameOf(commandArgs{}) != username() {
		t.Fatal("nameOf")
	}
	for _, args := range [][]string{
		{"notes.md", "--name"},
		{"notes.md", "--name", "\x1b"},
		{"notes.md", "--name", "a", "--name", "b"},
		{"notes.md", "--json=yes"},
	} {
		if _, err := parseArgs(args); err == nil {
			t.Fatalf("%q was taken", args)
		}
	}
}
