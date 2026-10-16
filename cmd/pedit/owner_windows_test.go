//go:build windows

package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestFileOwnerOfYourOwnFile(t *testing.T) {
	path := filepath.Join(t.TempDir(), "config.yaml")
	if err := os.WriteFile(path, nil, 0o644); err != nil {
		t.Fatal(err)
	}
	f, err := os.Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	owner, trusted, err := fileOwner(f)
	if err != nil || !trusted || !strings.HasPrefix(owner, "S-1-") {
		t.Fatalf("fileOwner = %q, %v, %v", owner, trusted, err)
	}
}
