package main

import (
	"encoding/json"
	"io"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

func TestServeHelpIsExperimental(t *testing.T) {
	var stdout, stderr strings.Builder
	if code := run([]string{"serve", "--help"}, &stdout, &stderr); code != 0 ||
		!strings.Contains(stdout.String(), "Usage: pedit serve [--root <dir>] <file>") ||
		!strings.Contains(stdout.String(), "EXPERIMENTAL") {
		t.Fatalf("code %d\nstdout: %s\nstderr: %s", code, stdout.String(), stderr.String())
	}
}

func TestParseServeArgs(t *testing.T) {
	got, err := parseServeArgs([]string{"a.md", "--json", "--app", "sample"})
	if err != nil || got != (serveArgs{file: "a.md", app: "sample", json: true}) {
		t.Fatalf("%+v %v", got, err)
	}
	if got, err := parseServeArgs([]string{"--", "--odd.md"}); err != nil || got.file != "--odd.md" {
		t.Fatalf("%+v %v", got, err)
	}
	for _, args := range [][]string{{}, {"a", "b"}, {"a", "--app"}, {"a", "--tcp"}} {
		if _, err := parseServeArgs(args); err == nil {
			t.Errorf("accepted %v", args)
		}
	}
	var stdout, stderr strings.Builder
	if code := run([]string{"serve"}, &stdout, &stderr); code != 2 || !strings.Contains(stderr.String(), "Usage: pedit serve") {
		t.Fatalf("code %d, stderr %s", code, stderr.String())
	}
}

type lockedBuilder struct {
	mu sync.Mutex
	b  strings.Builder
}

func (l *lockedBuilder) Write(p []byte) (int, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.b.Write(p)
}

func (l *lockedBuilder) String() string {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.b.String()
}

func TestServeRunsUntilStdinCloses(t *testing.T) {
	file := filepath.Join(t.TempDir(), "a.md")
	if err := os.WriteFile(file, []byte("hi\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	pr, pw := io.Pipe()
	serveStdin = pr
	t.Cleanup(func() { serveStdin = os.Stdin })

	var stdout, stderr lockedBuilder
	done := make(chan int)
	go func() { done <- run([]string{"serve", file, "--json", "--app", "t"}, &stdout, &stderr) }()

	var event struct{ Event, Socket string }
	deadline := time.Now().Add(5 * time.Second)
	for json.Unmarshal([]byte(stdout.String()), &event) != nil {
		if time.Now().After(deadline) {
			t.Fatalf("no listening event; stderr: %s", stderr.String())
		}
		time.Sleep(5 * time.Millisecond)
	}
	if event.Event != "listening" {
		t.Fatalf("event %+v", event)
	}
	if _, err := os.Stat(event.Socket); err != nil {
		t.Fatal(err)
	}

	// A second one is refused, naming the first.
	var out2, err2 strings.Builder
	if code := runServe([]string{file, "--app", "second"}, &out2, &err2); code != 3 || !strings.Contains(err2.String(), `app "t"`) {
		t.Fatalf("second serve: code %d, stderr %s", code, err2.String())
	}

	_ = pw.Close()
	if code := <-done; code != 0 {
		t.Fatalf("code %d, stderr %s", code, stderr.String())
	}
	if _, err := os.Stat(event.Socket); !os.IsNotExist(err) {
		t.Fatalf("socket left behind: %v", err)
	}
	if _, err := os.Stat(filepath.Join(filepath.Dir(file), ".a.md.pedit-lock")); !os.IsNotExist(err) {
		t.Fatalf("lock left behind: %v", err)
	}
}

// waitFor polls out until it holds at least n lines, and returns them.
func waitFor(t *testing.T, out *lockedBuilder, n int) []string {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for {
		lines := strings.Split(strings.TrimSpace(out.String()), "\n")
		if len(lines) >= n && lines[0] != "" {
			return lines
		}
		if time.Now().After(deadline) {
			t.Fatalf("want %d lines, have %q", n, out.String())
		}
		time.Sleep(5 * time.Millisecond)
	}
}

func eventNames(t *testing.T, out string) []string {
	t.Helper()
	var names []string
	for _, l := range strings.Split(strings.TrimSpace(out), "\n") {
		var e struct{ Event string }
		if err := json.Unmarshal([]byte(l), &e); err != nil {
			t.Fatalf("not an event: %q", l)
		}
		names = append(names, e.Event)
	}
	return names
}

func startServe(t *testing.T, args ...string) (stdout, stderr *lockedBuilder, stop func() int) {
	t.Helper()
	pr, pw := io.Pipe()
	serveStdin = pr
	t.Cleanup(func() { serveStdin = os.Stdin })
	stdout, stderr = &lockedBuilder{}, &lockedBuilder{}
	done := make(chan int, 1)
	go func() { done <- run(append([]string{"serve"}, args...), stdout, stderr) }()
	return stdout, stderr, func() int { _ = pw.Close(); return <-done }
}

func TestServeJSONEventsInOrder(t *testing.T) {
	file := filepath.Join(t.TempDir(), "a.md")
	if err := os.WriteFile(file, []byte("hi\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	stdout, stderr, stop := startServe(t, file, "--json")
	waitFor(t, stdout, 1)
	if err := os.WriteFile(file, []byte("hi there\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	waitFor(t, stdout, 2)
	if code := stop(); code != 0 {
		t.Fatalf("code %d, stderr %s", code, stderr.String())
	}
	if got := eventNames(t, stdout.String()); got[0] != "listening" || got[1] != "external_save" {
		t.Fatalf("events %v", got)
	}
}

func TestServeErrorEventExitsOne(t *testing.T) {
	var stdout, stderr strings.Builder
	missing := filepath.Join(t.TempDir(), "missing.md")
	if code := runServe([]string{missing, "--json"}, &stdout, &stderr); code != 1 {
		t.Fatalf("code %d", code)
	}
	var e struct{ Event, Message string }
	if err := json.Unmarshal([]byte(stdout.String()), &e); err != nil || e.Event != "error" || e.Message == "" || strings.Contains(e.Message, "\n") {
		t.Fatalf("stdout %q: %v", stdout.String(), err)
	}
	// Without --json the exit code is the same and stdout stays empty.
	stdout.Reset()
	if code := runServe([]string{missing}, &stdout, &stderr); code != 1 || stdout.String() != "" {
		t.Fatalf("code %d, stdout %q", code, stdout.String())
	}
}

func TestServeHeldEventExitsThree(t *testing.T) {
	file := filepath.Join(t.TempDir(), "a.md")
	if err := os.WriteFile(file, []byte("hi\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	stdout, _, stop := startServe(t, file, "--json", "--app", "first")
	waitFor(t, stdout, 1)
	var out2, err2 strings.Builder
	if code := runServe([]string{file, "--json"}, &out2, &err2); code != 3 {
		t.Fatalf("code %d, stderr %s", code, err2.String())
	}
	var e struct {
		Event, App string
		PID        int
	}
	if err := json.Unmarshal([]byte(out2.String()), &e); err != nil || e.Event != "held" || e.App != "first" || e.PID != os.Getpid() {
		t.Fatalf("stdout %q: %+v %v", out2.String(), e, err)
	}
	stop()
}

func TestServeRootRefusesPathsOutside(t *testing.T) {
	base := t.TempDir()
	root, outside := filepath.Join(base, "root"), filepath.Join(base, "outside")
	for _, d := range []string{root, outside, filepath.Join(root, "sub")} {
		if err := os.MkdirAll(d, 0o755); err != nil {
			t.Fatal(err)
		}
	}
	for _, f := range []string{filepath.Join(base, "x"), filepath.Join(outside, "y.md"), filepath.Join(root, "sub", "ok.md")} {
		if err := os.WriteFile(f, []byte("hi\n"), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.Symlink(outside, filepath.Join(root, "link")); err != nil {
		t.Skip("no symlinks:", err)
	}
	for _, name := range []string{"../x", filepath.Join(base, "x"), "link/y.md"} {
		var stdout, stderr strings.Builder
		code := runServe([]string{"--root", root, name, "--json"}, &stdout, &stderr)
		if code != 1 || !strings.Contains(stderr.String(), "is outside") || !strings.Contains(stdout.String(), `"event":"error"`) {
			t.Errorf("%s: code %d, stdout %q, stderr %q", name, code, stdout.String(), stderr.String())
		}
	}

	stdout, stderr, stop := startServe(t, "--root", root, filepath.Join("sub", "ok.md"), "--json")
	waitFor(t, stdout, 1)
	if _, err := os.Stat(filepath.Join(root, "sub", ".ok.md.pedit-lock")); err != nil {
		t.Error(err)
	}
	if code := stop(); code != 0 {
		t.Fatalf("code %d, stderr %s", code, stderr.String())
	}
}
