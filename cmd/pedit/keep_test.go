package main

import (
	"testing"
	"time"
)

func TestKeepArguments(t *testing.T) {
	opts, err := parseArgs([]string{"--keep", "7d", "notes.md"})
	if err != nil || opts.Keep != 7*24*time.Hour || opts.File != "notes.md" {
		t.Fatalf("keep args: %v", err)
	}
	opts, err = parseArgs([]string{"--resume", "https://example.test/r/AAAAAAAAAAAAAAAAAAAAAA?keep=1#key"})
	if err != nil || opts.Resume == "" {
		t.Fatalf("resume args: %v", err)
	}
	for _, args := range [][]string{{"--keep"}, {"--keep", "0s", "notes.md"}, {"--keep", "1ms", "notes.md"}, {"--keep", "1d", "a.md", "b.md"}, {"--keep", "1d"}, {"--resume", "notes.md"}, {"--resume", "https://example.test/r/id#key", "notes.md"}, {"--keep", "1d", "notes.md", "--resume", "https://example.test/r/id#key"}} {
		if _, err := parseArgs(args); err == nil {
			t.Fatalf("accepted invalid keep args: %v", args)
		}
	}
}
