package main

import (
	"bytes"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/piconic-ai/pedit/internal/session"
)

const testRoom = "AAAAAAAAAAAAAAAAAAAAAA"

// --resume and --close were options; they are subcommands now, and the
// options say so rather than read as a template shorthand.
func TestRemovedKeptOptions(t *testing.T) {
	for _, args := range [][]string{{"--resume"}, {"--resume", testRoom}, {"--resume=" + testRoom}, {"--close"}, {"--close", "https://x.test/r/a#k"}} {
		verb := strings.TrimPrefix(strings.SplitN(args[0], "=", 2)[0], "--")
		_, err := parseArgs(args)
		if err == nil || !strings.Contains(err.Error(), "is now pedit "+verb) {
			t.Fatalf("%v: %v", args, err)
		}
	}
}

func TestKeepZeroArgument(t *testing.T) {
	opts, err := parseArgs([]string{"--keep", "0", "a.md"})
	if err != nil || !opts.KeepOff || opts.Keep != 0 {
		t.Fatalf("%+v %v", opts, err)
	}
	for _, args := range [][]string{{"--keep", "0"}, {"--keep", "0", "--keep", "1d", "a.md"}} {
		if _, err := parseArgs(args); err == nil {
			t.Fatalf("accepted %v", args)
		}
	}
}

func TestConfigKeepAndPrecedence(t *testing.T) {
	root := t.TempDir()
	put(t, filepath.Join(root, ".git"), "")
	put(t, filepath.Join(root, ".pedit", "config.yaml"), "keep: 12h\n")
	t.Chdir(root)
	for _, c := range []struct {
		args []string
		want time.Duration
	}{
		{[]string{"a.md"}, 12 * time.Hour},
		{[]string{"--keep", "1d", "a.md"}, 24 * time.Hour},
		{[]string{"--keep", "0", "a.md"}, 0},
		{[]string{"-t", "canvas", "a.md"}, 0},
		{nil, 0},
	} {
		opts, err := parseArgs(c.args)
		if err != nil {
			t.Fatal(err)
		}
		if err := applyConfigKeep(&opts); err != nil || opts.Keep != c.want {
			t.Fatalf("%v: keep=%v err=%v", c.args, opts.Keep, err)
		}
	}
	put(t, filepath.Join(root, ".pedit", "config.yaml"), "keep: soon\n")
	if _, err := findConfig(root, false); err == nil {
		t.Fatal("accepted invalid keep")
	}
}

func TestPickKept(t *testing.T) {
	a := session.KeptTextRecord{Room: testRoom, Paths: []string{"a.md", "b.md"}, Until: 2000}
	b := session.KeptTextRecord{Room: "BBBBBBBBBBBBBBBBBBBBBB", Paths: []string{"c.md"}, Until: 1000}
	var out, errw bytes.Buffer
	if room, code := pickKept(nil, nil, true, &out, &errw); code != 1 || room != "" || !strings.Contains(errw.String(), "no kept room") {
		t.Fatalf("none: %q %d %q", room, code, errw.String())
	}
	if room, code := pickKept([]session.KeptTextRecord{a}, nil, false, &out, &errw); code != 0 || room != testRoom {
		t.Fatalf("one: %q %d", room, code)
	}
	out.Reset()
	errw.Reset()
	if _, code := pickKept([]session.KeptTextRecord{a, b}, nil, false, &out, &errw); code != 1 ||
		!strings.Contains(errw.String(), "room ID") || !strings.Contains(out.String(), "a.md, b.md") ||
		!strings.Contains(out.String(), time.UnixMilli(1000).Format(time.RFC3339)) {
		t.Fatalf("several, no terminal: %d %q %q", code, out.String(), errw.String())
	}
	out.Reset()
	if room, code := pickKept([]session.KeptTextRecord{a, b}, strings.NewReader("2\n"), true, &out, &errw); code != 0 || room != testRoom {
		t.Fatalf("choice: %q %d", room, code)
	}
	if _, code := pickKept([]session.KeptTextRecord{a, b}, strings.NewReader("9\n"), true, &out, &errw); code != 1 {
		t.Fatal("accepted a bad choice")
	}
}

func TestKeepHint(t *testing.T) {
	for seconds, want := range map[int64]string{604800: "7d", 43200: "12h", 5400: "90m", 45: "45s"} {
		if got := formatKeep(seconds); got != want {
			t.Fatalf("%d: %q", seconds, got)
		}
	}
	var out bytes.Buffer
	printKeepHint(&out, testRoom, false, "a.md")
	if out.String() != "To take in the edits later, run in this directory:\n  pedit a.md\n" {
		t.Fatal(out.String())
	}
}

func TestResumeOffersOnlyRoomsKeptByTheRelay(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("kept rooms are not supported on Windows")
	}
	root := keptProject(t, "")
	old := "CCCCCCCCCCCCCCCCCCCCCC"
	soon := time.Now().Add(time.Hour)
	keptHere(t, root, old, false, soon, filepath.Join(root, "b.md"))
	var out, errw bytes.Buffer
	opts := commandArgs{ResumeAny: true}
	if code := chooseResume(&opts, &out, &errw); code != 1 || !strings.Contains(errw.String(), "no kept room") {
		t.Fatalf("an old polling room was offered: %d %q", code, errw.String())
	}
	errw.Reset()
	opts = commandArgs{Resume: old}
	if code := chooseResume(&opts, &out, &errw); code != 1 || !strings.Contains(errw.String(), "no kept room "+old) {
		t.Fatalf("an old polling room was resumed: %d %q", code, errw.String())
	}
	keptHere(t, root, testRoom, true, soon, filepath.Join(root, "a.md"))
	opts = commandArgs{Resume: testRoom}
	if code := chooseResume(&opts, &out, &errw); code != 0 || opts.File != "a.md" {
		t.Fatalf("a kept room was not found: %+v %d", opts, code)
	}
}

func TestResumeErrorDoesNotRepeatTheKeyOfALink(t *testing.T) {
	keptProject(t, "")
	var out, errw bytes.Buffer
	opts := commandArgs{Resume: "https://x.test/r/" + testRoom + "?x=1#SECRETKEYSECRETKEY"}
	if code := chooseResume(&opts, &out, &errw); code != 1 || strings.Contains(errw.String(), "SECRET") || !strings.Contains(errw.String(), testRoom) {
		t.Fatalf("%d %q", code, errw.String())
	}
}

// A project that has only records of the older, polling kind of room can
// still clean them up with pedit close; a record with a write pending stays.
func TestCloseRemovesRecordsOfOlderRoomsEvenWithoutAKeptRoom(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("kept rooms are not supported on Windows")
	}
	root := keptProject(t, "")
	soon := time.Now().Add(time.Hour)
	old, pending := "CCCCCCCCCCCCCCCCCCCCCC", "DDDDDDDDDDDDDDDDDDDDDD"
	keptHere(t, root, old, false, soon, filepath.Join(root, "a.md"))
	keptHere(t, root, pending, false, soon, filepath.Join(root, "b.md"))
	pendingFile := recordPath(t, root, pending)
	raw, err := os.ReadFile(pendingFile)
	if err != nil {
		t.Fatal(err)
	}
	raw = bytes.Replace(raw, []byte(`"Path":"b.md"`), []byte(`"Path":"b.md","Pending":"x"`), 1)
	if err := os.WriteFile(pendingFile, raw, 0o600); err != nil {
		t.Fatal(err)
	}
	var out, errw bytes.Buffer
	if code := run([]string{"close", old}, &out, &errw); code != 1 || !strings.Contains(out.String(), "Removed 1 resume record") || !strings.Contains(errw.String(), "no kept room "+old) {
		t.Fatalf("%d %q %q", code, out.String(), errw.String())
	}
	if _, err := os.Stat(recordPath(t, root, old)); !os.IsNotExist(err) {
		t.Fatal("the old record is still there")
	}
	if _, err := os.Stat(pendingFile); err != nil {
		t.Fatal("removed a record with a write pending")
	}
}

func TestListingRemovesRecordsPastTheirDeadline(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("kept rooms are not supported on Windows")
	}
	root := keptProject(t, "")
	dead, pending, live := "CCCCCCCCCCCCCCCCCCCCCC", "DDDDDDDDDDDDDDDDDDDDDD", testRoom
	gone := time.Now().Add(-3 * time.Hour)
	keptHere(t, root, dead, true, gone, filepath.Join(root, "a.md"))
	keptHere(t, root, pending, true, gone, filepath.Join(root, "b.md"))
	keptHere(t, root, live, true, time.Now().Add(time.Hour), filepath.Join(root, "c.md"))
	path := recordPath(t, root, pending)
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	raw = bytes.Replace(raw, []byte(`"Path":"b.md"`), []byte(`"Path":"b.md","Pending":"x"`), 1)
	if err := os.WriteFile(path, raw, 0o600); err != nil {
		t.Fatal(err)
	}
	var out, errw bytes.Buffer
	opts := commandArgs{Resume: dead}
	if code := chooseResume(&opts, &out, &errw); code != 1 || !strings.Contains(out.String(), "Removed 1 resume record(s) of finished rooms.") {
		t.Fatalf("%d %q %q", code, out.String(), errw.String())
	}
	if _, err := os.Stat(recordPath(t, root, dead)); !os.IsNotExist(err) {
		t.Fatal("the record of the dead room is still there")
	}
	for _, room := range []string{pending, live} {
		if _, err := os.Stat(recordPath(t, root, room)); err != nil {
			t.Fatalf("removed %s", room)
		}
	}
}
