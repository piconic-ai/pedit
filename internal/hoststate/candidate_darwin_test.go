//go:build darwin

package hoststate

import (
	"bytes"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"testing"

	"golang.org/x/sys/unix"
)

func TestPublishCandidateKeepsPriorFilesAndRejectsSyncFailure(t *testing.T) {
	path := filepath.Join(t.TempDir(), "host")
	s, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	c := credentials()
	if err = s.Save(c); err != nil {
		t.Fatal(err)
	}
	a, err := s.PublishCandidate(c.RoomID, []byte("first"))
	if err != nil {
		t.Fatal(err)
	}
	b, err := s.PublishCandidate(c.RoomID, []byte("second"))
	if err != nil || a == b {
		t.Fatal("candidate replaced previous")
	}
	got, err := os.ReadFile(a)
	if err != nil || string(got) != "first" {
		t.Fatal("first candidate was lost")
	}
	fd, err := unix.Open(a, unix.O_RDONLY|unix.O_NOFOLLOW, 0)
	if err != nil {
		t.Fatal(err)
	}
	defer unix.Close(fd)
	if _, err = checked(fd, false); err != nil {
		t.Fatal(err)
	}
	s.syncFileHook = func(*os.File) error { return errors.New("sync") }
	if name, err := s.PublishCandidate(c.RoomID, []byte("third")); err == nil || name != "" {
		t.Fatal("failed sync published")
	}
	s.syncFileHook = nil
	s.syncDirHook = func() error { return errors.New("sync") }
	name, err := s.PublishCandidate(c.RoomID, []byte("fourth"))
	if err == nil || name == "" {
		t.Fatal("published path not returned after sync failure")
	}
	s.syncDirHook = nil
	data, err := os.ReadFile(name)
	if err != nil || !bytes.Equal(data, []byte("fourth")) {
		t.Fatal("published candidate lost")
	}
	got, err = os.ReadFile(a)
	if err != nil || string(got) != "first" {
		t.Fatal("failure changed earlier candidate")
	}
}

func TestCandidateProcessInterruption(t *testing.T) {
	if path := os.Getenv("PEDIT_CANDIDATE_CHILD"); path != "" {
		s, err := Open(path)
		if err != nil {
			os.Exit(2)
		}
		if os.Getenv("PEDIT_CANDIDATE_POINT") == "before" {
			s.syncFileHook = func(*os.File) error { os.Exit(7); return nil }
		} else {
			s.syncDirHook = func() error { os.Exit(7); return nil }
		}
		s.PublishCandidate(credentials().RoomID, []byte("whole candidate"))
		os.Exit(3)
	}
	for _, point := range []string{"before", "after"} {
		t.Run(point, func(t *testing.T) {
			path := filepath.Join(t.TempDir(), "host")
			s, err := Open(path)
			if err != nil {
				t.Fatal(err)
			}
			if err = s.Save(credentials()); err != nil {
				t.Fatal(err)
			}
			s.Close()
			cmd := exec.Command(os.Args[0], "-test.run=^TestCandidateProcessInterruption$")
			cmd.Env = append(os.Environ(), "PEDIT_CANDIDATE_CHILD="+path, "PEDIT_CANDIDATE_POINT="+point)
			err = cmd.Run()
			if e, ok := err.(*exec.ExitError); !ok || e.ExitCode() != 7 {
				t.Fatalf("child: %v", err)
			}
			s, err = Open(path)
			if err != nil {
				t.Fatal(err)
			}
			defer s.Close()
			files, err := filepath.Glob(filepath.Join(path, "*.recovery.json"))
			if err != nil {
				t.Fatal(err)
			}
			want := 0
			if point == "after" {
				want = 1
			}
			if len(files) != want {
				t.Fatalf("published %d files, want %d", len(files), want)
			}
			if want == 1 {
				data, err := os.ReadFile(files[0])
				if err != nil || string(data) != "whole candidate" {
					t.Fatal("partial candidate published")
				}
			}
			if _, err = s.Load(credentials().RoomID); err != nil {
				t.Fatal("credentials lost")
			}
		})
	}
}

func TestReadCandidateRejectsSymlinksAndOtherRooms(t *testing.T) {
	root := t.TempDir()
	s, err := Open(filepath.Join(root, "host"))
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	c := credentials()
	if err = s.Save(c); err != nil {
		t.Fatal(err)
	}
	name, err := s.PublishCandidate(c.RoomID, []byte("saved"))
	if err != nil {
		t.Fatal(err)
	}
	if got, err := s.ReadCandidate(c.RoomID, name); err != nil || string(got) != "saved" {
		t.Fatal("candidate not read")
	}
	if _, err = s.ReadCandidate("AAAAAAAAAAAAAAAAAAAAAA", name); err == nil {
		t.Fatal("other room read candidate")
	}
	victim := filepath.Join(root, "victim")
	if err = os.WriteFile(victim, []byte("victim"), 0600); err != nil {
		t.Fatal(err)
	}
	if err = os.Remove(name); err != nil {
		t.Fatal(err)
	}
	if err = os.Symlink(victim, name); err != nil {
		t.Fatal(err)
	}
	if _, err = s.ReadCandidate(c.RoomID, name); err == nil {
		t.Fatal("followed candidate symlink")
	}
	if got, err := os.ReadFile(victim); err != nil || string(got) != "victim" {
		t.Fatal("victim changed")
	}
}
