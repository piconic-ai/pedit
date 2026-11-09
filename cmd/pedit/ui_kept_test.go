package main

import (
	"strings"
	"testing"
	"time"

	"github.com/piconic-ai/pedit/internal/protocol"
)

// The host of a kept room cannot add a file (session.canShare), so the hint
// to type a path is not shown; Ctrl+L still is.
func TestUISharingKeptRoomHasNoAddHint(t *testing.T) {
	var out strings.Builder
	u := newUI(&out, false, false)
	u.resumable = true
	u.kept = true
	u.sharing([]string{"notes.md"}, "https://x.test/r/AAAA#key", false, false)
	if strings.Contains(out.String(), "To share another file") {
		t.Errorf("a kept room offered to add a file:\n%s", out.String())
	}
	if !strings.Contains(out.String(), "Press Ctrl+L for links that can only comment or read.") {
		t.Errorf("missing the Ctrl+L hint:\n%s", out.String())
	}
}

// A guest whose link can edit keeps editing while the host is away
// (internal/session/kept_guest.go); one whose link cannot has a read-only copy.
func TestUIKeptLineSaysWhatBecomesOfEdits(t *testing.T) {
	until := time.UnixMilli(1700000000000).UTC()
	for _, tc := range []struct {
		editor bool
		want   string
	}{
		{true, "your edits wait on the relay until they are back."},
		{false, "your copy is read-only until they are back."},
	} {
		var out strings.Builder
		u := newUI(&out, false, false)
		u.setEditor(tc.editor)
		u.setKeptUntil(until)
		u.setStatus(protocol.StatusKept)
		if got := u.liveLine(); !strings.HasSuffix(got, tc.want) || !strings.Contains(got, "kept until 2023-11-14T22:13:20Z") {
			t.Errorf("editor=%v: %q", tc.editor, got)
		}
	}
}
