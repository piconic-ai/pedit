//go:build !windows

package session

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/piconic-ai/pedit/internal/filewriter"
)

func TestKeptTextSyncFollowsRenamedParent(t *testing.T) {
	for _, recreate := range []bool{false, true} {
		name := "missing original path"
		if recreate {
			name = "recreated unrelated path"
		}
		t.Run(name, func(t *testing.T) {
			dir := t.TempDir()
			docs := filepath.Join(dir, "docs")
			moved := filepath.Join(dir, "moved")
			if err := os.Mkdir(docs, 0700); err != nil {
				t.Fatal(err)
			}
			file := filepath.Join(docs, "notes.md")
			if err := os.WriteFile(file, []byte("before"), 0600); err != nil {
				t.Fatal(err)
			}
			bound, err := filewriter.OpenBound(file)
			if err != nil {
				t.Fatal(err)
			}
			defer bound.Close()
			if err := os.Rename(docs, moved); err != nil {
				t.Fatal(err)
			}
			if recreate {
				if err := os.Mkdir(docs, 0700); err != nil {
					t.Fatal(err)
				}
				if err := os.WriteFile(file, []byte("unrelated"), 0600); err != nil {
					t.Fatal(err)
				}
				if err := os.Chmod(file, 0400); err != nil {
					t.Fatal(err)
				}
			}
			next := "after"
			state := keptTextState{Files: []keptTextFileState{{ID: 0, Path: filepath.Base(file), File: file, Text: "before", Pending: &next}}}
			path := filepath.Join(dir, "state.keep.json")
			if err := saveKeptState(path, state); err != nil {
				t.Fatal(err)
			}
			if err := finishTestKeptWrite(path, &state, bound); err != nil {
				t.Fatalf("sync anchored source: %v", err)
			}
			got, err := os.ReadFile(filepath.Join(moved, "notes.md"))
			if err != nil || string(got) != "after" {
				t.Fatal("did not update anchored source")
			}
			if recreate {
				got, err := os.ReadFile(file)
				if err != nil || string(got) != "unrelated" {
					t.Fatal("modified unrelated replacement")
				}
			}
			var saved keptTextState
			if err := readKeptState(path, &saved); err != nil || saved.Files[0].Pending != nil || saved.Files[0].Text != "after" {
				t.Fatal("did not complete anchored write journal")
			}
		})
	}
}

func TestKeptTextUncertainSyncRetainsPending(t *testing.T) {
	if os.Geteuid() == 0 {
		t.Skip("root bypasses directory permissions")
	}
	dir := t.TempDir()
	docs := filepath.Join(dir, "docs")
	if err := os.Mkdir(docs, 0700); err != nil {
		t.Fatal(err)
	}
	file := filepath.Join(docs, "notes.md")
	if err := os.WriteFile(file, []byte("before"), 0600); err != nil {
		t.Fatal(err)
	}
	bound, err := filewriter.OpenBound(file)
	if err != nil {
		t.Fatal(err)
	}
	defer bound.Close()
	defer os.Chmod(docs, 0700)
	bound.SetTestHook(func(step filewriter.Step) {
		if step == filewriter.StepExchanged {
			if err := os.Chmod(docs, 0111); err != nil {
				t.Fatal(err)
			}
		}
	})
	next := "after"
	state := keptTextState{Files: []keptTextFileState{{ID: 0, Path: filepath.Base(file), File: file, Text: "before", Pending: &next}}}
	path := filepath.Join(dir, "state.keep.json")
	if err := saveKeptState(path, state); err != nil {
		t.Fatal(err)
	}
	if err := finishTestKeptWrite(path, &state, bound); err == nil {
		t.Fatal("unavailable directory sync reported success")
	}
	got, err := os.ReadFile(file)
	if err != nil || string(got) != "after" {
		t.Fatal("did not exercise uncertainty after source write")
	}
	var saved keptTextState
	if err := readKeptState(path, &saved); err != nil || saved.Files[0].Pending == nil || saved.Files[0].Text != "before" {
		t.Fatal("uncertain sync discarded pending journal")
	}
	if err := os.Chmod(docs, 0700); err != nil {
		t.Fatal(err)
	}
	bound.SetTestHook(nil)
	if err := finishTestKeptWrite(path, &saved, bound); err != nil {
		t.Fatalf("retry sync: %v", err)
	}
	if err := readKeptState(path, &saved); err != nil || saved.Files[0].Pending != nil || saved.Files[0].Text != "after" {
		t.Fatal("confirmed sync did not complete journal")
	}
}
