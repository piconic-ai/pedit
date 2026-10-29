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

func TestObserverSlotReplacementAndSyncErrors(t *testing.T) {
	s, err := Open(filepath.Join(t.TempDir(), "state"))
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	c := credentials()
	if err = s.Save(c); err != nil {
		t.Fatal(err)
	}
	if err = s.SaveObserver(c.RoomID, nil, []byte("old")); err != nil {
		t.Fatal(err)
	}
	if s.SaveObserver(c.RoomID, nil, []byte("stale")) == nil {
		t.Fatal("accepted stale empty slot")
	}
	if s.SaveObserver(c.RoomID, []byte("wrong"), []byte("stale")) == nil {
		t.Fatal("accepted stale expected value")
	}
	s.syncFileHook = func(*os.File) error { return errors.New("sync") }
	if s.SaveObserver(c.RoomID, []byte("old"), []byte("new")) == nil {
		t.Fatal("accepted failed file sync")
	}
	s.syncFileHook = nil
	got, err := s.LoadObserver(c.RoomID)
	if err != nil || string(got) != "old" {
		t.Fatal("old value lost", err)
	}
	s.syncDirHook = func() error { return errors.New("sync") }
	if s.SaveObserver(c.RoomID, []byte("old"), []byte("new")) == nil {
		t.Fatal("accepted failed directory sync")
	}
	if _, err = s.LoadObserver(c.RoomID); err == nil {
		t.Fatal("loaded uncertain state before sync")
	}
	s.syncDirHook = nil
	got, err = s.LoadObserver(c.RoomID)
	if err != nil || string(got) != "new" {
		t.Fatal("renamed value unavailable", err)
	}
	if s.SaveObserver(c.RoomID, []byte("new"), bytes.Repeat([]byte{1}, maxCandidateBytes+1)) == nil {
		t.Fatal("accepted oversized observation")
	}
	paths, err := s.ListCandidates(c.RoomID)
	if err != nil || len(paths) != 0 {
		t.Fatal("slot leaked into candidate namespace", err)
	}
}

func TestObserverSlotProcessInterruption(t *testing.T) {
	if path := os.Getenv("PEDIT_OBSERVER_CHILD"); path != "" {
		s, err := Open(path)
		if err != nil {
			os.Exit(2)
		}
		if os.Getenv("PEDIT_OBSERVER_POINT") == "before" {
			s.syncFileHook = func(*os.File) error { os.Exit(7); return nil }
		} else {
			s.syncDirHook = func() error { os.Exit(7); return nil }
		}
		_ = s.SaveObserver(credentials().RoomID, []byte("old"), []byte("new"))
		os.Exit(3)
	}
	for _, point := range []string{"before", "after"} {
		t.Run(point, func(t *testing.T) {
			path := filepath.Join(t.TempDir(), "state")
			s, err := Open(path)
			if err != nil {
				t.Fatal(err)
			}
			c := credentials()
			if err = s.Save(c); err != nil {
				t.Fatal(err)
			}
			if err = s.SaveObserver(c.RoomID, nil, []byte("old")); err != nil {
				t.Fatal(err)
			}
			s.Close()
			cmd := exec.Command(os.Args[0], "-test.run=^TestObserverSlotProcessInterruption$")
			cmd.Env = append(os.Environ(), "PEDIT_OBSERVER_CHILD="+path, "PEDIT_OBSERVER_POINT="+point)
			err = cmd.Run()
			if e, ok := err.(*exec.ExitError); !ok || e.ExitCode() != 7 {
				t.Fatalf("child: %v", err)
			}
			s, err = Open(path)
			if err != nil {
				t.Fatal(err)
			}
			defer s.Close()
			got, err := s.LoadObserver(c.RoomID)
			want := "old"
			if point == "after" {
				want = "new"
			}
			if err != nil || string(got) != want {
				t.Fatalf("got %q, %v; want %q", got, err, want)
			}
		})
	}
}
