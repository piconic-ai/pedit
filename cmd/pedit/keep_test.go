package main

import (
	"context"
	"github.com/piconic-ai/pedit/internal/session"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"
)

func TestKeepArguments(t *testing.T) {
	opts, err := parseArgs([]string{"--keep", "7d", "notes.md"})
	if err != nil || opts.Keep != 7*24*time.Hour || opts.File != "notes.md" {
		t.Fatalf("keep args: %v", err)
	}
	multi, multiErr := parseArgs([]string{"--keep", "7d", "notes.md", "todo.md"})
	if multiErr != nil || multi.File != "notes.md" || len(multi.More) != 1 || multi.More[0] != "todo.md" {
		t.Fatalf("multiple keep args: %v", multiErr)
	}
	opts, err = parseArgs([]string{"--resume", "https://example.test/r/AAAAAAAAAAAAAAAAAAAAAA?keep=1#key"})
	if err != nil || opts.Resume == "" {
		t.Fatalf("resume args: %v", err)
	}
	for _, args := range [][]string{{"--keep"}, {"--keep", "0s", "notes.md"}, {"--keep", "1ms", "notes.md"}, {"--keep", "1d"}, {"--resume", "notes.md"}, {"--resume", "https://example.test/r/id#key", "notes.md"}, {"--keep", "1d", "notes.md", "--resume", "https://example.test/r/id#key"}} {
		if _, err := parseArgs(args); err == nil {
			t.Fatalf("accepted invalid keep args: %v", args)
		}
	}
}

func TestKeepWindowsPermissions(t *testing.T) {
	if runtime.GOOS != "windows" {
		t.Skip("Windows permission boundary")
	}
	if _, err := session.Start(context.Background(), session.Options{File: "notes.md", Keep: time.Hour}); err == nil || !strings.Contains(err.Error(), "Windows is not supported") {
		t.Fatalf("unsupported live keep: %v", err)
	}
	for _, resume := range []string{"", "https://example.test/r/room?keep=1#key"} {
		project := t.TempDir()
		err := session.RunKeptText(context.Background(), session.KeptTextOptions{Project: project, Resume: resume}, nil, nil)
		if err == nil || !strings.Contains(err.Error(), "Windows is not supported") {
			t.Fatalf("unsupported host mode: %v", err)
		}
		if _, err := os.Stat(filepath.Join(project, ".pedit")); !os.IsNotExist(err) {
			t.Fatal("unsupported host mode created state")
		}
	}
}
