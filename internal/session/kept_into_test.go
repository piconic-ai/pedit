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
// text merge serve uses, and hands back the update each made, as serve does.
type intoApp struct {
	doc        *crdt.Doc
	text       *crdt.YText
	generation string
}

func newIntoApp(s string) *intoApp {
	a := &intoApp{doc: crdt.New(), generation: "g1"}
	a.text = a.doc.GetText("content")
	a.doc.Transact(func(txn *crdt.Transaction) { a.text.Insert(txn, 0, s, nil) })
	return a
}

// restoredIntoApp is the app started again from a saved state of its document.
func restoredIntoApp(state []byte, generation string) *intoApp {
	a := &intoApp{doc: crdt.New(), generation: generation}
	a.text = a.doc.GetText("content")
	if err := crdt.ApplyUpdateV1(a.doc, state, nil); err != nil {
		panic(err)
	}
	return a
}

func (a *intoApp) state() []byte { return crdt.EncodeStateAsUpdateV1(a.doc, nil) }

func (a *intoApp) get() string { return a.text.ToString() }

func (a *intoApp) insert(at int, s string) {
	a.doc.Transact(func(txn *crdt.Transaction) { a.text.Insert(txn, at, s, nil) })
}

// prepare builds the edit on a copy and leaves the app alone, as serve does.
func (a *intoApp) prepare(base, next string) ([]byte, string) {
	doc := crdt.New(crdt.WithGC(false))
	if err := crdt.ApplyUpdateV1(doc, a.state(), nil); err != nil {
		panic(err)
	}
	before := doc.StateVector()
	merge.ExternalEdit(doc, doc.GetText("content"), base, next, nil)
	return crdt.EncodeStateAsUpdateV1(doc, before), a.generation
}

func (a *intoApp) reapply(update []byte, generation string) bool {
	return a.generation == generation && crdt.ApplyUpdateV1(a.doc, update, nil) == nil
}

// intoOptions closes into *app. The app may be replaced by the test, as a
// restart of the app would.
func intoOptions(a *awayRoom, app **intoApp, saved func() error) KeptTextOptions {
	opts := closeOptions(a)
	opts.Prepare = func(base, next string) ([]byte, string) { return (*app).prepare(base, next) }
	opts.Reapply = func(update []byte, generation string) bool { return (*app).reapply(update, generation) }
	opts.Saved = saved
	return opts
}

// remove makes the entry of deleting n characters at index.
func (g *guestDoc) remove(index, n int) []byte {
	g.t.Helper()
	before := g.doc.StateVector()
	text := g.doc.GetText("content")
	g.doc.Transact(func(tx *crdt.Transaction) { text.Delete(tx, index, n) })
	entry, err := protocol.SealKeptFileUpdate(g.keys, 0, crdt.EncodeStateAsUpdateV1(g.doc, before))
	if err != nil {
		g.t.Fatal(err)
	}
	return entry
}

func mustCount(t *testing.T, text, part string, n int) {
	t.Helper()
	if strings.Count(text, part) != n {
		t.Fatalf("%q holds %q %d times, want %d", text, part, strings.Count(text, part), n)
	}
}

var (
	saveFails = func() error { return errors.New("disk full") }
	saveWorks = func() error { return nil }
)

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

// The save fails and the app is started again from the state it had saved,
// which has the same history: the retry reapplies the delivery, once.
func TestCloseIntoRestoresTheDeliveryWhenTheAppRestartedAfterAFailedSave(t *testing.T) {
	a := newAwayRoom(t, "notes\n")
	_, guest := keepAndLeave(t, a)
	a.script(1, protocol.EncodeLogged(1, guest.insert(0, "guest ")), protocol.EncodeLogEnd(1))
	a.closeAsks(func(int) int { return http.StatusOK })

	app := newIntoApp("notes\n")
	saved := app.state()
	if err := CloseKept(context.Background(), intoOptions(a, &app, saveFails)); err == nil {
		t.Fatal("closed although the app could not save")
	}
	if app.get() != "guest notes\n" {
		t.Fatalf("the app holds %q", app.get())
	}
	app = restoredIntoApp(saved, "g1")

	a.script(1, protocol.EncodeLogEnd(1))
	if err := CloseKept(context.Background(), intoOptions(a, &app, saveWorks)); err != nil {
		t.Fatal(err)
	}
	if app.get() != "guest notes\n" {
		t.Fatalf("the app holds %q", app.get())
	}
}

// The app started afresh, so its history is gone: the retry falls back to the
// text diff from what the app saved.
func TestCloseIntoFallsBackToTheTextDiffWhenTheAppStartedAfresh(t *testing.T) {
	a := newAwayRoom(t, "notes\n")
	_, guest := keepAndLeave(t, a)
	a.script(1, protocol.EncodeLogged(1, guest.insert(0, "guest ")), protocol.EncodeLogEnd(1))
	a.closeAsks(func(int) int { return http.StatusOK })

	app := newIntoApp("notes\n")
	if err := CloseKept(context.Background(), intoOptions(a, &app, saveFails)); err == nil {
		t.Fatal("closed although the app could not save")
	}
	app = newIntoApp("notes\n")
	app.generation = "g2"

	a.script(1, protocol.EncodeLogEnd(1))
	if err := CloseKept(context.Background(), intoOptions(a, &app, saveWorks)); err != nil {
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
	if err := CloseKept(context.Background(), intoOptions(a, &app, saveFails)); err == nil {
		t.Fatal("closed although the app could not save")
	}

	a.script(2, protocol.EncodeLogged(2, guest.insert(0, "more ")), protocol.EncodeLogEnd(2))
	if err := CloseKept(context.Background(), intoOptions(a, &app, saveWorks)); err != nil {
		t.Fatal(err)
	}
	got := app.get()
	mustCount(t, got, "guest ", 1)
	mustCount(t, got, "more ", 1)
	mustCount(t, got, "notes\n", 1)
}

// The app has the edit and has saved it, and the close dies before the record
// says so: the retry reapplies the delivery, which changes nothing.
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

// A text replay of the delivery would delete what the app typed meanwhile:
// reapplying its update does not.
func TestCloseIntoKeepsWhatTheAppTypedAfterAFailedSave(t *testing.T) {
	a := newAwayRoom(t, "abc\n")
	_, guest := keepAndLeave(t, a)
	a.script(1, protocol.EncodeLogged(1, guest.remove(1, 1)), protocol.EncodeLogEnd(1))
	a.closeAsks(func(int) int { return http.StatusOK })

	app := newIntoApp("abc\n")
	if err := CloseKept(context.Background(), intoOptions(a, &app, saveFails)); err == nil {
		t.Fatal("closed although the app could not save")
	}
	if app.get() != "ac\n" {
		t.Fatalf("the app holds %q", app.get())
	}
	app.insert(1, "X")

	a.script(1, protocol.EncodeLogEnd(1))
	if err := CloseKept(context.Background(), intoOptions(a, &app, saveWorks)); err != nil {
		t.Fatal(err)
	}
	if app.get() != "aXc\n" {
		t.Fatalf("the app holds %q", app.get())
	}
}

// The app has content of its own that the room never had: the retry does not
// hand over the guest's edit again.
func TestCloseIntoHandsOverOnceToAppContentTheRoomNeverHad(t *testing.T) {
	a := newAwayRoom(t, "notes\n")
	_, guest := keepAndLeave(t, a)
	a.script(1, protocol.EncodeLogged(1, guest.insert(0, "guest ")), protocol.EncodeLogEnd(1))
	a.closeAsks(func(int) int { return http.StatusOK })

	app := newIntoApp("app notes\n")
	if err := CloseKept(context.Background(), intoOptions(a, &app, saveFails)); err == nil {
		t.Fatal("closed although the app could not save")
	}
	a.script(1, protocol.EncodeLogEnd(1))
	if err := CloseKept(context.Background(), intoOptions(a, &app, saveWorks)); err != nil {
		t.Fatal(err)
	}
	mustCount(t, app.get(), "guest ", 1)
	mustCount(t, app.get(), "app ", 1)
}

// The record of the delivery cannot be written: the app must stay as it was,
// so that a retry with the app alive finds nothing delivered and nothing
// unrecorded.
func TestCloseIntoLeavesTheAppAloneWhenTheDeliveryCannotBeRecorded(t *testing.T) {
	for _, tc := range []struct {
		name, room, app string
		entry           func(g *guestDoc) []byte
		typed           func(app *intoApp)
		want            string
	}{
		{"guest insertion", "notes\n", "notes\n", func(g *guestDoc) []byte { return g.insert(0, "guest ") }, func(*intoApp) {}, "guest notes\n"},
		{"deletion then typing", "abc\n", "abc\n", func(g *guestDoc) []byte { return g.remove(1, 1) }, func(a *intoApp) { a.insert(1, "X") }, "aXc\n"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			a := newAwayRoom(t, tc.room)
			_, guest := keepAndLeave(t, a)
			a.script(1, protocol.EncodeLogged(1, tc.entry(guest)), protocol.EncodeLogEnd(1))
			a.closeAsks(func(int) int { return http.StatusOK })

			app := newIntoApp(tc.app)
			dir := filepath.Dir(keptTestStatePath(t, a.project, a.id))
			t.Cleanup(func() { _ = os.Chmod(dir, 0o700) })
			opts := intoOptions(a, &app, saveWorks)
			prepare := opts.Prepare
			// The record cannot be written from the moment the edit is prepared.
			opts.Prepare = func(base, next string) ([]byte, string) {
				u, g := prepare(base, next)
				_ = os.Chmod(dir, 0o500)
				return u, g
			}
			if err := CloseKept(context.Background(), opts); err == nil {
				t.Fatal("closed although the delivery could not be recorded")
			}
			if err := os.Chmod(dir, 0o700); err != nil {
				t.Fatal(err)
			}
			if app.get() != tc.app {
				t.Fatalf("the app was changed to %q", app.get())
			}
			tc.typed(app)

			a.script(1, protocol.EncodeLogEnd(1))
			if err := CloseKept(context.Background(), intoOptions(a, &app, saveWorks)); err != nil {
				t.Fatal(err)
			}
			if app.get() != tc.want {
				t.Fatalf("the app holds %q, want %q", app.get(), tc.want)
			}
		})
	}
}
