package session

import (
	"context"
	"net/http"
	"os"
	"path/filepath"
	"testing"

	"github.com/piconic-ai/pedit/internal/protocol"
)

// The app has the edit and has saved it, and the close dies before the record
// says so: the retry sees the app already holds the room's text and does not
// hand the edit over a second time.
func TestCloseIntoDoesNotHandOverAgainAfterACrashAfterTheSave(t *testing.T) {
	a := newAwayRoom(t, "notes\n")
	_, guest := keepAndLeave(t, a)
	entry := guest.insert(0, "guest ")
	a.script(1, protocol.EncodeLogged(1, entry), protocol.EncodeLogEnd(1))
	a.closeAsks(func(int) int { return http.StatusOK })

	// The app is a text that Into replaces: a second handover shows as a call.
	app := "notes\n"
	var calls []handed
	opts := closeOptions(a)
	opts.Into = func(base, next string) { calls = append(calls, handed{base, next}); app = next }
	opts.AppText = func() string { return app }
	dir := filepath.Dir(keptTestStatePath(t, a.project, a.id))
	// Once the app has saved, the record cannot be written: the process "dies".
	opts.Saved = func() error { return os.Chmod(dir, 0o500) }
	t.Cleanup(func() { _ = os.Chmod(dir, 0o700) })
	if err := CloseKept(context.Background(), opts); err == nil {
		t.Fatal("closed although the record could not be written")
	}
	if err := os.Chmod(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	if rec := a.record(); rec.Files[0].Handover == nil || *rec.Files[0].Handover != "notes\n" {
		t.Fatalf("record handover %v", rec.Files[0].Handover)
	}

	a.script(1, protocol.EncodeLogEnd(1))
	opts.Saved = nil
	if err := CloseKept(context.Background(), opts); err != nil {
		t.Fatal(err)
	}
	if len(calls) != 1 || calls[0] != (handed{"notes\n", "guest notes\n"}) || app != "guest notes\n" {
		t.Fatalf("the app was handed %v, holds %q", calls, app)
	}
}
