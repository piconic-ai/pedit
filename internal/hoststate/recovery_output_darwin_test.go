//go:build darwin

package hoststate

import (
	"bytes"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
)

func TestRecoveryOutputPreservesEmptyAndRejectsUnsafePaths(t *testing.T) {
	s, err := Open(filepath.Join(t.TempDir(), "state"))
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	c := credentials()
	if err = s.Save(c); err != nil {
		t.Fatal(err)
	}
	text, err := s.PublishRecoveryOutput(c.RoomID, RecoveryText, nil)
	if err != nil {
		t.Fatal(err)
	}
	got, err := s.ReadRecoveryOutput(c.RoomID, RecoveryText, text)
	if err != nil || len(got) != 0 {
		t.Fatal("empty text not retained", err)
	}
	comments, err := s.PublishRecoveryOutput(c.RoomID, RecoveryComments, []byte("{}\n"))
	if err != nil {
		t.Fatal(err)
	}
	got, err = s.ReadRecoveryOutput(c.RoomID, RecoveryComments, comments)
	if err != nil || !bytes.Equal(got, []byte("{}\n")) {
		t.Fatal("comments unavailable", err)
	}
	if _, err = s.ReadRecoveryOutput(c.RoomID, RecoveryComments, text); err == nil {
		t.Fatal("accepted wrong output kind")
	}
	if err = os.Rename(text, text+".saved"); err != nil {
		t.Fatal(err)
	}
	if err = os.Symlink(comments, text); err != nil {
		t.Fatal(err)
	}
	if _, err = s.ReadRecoveryOutput(c.RoomID, RecoveryText, text); err == nil {
		t.Fatal("followed output symlink")
	}
	if err = os.Remove(text); err != nil {
		t.Fatal(err)
	}
	if err = os.Rename(text+".saved", text); err != nil {
		t.Fatal(err)
	}
	if err = os.Link(comments, comments+".extra"); err != nil {
		t.Fatal(err)
	}
	if _, err = s.ReadRecoveryOutput(c.RoomID, RecoveryComments, comments); err == nil {
		t.Fatal("accepted multiply linked output")
	}
	if err = os.Remove(comments + ".extra"); err != nil {
		t.Fatal(err)
	}
	if _, err = s.ReadRecoveryOutput("AAAAAAAAAAAAAAAAAAAAAA", RecoveryText, text); err == nil {
		t.Fatal("accepted wrong room")
	}
	if _, err = s.PublishRecoveryOutput(c.RoomID, RecoveryOutputKind(255), nil); err == nil {
		t.Fatal("accepted output kind")
	}
	s.syncFileHook = func(*os.File) error { return errors.New("sync") }
	if name, err := s.PublishRecoveryOutput(c.RoomID, RecoveryText, []byte("x")); err == nil || name != "" {
		t.Fatal("file sync failure published")
	}
	s.syncFileHook = nil
	s.syncDirHook = func() error { return errors.New("sync") }
	if name, err := s.PublishRecoveryOutput(c.RoomID, RecoveryText, []byte("x")); err == nil || name == "" {
		t.Fatal("uncertain publication lost path")
	}
	s.syncDirHook = nil
}

func TestRecoveryOutputProcessInterruption(t *testing.T) {
	if path := os.Getenv("PEDIT_OUTPUT_CHILD"); path != "" {
		s, err := Open(path)
		if err != nil {
			os.Exit(2)
		}
		if os.Getenv("PEDIT_OUTPUT_POINT") == "before" {
			s.syncFileHook = func(*os.File) error { os.Exit(7); return nil }
		} else {
			s.syncDirHook = func() error { os.Exit(7); return nil }
		}
		_, _ = s.PublishRecoveryOutput(credentials().RoomID, RecoveryText, []byte("complete output"))
		os.Exit(3)
	}
	for _, point := range []string{"before", "after"} {
		t.Run(point, func(t *testing.T) {
			path := filepath.Join(t.TempDir(), "state")
			s, err := Open(path)
			if err != nil {
				t.Fatal(err)
			}
			if err = s.Save(credentials()); err != nil {
				t.Fatal(err)
			}
			s.Close()
			cmd := exec.Command(os.Args[0], "-test.run=^TestRecoveryOutputProcessInterruption$")
			cmd.Env = append(os.Environ(), "PEDIT_OUTPUT_CHILD="+path, "PEDIT_OUTPUT_POINT="+point)
			err = cmd.Run()
			if e, ok := err.(*exec.ExitError); !ok || e.ExitCode() != 7 {
				t.Fatal("child", err)
			}
			s, err = Open(path)
			if err != nil {
				t.Fatal(err)
			}
			defer s.Close()
			files, err := filepath.Glob(filepath.Join(path, "*.recovery.txt"))
			if err != nil {
				t.Fatal(err)
			}
			want := 0
			if point == "after" {
				want = 1
			}
			if len(files) != want {
				t.Fatalf("got %d outputs", len(files))
			}
			if want == 1 {
				data, err := s.ReadRecoveryOutput(credentials().RoomID, RecoveryText, files[0])
				if err != nil || string(data) != "complete output" {
					t.Fatal("partial output", err)
				}
			}
		})
	}
}

func TestSyncCandidateDirectoryRetriesUncertainPublication(t *testing.T) {
	s, err := Open(filepath.Join(t.TempDir(), "state"))
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	c := credentials()
	if err = s.Save(c); err != nil {
		t.Fatal(err)
	}
	s.syncDirHook = func() error { return errors.New("sync") }
	path, err := s.PublishCandidate(c.RoomID, []byte("complete"))
	if err == nil || path == "" {
		t.Fatal("expected uncertain publication")
	}
	if err = s.SyncCandidateDirectory(); err == nil {
		t.Fatal("failed sync reported success")
	}
	s.syncDirHook = nil
	if err = s.SyncCandidateDirectory(); err != nil {
		t.Fatal(err)
	}
	raw, err := s.ReadCandidate(c.RoomID, path)
	if err != nil || string(raw) != "complete" {
		t.Fatal("published bytes unavailable", err)
	}
}
