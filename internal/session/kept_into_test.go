package session

import (
	"context"
	"errors"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/piconic-ai/pedit/internal/merge"
	"github.com/piconic-ai/pedit/internal/protocol"
	"github.com/piconic-ai/pedit/internal/protocol/prototest"
	"github.com/reearth/ygo/crdt"
)

// intoApp is the app's document, which takes the room's edits with the same
// text merge serve uses, so that a second handover shows as duplicate text.
type intoApp struct {
	doc  *crdt.Doc
	text *crdt.YText
}

func newIntoApp(s string) *intoApp {
	a := &intoApp{doc: crdt.New()}
	a.text = a.doc.GetText("content")
	a.doc.Transact(func(txn *crdt.Transaction) { a.text.Insert(txn, 0, s, nil) })
	return a
}

func (a *intoApp) get() string { return a.text.ToString() }

func (a *intoApp) into(base, next string) { merge.ExternalEdit(a.doc, a.text, base, next, nil) }

// intoOptions closes into *app. The app may be replaced by the test, as a
// restart of the app would.
func intoOptions(a *awayRoom, app **intoApp, saved func() error) KeptTextOptions {
	opts := closeOptions(a)
	opts.Into = func(base, next string) { (*app).into(base, next) }
	opts.AppText = func() string { return (*app).get() }
	opts.Saved = saved
	return opts
}

func mustCount(t *testing.T, text, part string, n int) {
	t.Helper()
	if strings.Count(text, part) != n {
		t.Fatalf("%q holds %q %d times, want %d", text, part, strings.Count(text, part), n)
	}
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

	app := newIntoApp("notes\n")
	ctx, cancel := context.WithCancel(context.Background())
	a.onCheckpoint = func(*prototest.ScriptConn) { cancel() }
	if err := CloseKept(ctx, intoOptions(a, &app, nil)); err == nil {
		t.Fatal("closed although interrupted")
	}
	if app.get() != "notes\n" {
		t.Fatalf("the app was handed %q before the interruption", app.get())
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
	if err := CloseKept(context.Background(), intoOptions(a, &app, nil)); err != nil {
		t.Fatal(err)
	}
	if app.get() != "guest notes\n" {
		t.Fatalf("the app holds %q", app.get())
	}
}

// The save fails and the app is lost with what it held, recreated from the
// last text it saved: the retry hands the edit over again, and once.
func TestCloseIntoHandsOverAgainWhenTheAppRestartedAfterAFailedSave(t *testing.T) {
	a := newAwayRoom(t, "notes\n")
	_, guest := keepAndLeave(t, a)
	a.script(1, protocol.EncodeLogged(1, guest.insert(0, "guest ")), protocol.EncodeLogEnd(1))
	a.closeAsks(func(int) int { return http.StatusOK })

	app := newIntoApp("notes\n")
	failing := func() error { return errors.New("disk full") }
	if err := CloseKept(context.Background(), intoOptions(a, &app, failing)); err == nil {
		t.Fatal("closed although the app could not save")
	}
	if app.get() != "guest notes\n" {
		t.Fatalf("the app holds %q", app.get())
	}
	app = newIntoApp("notes\n") // restarted from what it had saved

	a.script(1, protocol.EncodeLogEnd(1))
	if err := CloseKept(context.Background(), intoOptions(a, &app, func() error { return nil })); err != nil {
		t.Fatal(err)
	}
	if app.get() != "guest notes\n" {
		t.Fatalf("the app holds %q", app.get())
	}
}

// The save fails with the app alive and more is written meanwhile: the retry
// hands over only what the app lacks, so each edit is in once.
func TestCloseIntoHandsOverOnlyWhatIsMissingWhenTheAppSurvivedAFailedSave(t *testing.T) {
	a := newAwayRoom(t, "notes\n")
	_, guest := keepAndLeave(t, a)
	a.script(1, protocol.EncodeLogged(1, guest.insert(0, "guest ")), protocol.EncodeLogEnd(1))
	a.closeAsks(func(int) int { return http.StatusOK })

	app := newIntoApp("notes\n")
	failing := func() error { return errors.New("disk full") }
	if err := CloseKept(context.Background(), intoOptions(a, &app, failing)); err == nil {
		t.Fatal("closed although the app could not save")
	}

	a.script(2, protocol.EncodeLogged(2, guest.insert(0, "more ")), protocol.EncodeLogEnd(2))
	if err := CloseKept(context.Background(), intoOptions(a, &app, func() error { return nil })); err != nil {
		t.Fatal(err)
	}
	got := app.get()
	mustCount(t, got, "guest ", 1)
	mustCount(t, got, "more ", 1)
	mustCount(t, got, "notes\n", 1)
}

// The app has the edit and has saved it, and the close dies before the record
// says so: the retry sees the app already holds the room's text and does not
// hand the edit over a second time.
func TestCloseIntoDoesNotHandOverAgainAfterACrashAfterTheSave(t *testing.T) {
	a := newAwayRoom(t, "notes\n")
	_, guest := keepAndLeave(t, a)
	a.script(1, protocol.EncodeLogged(1, guest.insert(0, "guest ")), protocol.EncodeLogEnd(1))
	a.closeAsks(func(int) int { return http.StatusOK })

	app := newIntoApp("notes\n")
	dir := filepath.Dir(keptTestStatePath(t, a.project, a.id))
	// Once the app has saved, the record cannot be written: the process "dies".
	t.Cleanup(func() { _ = os.Chmod(dir, 0o700) })
	err := CloseKept(context.Background(), intoOptions(a, &app, func() error { return os.Chmod(dir, 0o500) }))
	if err == nil {
		t.Fatal("closed although the record could not be written")
	}
	if err := os.Chmod(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	if rec := a.record(); rec.Files[0].Handover == nil || *rec.Files[0].Handover != "notes\n" {
		t.Fatalf("record handover %v", rec.Files[0].Handover)
	}

	a.script(1, protocol.EncodeLogEnd(1))
	if err := CloseKept(context.Background(), intoOptions(a, &app, nil)); err != nil {
		t.Fatal(err)
	}
	mustCount(t, app.get(), "guest ", 1)
	mustCount(t, app.get(), "notes\n", 1)
}
