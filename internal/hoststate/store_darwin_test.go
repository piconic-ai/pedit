//go:build darwin

package hoststate

import (
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"sync"
	"testing"

	"golang.org/x/sys/unix"
)

func credentials() Credentials {
	c := Credentials{Version: 1, Origin: "https://edit.piconic.ai", RoomID: "AAECAwQFBgcICQoLDA0ODw", HostToken: "host-token", Generation: 1}
	c.EditSecret[0] = 1
	c.HostSeed[0] = 2
	return c
}
func TestStoreCredentials(t *testing.T) {
	path := filepath.Join(t.TempDir(), "host")
	s, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	c := credentials()
	if err = s.Save(c); err != nil {
		t.Fatal(err)
	}
	got, err := s.Load(c.RoomID)
	if err != nil || got != c {
		t.Fatalf("load failed: %v", err)
	}
	keys, priv, err := got.Keys()
	if err != nil || keys == nil || len(priv) != 64 {
		t.Fatal("key derivation failed")
	}
	if _, err = Open(path); err == nil {
		t.Fatal("concurrent open succeeded")
	}
	if err = s.Close(); err != nil {
		t.Fatal(err)
	}
	s, err = Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	c.Generation = 2
	if err = s.Save(c); err != nil {
		t.Fatal(err)
	}
	c.Generation = 1
	if err = s.Save(c); !errors.Is(err, ErrInvalid) {
		t.Fatalf("rollback accepted: %v", err)
	}
	got, err = s.Load(c.RoomID)
	if err != nil || got.Generation != 2 {
		t.Fatal("accepted rollback or lost record")
	}
	c.Generation = 2
	c.HostToken = "another"
	if err = s.Save(c); !errors.Is(err, ErrInvalid) {
		t.Fatal("identity change accepted")
	}
}
func TestUnsafeOrCorruptObjectsRejected(t *testing.T) {
	t.Run("untrusted directory", func(t *testing.T) {
		path := filepath.Join(t.TempDir(), "existing")
		if err := os.Mkdir(path, 0700); err != nil {
			t.Fatal(err)
		}
		if _, err := Open(path); err == nil {
			t.Fatal("unverified ACL accepted")
		}
	})
	t.Run("directory symlink", func(t *testing.T) {
		p := t.TempDir()
		path := filepath.Join(p, "link")
		if err := os.Symlink(p, path); err != nil {
			t.Fatal(err)
		}
		if _, err := Open(path); err == nil {
			t.Fatal("symlink accepted")
		}
	})
	t.Run("changed identity", func(t *testing.T) {
		p := t.TempDir()
		path := filepath.Join(p, "host")
		s, err := Open(path)
		if err != nil {
			t.Fatal(err)
		}
		defer s.Close()
		if err = os.Rename(path, path+"-moved"); err != nil {
			t.Fatal(err)
		}
		if err = os.Mkdir(path, 0700); err != nil {
			t.Fatal(err)
		}
		if err = s.Save(credentials()); err == nil {
			t.Fatal("moved directory accepted")
		}
	})
	t.Run("corrupt", func(t *testing.T) {
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
		if err = os.WriteFile(filepath.Join(path, c.RoomID), []byte("{bad"), 0600); err != nil {
			t.Fatal(err)
		}
		if err = s.Save(c); err == nil {
			t.Fatal("corruption overwritten")
		}
	})
	t.Run("hardlink", func(t *testing.T) {
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
		if err = os.Link(filepath.Join(path, c.RoomID), filepath.Join(path, "other")); err != nil {
			t.Fatal(err)
		}
		if _, err = s.Load(c.RoomID); err == nil {
			t.Fatal("hardlink accepted")
		}
	})
}
func TestLockReleasedWhenProcessDies(t *testing.T) {
	if p := os.Getenv("PEDIT_LOCK_CHILD"); p != "" {
		s, err := Open(p)
		if err != nil {
			os.Exit(2)
		}
		defer s.Close()
		os.Stdout.Write([]byte("ready\n"))
		select {}
	}
	path := filepath.Join(t.TempDir(), "host")
	cmd := exec.Command(os.Args[0], "-test.run=^TestLockReleasedWhenProcessDies$")
	cmd.Env = append(os.Environ(), "PEDIT_LOCK_CHILD="+path)
	out, err := cmd.StdoutPipe()
	if err != nil {
		t.Fatal(err)
	}
	if err = cmd.Start(); err != nil {
		t.Fatal(err)
	}
	var b [6]byte
	if _, err = out.Read(b[:]); err != nil {
		t.Fatal(err)
	}
	if _, err = Open(path); err == nil {
		t.Fatal("lock not held")
	}
	if err = cmd.Process.Kill(); err != nil {
		t.Fatal(err)
	}
	cmd.Wait()
	s, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	s.Close()
}
func TestFileACLBeforeWrite(t *testing.T) {
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
	fd, err := unix.Open(filepath.Join(path, c.RoomID), unix.O_RDONLY|unix.O_NOFOLLOW, 0)
	if err != nil {
		t.Fatal(err)
	}
	defer unix.Close(fd)
	if _, err = checked(fd, false); err != nil {
		t.Fatal(err)
	}
}

func TestSyncFailuresDoNotReportSuccess(t *testing.T) {
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
	c.Generation = 2
	s.syncFileHook = func(*os.File) error { return errors.New("file sync failure") }
	if err = s.Save(c); err == nil {
		t.Fatal("file sync failure reported success")
	}
	s.syncFileHook = nil
	got, err := s.Load(c.RoomID)
	if err != nil || got.Generation != 1 {
		t.Fatal("failed file sync changed saved record")
	}
	s.syncDirHook = func() error { return errors.New("directory sync failure") }
	if err = s.Save(c); err == nil {
		t.Fatal("directory sync failure reported success")
	}
	s.syncDirHook = nil
	got, err = s.Load(c.RoomID)
	if err != nil || got.Generation != 2 {
		t.Fatal("post-rename state is not a complete record")
	}
	if err = s.Save(c); err != nil {
		t.Fatal(err)
	}
}

func TestInterruptedSave(t *testing.T) {
	if path := os.Getenv("PEDIT_SAVE_CHILD"); path != "" {
		s, err := Open(path)
		if err != nil {
			os.Exit(2)
		}
		c := credentials()
		c.Generation = 2
		if os.Getenv("PEDIT_CRASH_POINT") == "before" {
			s.syncFileHook = func(*os.File) error { os.Exit(7); return nil }
		} else {
			s.syncDirHook = func() error { os.Exit(7); return nil }
		}
		s.Save(c)
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
			cmd := exec.Command(os.Args[0], "-test.run=^TestInterruptedSave$")
			cmd.Env = append(os.Environ(), "PEDIT_SAVE_CHILD="+path, "PEDIT_CRASH_POINT="+point)
			err = cmd.Run()
			if e, ok := err.(*exec.ExitError); !ok || e.ExitCode() != 7 {
				t.Fatalf("child: %v", err)
			}
			s, err = Open(path)
			if err != nil {
				t.Fatal(err)
			}
			defer s.Close()
			c, err := s.Load(credentials().RoomID)
			if err != nil {
				t.Fatal(err)
			}
			want := uint64(1)
			if point == "after" {
				want = 2
			}
			if c.Generation != want {
				t.Fatalf("generation %d, want %d", c.Generation, want)
			}
		})
	}
}

func TestInheritedACLIsClearedBeforeSecrets(t *testing.T) {
	parent := t.TempDir()
	cmd := exec.Command("/bin/chmod", "+a", "everyone allow list,search,readattr,readextattr,readsecurity,file_inherit,directory_inherit", parent)
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("set inherited ACL: %v %s", err, out)
	}
	path := filepath.Join(parent, "host")
	s, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	if err = s.Save(credentials()); err != nil {
		t.Fatal(err)
	}
	f, err := s.file(credentials().RoomID, false)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	if err = emptyACL(int(f.Fd())); err != nil {
		t.Fatal("inherited ACL remained on credentials")
	}
}

func TestConcurrentGenerationUpdates(t *testing.T) {
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
	var wg sync.WaitGroup
	for i := 2; i <= 20; i++ {
		wg.Add(1)
		go func(g uint64) {
			defer wg.Done()
			v := c
			v.Generation = g
			err := s.Save(v)
			if err != nil && !errors.Is(err, ErrInvalid) {
				t.Errorf("save: %v", err)
			}
		}(uint64(i))
	}
	wg.Wait()
	got, err := s.Load(c.RoomID)
	if err != nil || got.Generation != 20 {
		t.Fatalf("concurrent generation: %d, %v", got.Generation, err)
	}
}
