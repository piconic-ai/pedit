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
		!strings.Contains(stdout.String(), "Usage: pedit serve <file>") ||
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
	if code := runServe([]string{file, "--app", "second"}, &out2, &err2); code != 1 || !strings.Contains(err2.String(), `app "t"`) {
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
