package session

import (
	"context"
	"os"
	"path/filepath"
	"testing"

	"github.com/piconic-ai/pedit/internal/filewriter"
)

func TestKeptTextPendingWriteRecoveryAndExternalChange(t *testing.T) {
	for _, disk := range []string{"before", "after", "external"} {
		t.Run(disk, func(t *testing.T) {
			dir := t.TempDir()
			file := filepath.Join(dir, "notes.md")
			path := filepath.Join(dir, "state.keep.json")
			if err := os.WriteFile(file, []byte(disk), 0600); err != nil {
				t.Fatal(err)
			}
			pending := "after"
			s := keptTextState{Files: []keptTextFileState{{ID: 0, Path: filepath.Base(file), File: file, Text: "before", Pending: &pending}}}
			if err := saveKeptState(path, s); err != nil {
				t.Fatal(err)
			}
			info, err := os.Stat(path)
			if err != nil || info.Mode().Perm() != 0600 {
				t.Fatal("host state not private")
			}
			var reopened keptTextState
			if err := readKeptState(path, &reopened); err != nil {
				t.Fatal(err)
			}
			bound, err := filewriter.OpenBound(file)
			if err != nil {
				t.Fatal(err)
			}
			defer bound.Close()
			err = finishTestKeptWrite(path, &reopened, bound)
			data, _ := os.ReadFile(file)
			if disk == "external" {
				if err == nil || string(data) != "external" {
					t.Fatal("overwrote external edit")
				}
				return
			}
			if err != nil || string(data) != "after" {
				t.Fatalf("resume write: %v", err)
			}
			if err := readKeptState(path, &reopened); err != nil || reopened.Files[0].Pending != nil || reopened.Files[0].Text != "after" {
				t.Fatal("journal not completed")
			}
			if err := os.Chmod(path, 0644); err != nil {
				t.Fatal(err)
			}
			if err := readKeptState(path, &reopened); err == nil {
				t.Fatal("accepted public host state")
			}
		})
	}
}

// If the connection drops after the host wrote what it took in, before the
// relay confirmed the checkpoint, the next resume starts from the record and
// takes the same log in again without duplicating an edit.
func TestKeptTextResumesAfterTheCheckpointWasNotConfirmed(t *testing.T) {
	h, read := keptLocalRoom(t, "one\ntwo\nthree\n", true)
	if err := h.openFiles(); err != nil {
		t.Fatal(err)
	}
	if err := h.restore(); err != nil {
		t.Fatal(err)
	}
	if _, err := h.intake(context.Background(), read); err != nil {
		t.Fatal(err)
	}
	h.closeFiles()
	file := h.state.Files[0].File
	if got, _ := os.ReadFile(file); string(got) != "one (guest)\ntwo\nthree\n" {
		t.Fatalf("did not persist before the checkpoint: %q", got)
	}
	var saved keptTextState
	if err := readKeptState(h.path, &saved); err != nil {
		t.Fatal(err)
	}
	again := keptTextHost{state: saved, keys: h.keys, path: h.path, room: h.room}
	if err := again.openFiles(); err != nil {
		t.Fatal(err)
	}
	defer again.closeFiles()
	if err := again.restore(); err != nil {
		t.Fatal(err)
	}
	takeInRead(t, &again, read)
	if got, _ := os.ReadFile(file); string(got) != "one (guest)\ntwo\nthree\n" || again.after != 1 {
		t.Fatalf("resume duplicated the update: %q", got)
	}
}
