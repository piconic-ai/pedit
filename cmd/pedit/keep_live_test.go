package main

import (
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/piconic-ai/pedit/internal/protocol"
)

func TestKeepPollingArgument(t *testing.T) {
	opts, err := parseArgs([]string{"--keep", "7d", "a.md", "b.md"})
	if err != nil || opts.Keep != 7*24*time.Hour || opts.Polling || opts.File != "a.md" || len(opts.More) != 1 {
		t.Fatalf("--keep: %+v, %v", opts, err)
	}
	opts, err = parseArgs([]string{"--keep-polling=1d", "a.md"})
	if err != nil || opts.Keep != 24*time.Hour || !opts.Polling {
		t.Fatalf("--keep-polling: %+v, %v", opts, err)
	}
	for _, args := range [][]string{{"--keep-polling", "a.md"}, {"--keep-polling", "1d", "--resume"}, {"--keep", "1d", "--keep-polling", "1d", "a.md"}} {
		if _, err := parseArgs(args); err == nil {
			t.Errorf("%v: accepted", args)
		}
	}
}

func TestKeptRoomOfALiveLink(t *testing.T) {
	if got := keptRoomOf("https://x.test/r/" + testRoom + "#key"); got != testRoom {
		t.Fatalf("room = %q", got)
	}
}

func TestUIKeepNotesAndTheKeptStatus(t *testing.T) {
	var out strings.Builder
	u := newUI(&out, false, false)
	u.keeping(60, 7*24*time.Hour)
	u.keeping(86400, 24*time.Hour)
	u.keeping(0, time.Hour)
	u.setStatus(protocol.StatusConnected)
	u.sharing([]string{"notes.md"}, "https://x.test/r/AAAA#key", false, false)
	u.setKeptUntil(time.UnixMilli(1700000000000).UTC())
	u.setStatus(protocol.StatusKept)
	u.setStatus(protocol.StatusKept)
	u.setStatus(protocol.StatusConnected)
	u.stopLive()
	u.saving("notes.md")
	u.savedKept("notes.md")
	u.keptHint(time.UnixMilli(1700000000000).UTC(), testRoom, false)
	for _, want := range []string{
		"Relay capped keep time to 1m.",
		"Room keep time: 1d.",
		"This relay cannot keep a room. It ends when you leave.",
		"○ The host is away. The room is kept until 2023-11-14T22:13:20Z; your copy is read-only until they are back.",
		"✓ Back online. Changes sync again.",
		"✓ Saved notes.md.\n",
		"Room stays open until 2023-11-14T22:13:20Z.",
		"pedit --resume\n",
	} {
		if !strings.Contains(out.String(), want) {
			t.Errorf("output lacks %q:\n%s", want, out.String())
		}
	}
	if n := strings.Count(out.String(), "The host is away"); n != 1 {
		t.Errorf("the host-away line appeared %d times:\n%s", n, out.String())
	}
	if strings.Contains(out.String(), "The link no longer works") {
		t.Fatal("said the link stops working for a kept room")
	}
}

func TestFinishOfAKeptRoom(t *testing.T) {
	var stdout, stderr strings.Builder
	code := finish(newUI(&stdout, false, false), &stderr, "notes.md", false, func() error { return nil }, func() bool { return true })
	if code != 0 || strings.Contains(stdout.String(), "no longer works") || !strings.Contains(stdout.String(), "Saved notes.md.") {
		t.Fatalf("code %d, output %q", code, stdout.String())
	}
}

func TestResumeShowsRecordedPathsLikeTheFirstRun(t *testing.T) {
	dir, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	t.Chdir(dir)
	got := displayPaths([]string{filepath.Join(dir, "docs", "notes.md"), "/elsewhere/b.md"})
	if want := filepath.Join("docs", "notes.md"); got[0] != want || got[1] != "/elsewhere/b.md" {
		t.Fatalf("paths = %v", got)
	}
	var out strings.Builder
	u := newUI(&out, false, false)
	u.sharing(got[:1], "https://x.test/r/AAAA#key", false, false)
	if !strings.Contains(out.String(), "docs/notes.md is ready") || strings.Contains(out.String(), dir) {
		t.Fatalf("output shows the absolute path:\n%s", out.String())
	}
}
