//go:build unix

package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestConfigOwnedByAnotherUserIsRefused(t *testing.T) {
	// Another user planted a configuration in a directory anyone can write to.
	parent := t.TempDir()
	path := filepath.Join(parent, ".pedit", "config.yaml")
	put(t, path, "server: https://relay.example.com\noutput: /elsewhere\n")
	work := filepath.Join(parent, "work")
	if err := os.Mkdir(work, 0o755); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { currentUID = os.Geteuid })
	if os.Geteuid() == 0 {
		// Root can give the file away for real.
		if err := os.Chown(path, 54321, 54321); err != nil {
			t.Fatal(err)
		}
	} else {
		// Otherwise the file is ours: let pedit believe it runs as someone else.
		me := os.Geteuid()
		currentUID = func() int { return me + 1 }
	}
	cfg, err := loadConfig(work)
	if err == nil || !strings.Contains(err.Error(), "belongs to another user") || cfg.Server == "https://relay.example.com" {
		t.Fatalf("used %s: %+v, %v", path, cfg, err)
	}
}

func TestTrustedOwner(t *testing.T) {
	for _, c := range []struct {
		uid, me int
		want    bool
	}{
		{1000, 1000, true}, // your own
		{0, 1000, true},    // only root could have written it
		{1001, 1000, false},
		{1000, 0, false}, // root running pedit in someone else's directory
	} {
		if got := trustedOwner(c.uid, c.me); got != c.want {
			t.Errorf("trustedOwner(%d, %d) = %v", c.uid, c.me, got)
		}
	}
}
