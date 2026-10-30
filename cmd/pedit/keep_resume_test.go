package main

import (
	"bytes"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/piconic-ai/pedit/internal/session"
)

const testRoom = "AAAAAAAAAAAAAAAAAAAAAA"

func TestResumeArguments(t *testing.T) {
	for args, want := range map[string]commandArgs{
		"--resume":                             {ResumeAny: true},
		"--resume " + testRoom:                 {Resume: testRoom},
		"--resume=" + testRoom:                 {Resume: testRoom},
		"--resume -AAAAAAAAAAAAAAAAAAAAA":      {Resume: "-AAAAAAAAAAAAAAAAAAAAA"},
		"--resume https://x.test/r/a?keep=1#k": {Resume: "https://x.test/r/a?keep=1#k"},
	} {
		got, err := parseArgs(strings.Fields(args))
		if err != nil || got.Resume != want.Resume || got.ResumeAny != want.ResumeAny {
			t.Fatalf("%q: %+v %v", args, got, err)
		}
	}
	for _, args := range [][]string{{"--resume", "short"}, {"--resume", "--resume"}, {"--resume", "a.md"}, {"--resume", testRoom, "--resume"}, {"--resume=", "x"}, {"--keep", "1d", "a.md", "--resume"}} {
		if _, err := parseArgs(args); err == nil {
			t.Fatalf("accepted %v", args)
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
		{[]string{"--resume"}, 0},
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
	printKeepHint(&out, testRoom, false)
	if !strings.HasSuffix(out.String(), "run in this directory:\n  pedit --resume\n") || !strings.HasPrefix(out.String(), "Leave with Ctrl+C.") {
		t.Fatal(out.String())
	}
	out.Reset()
	printKeepHint(&out, testRoom, true)
	if !strings.HasSuffix(out.String(), "  pedit --resume "+testRoom+"\n") {
		t.Fatal(out.String())
	}
	if keptRoomOf("https://x.test/r/"+testRoom+"?keep=1#k") != testRoom {
		t.Fatal("room of link")
	}
}

func TestCloseArguments(t *testing.T) {
	for args, want := range map[string]commandArgs{
		"--close":                             {Close: true, ResumeAny: true},
		"--close " + testRoom:                 {Close: true, Resume: testRoom},
		"--close=" + testRoom:                 {Close: true, Resume: testRoom},
		"--close https://x.test/r/a?keep=1#k": {Close: true, Resume: "https://x.test/r/a?keep=1#k"},
	} {
		got, err := parseArgs(strings.Fields(args))
		if err != nil || got.Close != want.Close || got.Resume != want.Resume || got.ResumeAny != want.ResumeAny {
			t.Fatalf("%q: %+v %v", args, got, err)
		}
	}
	for _, args := range [][]string{{"--close", "short"}, {"--close", "a.md"}, {"--close", "--resume"}, {"--resume", "--close"}, {"--close", testRoom, "--close"}, {"--keep", "1d", "a.md", "--close"}} {
		if _, err := parseArgs(args); err == nil {
			t.Fatalf("accepted %v", args)
		}
	}
}
