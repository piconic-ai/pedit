package session

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"os"
	"path/filepath"
	"testing"

	"github.com/piconic-ai/pedit/internal/protocol"
)

func TestReviewResumeRejectsInvalidPendingStateBeforeWritingSource(t *testing.T) {
	isolateKeptUserConfig(t)
	dir := t.TempDir()
	file := filepath.Join(dir, "notes.md")
	if err := os.WriteFile(file, []byte("original"), 0600); err != nil {
		t.Fatal(err)
	}
	token := base64.RawURLEncoding.EncodeToString(make([]byte, 32))
	hash := sha256.Sum256([]byte(token))
	room := base64.RawURLEncoding.EncodeToString(hash[:])[:22]
	pending := "corrupted pending text"
	state := keptTextState{File: file, Project: dir, Origin: "https://example.test", Fragment: protocol.GenerateEditSecret(), HostToken: token, Keep: 60, State: []byte{1, 2, 3}, Text: "original", Pending: &pending, Initialized: true}
	path := keptTestStatePath(t, dir, room)
	if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
		t.Fatal(err)
	}
	if err := saveKeptState(path, state); err != nil {
		t.Fatal(err)
	}
	link := state.Origin + "/r/" + room + "?keep=1#" + state.Fragment
	if err := RunKeptText(context.Background(), KeptTextOptions{Project: dir, Resume: link}, nil, nil); err == nil {
		t.Fatal("invalid saved document accepted")
	}
	got, err := os.ReadFile(file)
	if err != nil {
		t.Fatal(err)
	}
	if string(got) != "original" {
		t.Fatalf("invalid journal changed source before validation: %q", string(got))
	}
}
