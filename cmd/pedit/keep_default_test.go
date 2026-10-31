package main

import (
	"bytes"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"
)

// keptHere writes the resume record of a kept room of the project at root;
// without socket it is the record of the older, polling kind of room.
func keptHere(t *testing.T, root, room string, socket bool, until time.Time, files ...string) {
	t.Helper()
	config, err := os.UserConfigDir()
	if err != nil {
		t.Fatal(err)
	}
	digest := sha256.Sum256([]byte(root))
	dir := filepath.Join(config, "pedit", "keep", fmt.Sprintf("%x", digest[:])[:16])
	if err := os.MkdirAll(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	var list []map[string]any
	for i, f := range files {
		list = append(list, map[string]any{"ID": i, "File": f, "Path": filepath.Base(f)})
	}
	data, err := json.Marshal(map[string]any{"Project": root, "Files": list, "Initialized": true, "Socket": socket, "Until": until.UnixMilli()})
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, room+".json"), data, 0o600); err != nil {
		t.Fatal(err)
	}
}

func keptProject(t *testing.T, config string) string {
	t.Helper()
	root, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	t.Setenv("HOME", root)
	t.Setenv("XDG_CONFIG_HOME", filepath.Join(root, "xdg"))
	put(t, filepath.Join(root, ".git"), "")
	put(t, filepath.Join(root, ".pedit", "config.yaml"), config)
	put(t, filepath.Join(root, "a.md"), "a\n")
	put(t, filepath.Join(root, "b.md"), "b\n")
	put(t, filepath.Join(root, "c.canvas"), "{}")
	t.Chdir(root)
	return root
}

func TestDefaultKeepIsOneDay(t *testing.T) {
	keptProject(t, "")
	day := 24 * time.Hour
	if runtime.GOOS == "windows" {
		day = 0 // kept rooms are not supported there, so nothing is kept by default
	}
	for _, c := range []struct {
		args []string
		want time.Duration
		off  bool
	}{
		{[]string{"a.md"}, day, false},
		{[]string{"a.md", "b.md"}, day, false},
		{[]string{"--keep", "7d", "a.md"}, 7 * 24 * time.Hour, false},
		{[]string{"--keep", "0", "a.md"}, 0, true},
		{[]string{"c.canvas"}, 0, false},
		{[]string{"new.md"}, 0, false},
		{[]string{"-t", "canvas", "a.md"}, 0, false},
		{[]string{"--resume"}, 0, false},
		{nil, 0, false},
	} {
		opts, err := parseArgs(c.args)
		if err != nil {
			t.Fatal(err)
		}
		if err := applyConfigKeep(&opts); err != nil || opts.Keep != c.want || opts.KeepOff != c.off {
			t.Fatalf("%v: keep=%v off=%v err=%v", c.args, opts.Keep, opts.KeepOff, err)
		}
	}
}

func TestConfigKeepZeroTurnsKeepOff(t *testing.T) {
	keptProject(t, "keep: 0\n")
	opts, _ := parseArgs([]string{"a.md"})
	if err := applyConfigKeep(&opts); err != nil || opts.Keep != 0 || !opts.KeepOff {
		t.Fatalf("%+v %v", opts, err)
	}
	opts, _ = parseArgs([]string{"--keep", "2d", "a.md"})
	if err := applyConfigKeep(&opts); err != nil || opts.Keep != 48*time.Hour {
		t.Fatalf("%+v %v", opts, err)
	}
}

func TestFileResumesTheRoomThatHoldsIt(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("kept rooms are not supported on Windows")
	}
	root := keptProject(t, "")
	a, b := filepath.Join(root, "a.md"), filepath.Join(root, "b.md")
	soon := time.Now().Add(time.Hour)
	keptHere(t, root, testRoom, true, soon, a, b)
	keptHere(t, root, "CCCCCCCCCCCCCCCCCCCCCC", false, soon, filepath.Join(root, "c.md"))

	var out, errw bytes.Buffer
	opts, _ := parseArgs([]string{"a.md"})
	if code := resumeHeld(&opts, &out, &errw); code != 0 || opts.Resume != testRoom || !strings.Contains(out.String(), "Resuming the kept room "+testRoom) {
		t.Fatalf("held: %+v %d %q %q", opts, code, out.String(), errw.String())
	}
	if code, done := routeKept(&opts, &out, &errw); code != 0 || done || opts.File != "a.md" || len(opts.More) != 1 || opts.More[0] != "b.md" {
		t.Fatalf("route: %+v %d %v", opts, code, done)
	}
	if err := applyConfigKeep(&opts); err != nil || opts.Keep != 0 {
		t.Fatalf("a resumed room asks for no new keep: %+v %v", opts, err)
	}

	opts, _ = parseArgs([]string{"--keep", "2d", "b.md", "a.md"})
	if resumeHeld(&opts, &out, &errw); opts.Resume != testRoom {
		t.Fatalf("--keep and a held file: %+v", opts)
	}

	opts, _ = parseArgs([]string{"a.md", "c.canvas"})
	errw.Reset()
	if code := resumeHeld(&opts, &out, &errw); code != 1 || opts.Resume != "" ||
		!strings.Contains(errw.String(), "c.canvas is not in the kept room "+testRoom) || !strings.Contains(errw.String(), "pedit --close "+testRoom) || !strings.Contains(errw.String(), "--keep 0") {
		t.Fatalf("extra file: %+v %d %q", opts, code, errw.String())
	}

	opts, _ = parseArgs([]string{"--keep", "0", "a.md"})
	if code := resumeHeld(&opts, &out, &errw); code != 0 || opts.Resume != "" {
		t.Fatalf("--keep 0: %+v %d", opts, code)
	}
}

func TestFileDoesNotResumeAnExpiredOrOldRoom(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("kept rooms are not supported on Windows")
	}
	root := keptProject(t, "")
	a := filepath.Join(root, "a.md")
	keptHere(t, root, testRoom, true, time.Now().Add(-time.Minute), a)
	keptHere(t, root, "CCCCCCCCCCCCCCCCCCCCCC", false, time.Now().Add(time.Hour), a)
	var out, errw bytes.Buffer
	opts, _ := parseArgs([]string{"a.md", "b.md"})
	if code := resumeHeld(&opts, &out, &errw); code != 0 || opts.Resume != "" {
		t.Fatalf("%+v %d %q", opts, code, out.String())
	}
	if err := applyConfigKeep(&opts); err != nil || opts.Keep != 24*time.Hour {
		t.Fatalf("a new room is kept for a day: %+v %v", opts, err)
	}
}

func TestFileDoesNotResumeAgainstKeepZeroConfig(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("kept rooms are not supported on Windows")
	}
	root := keptProject(t, "keep: 0\n")
	keptHere(t, root, testRoom, true, time.Now().Add(time.Hour), filepath.Join(root, "a.md"))
	var out, errw bytes.Buffer
	opts, _ := parseArgs([]string{"a.md"})
	if code := resumeHeld(&opts, &out, &errw); code != 0 || opts.Resume != "" {
		t.Fatalf("keep: 0 in the config: %+v %d", opts, code)
	}
	if err := applyConfigKeep(&opts); err != nil || !opts.KeepOff {
		t.Fatalf("keep: 0 in the config: %+v %v", opts, err)
	}
	opts, _ = parseArgs([]string{"--keep", "1d", "a.md"})
	if resumeHeld(&opts, &out, &errw); opts.Resume != testRoom {
		t.Fatalf("--keep resumes even when the config says keep: 0: %+v", opts)
	}
}

func TestKeepHintNamesTheFile(t *testing.T) {
	var out bytes.Buffer
	printKeepHint(&out, testRoom, false, "docs/a.md")
	if !strings.HasSuffix(out.String(), "run in this directory:\n  pedit docs/a.md\n") {
		t.Fatal(out.String())
	}
	out.Reset()
	printKeepHint(&out, testRoom, true, "docs/a.md")
	if !strings.HasSuffix(out.String(), "\n  pedit docs/a.md  (or: pedit --resume "+testRoom+")\n") {
		t.Fatal(out.String())
	}
}

// recordPath is where keptHere wrote the record of room.
func recordPath(t *testing.T, root, room string) string {
	t.Helper()
	config, err := os.UserConfigDir()
	if err != nil {
		t.Fatal(err)
	}
	digest := sha256.Sum256([]byte(root))
	return filepath.Join(config, "pedit", "keep", fmt.Sprintf("%x", digest[:])[:16], room+".json")
}
