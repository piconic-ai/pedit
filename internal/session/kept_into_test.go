package session

import (
	"context"
	"errors"
	"net/http"
	"testing"

	"github.com/piconic-ai/pedit/internal/protocol"
	"github.com/piconic-ai/pedit/internal/protocol/prototest"
)

type handed struct{ base, next string }

// intoOptions closes into an app that records what it is handed.
func intoOptions(a *awayRoom, calls *[]handed, saved func() error) KeptTextOptions {
	opts := closeOptions(a)
	opts.Into = func(base, next string) { *calls = append(*calls, handed{base, next}) }
	opts.Saved = saved
	return opts
}

// The log is taken in and saved, and the close is interrupted before the app
// has the edit: the retry hands the app the guest's edit, once, from the text
// the app last received and not from the document replay advanced.
func TestCloseIntoHandsOverAnEditOnceAfterAnInterruptionBeforeHandover(t *testing.T) {
	a := newAwayRoom(t, "notes\n")
	_, guest := keepAndLeave(t, a)
	entry := guest.insert(0, "guest ")
	a.script(1, protocol.EncodeLogged(1, entry), protocol.EncodeLogEnd(1))
	a.closeAsks(func(int) int { return http.StatusOK })

	ctx, cancel := context.WithCancel(context.Background())
	a.onCheckpoint = func(*prototest.ScriptConn) { cancel() }
	var calls []handed
	if err := CloseKept(ctx, intoOptions(a, &calls, nil)); err == nil {
		t.Fatal("closed although interrupted")
	}
	if len(calls) != 0 {
		t.Fatalf("the app was handed %v before the interruption", calls)
	}
	rec := a.record()
	if rec.Files[0].Handover == nil || *rec.Files[0].Handover != "notes\n" {
		t.Fatalf("record handover %v", rec.Files[0].Handover)
	}
	if stateText(t, rec.Files[0].State) != "guest notes\n" {
		t.Fatalf("replay was not saved: %q", stateText(t, rec.Files[0].State))
	}

	a.onCheckpoint = nil
	a.script(1, protocol.EncodeLogged(1, entry), protocol.EncodeLogEnd(1))
	if err := CloseKept(context.Background(), intoOptions(a, &calls, nil)); err != nil {
		t.Fatal(err)
	}
	if len(calls) != 1 || calls[0] != (handed{"notes\n", "guest notes\n"}) {
		t.Fatalf("the app was handed %v", calls)
	}
}

// The app has the edit but cannot save it: the retry has it saved, and does
// not hand the same edit over again.
func TestCloseIntoHandsOverOnceWhenTheSaveFails(t *testing.T) {
	a := newAwayRoom(t, "notes\n")
	_, guest := keepAndLeave(t, a)
	a.script(1, protocol.EncodeLogged(1, guest.insert(0, "guest ")), protocol.EncodeLogEnd(1))
	a.closeAsks(func(int) int { return http.StatusOK })

	var calls []handed
	failing := func() error { return errors.New("disk full") }
	if err := CloseKept(context.Background(), intoOptions(a, &calls, failing)); err == nil {
		t.Fatal("closed although the app could not save")
	}
	if len(calls) != 1 || calls[0] != (handed{"notes\n", "guest notes\n"}) {
		t.Fatalf("the app was handed %v", calls)
	}
	if rec := a.record(); rec.Files[0].Handover == nil || *rec.Files[0].Handover != "guest notes\n" {
		t.Fatalf("record handover %v", rec.Files[0].Handover)
	}

	saves := 0
	a.script(1, protocol.EncodeLogEnd(1))
	if err := CloseKept(context.Background(), intoOptions(a, &calls, func() error { saves++; return nil })); err != nil {
		t.Fatal(err)
	}
	if saves != 1 {
		t.Fatalf("saved %d times", saves)
	}
	for _, c := range calls[1:] {
		if c.base != c.next {
			t.Fatalf("the app was handed %v again", c)
		}
	}
}
