package serve

import (
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"testing"
	"time"

	"github.com/reearth/ygo/crdt"
)

// restarter serves one file over and over with one state directory.
type restarter struct {
	t    *testing.T
	file string
	base string
}

func newRestarter(t *testing.T, content string) *restarter {
	t.Helper()
	r := &restarter{t: t, file: filepath.Join(t.TempDir(), "doc.md"), base: base(t)}
	write(t, r.file, content)
	return r
}

func (r *restarter) open() *Server {
	r.t.Helper()
	s, err := Open(r.file, Options{
		App:        "test",
		WriteDelay: 20 * time.Millisecond,
		StateDir:   r.base,
		OnError:    func(err error) { r.t.Log("serve error:", err) },
	})
	if err != nil {
		r.t.Fatal(err)
	}
	return s
}

// A client that kept its copy across a restart reconnects: the update it had
// is applied again to a fresh client of the new server, as a reconnect does.
func reconnectWith(t *testing.T, s *Server, old *tclient) *tclient {
	t.Helper()
	old.mu.Lock()
	state := crdt.EncodeStateAsUpdateV1(old.doc, nil)
	old.mu.Unlock()
	c := dial(t, s)
	c.mu.Lock()
	err := crdt.ApplyUpdateV1(c.doc, state, nil)
	c.mu.Unlock()
	if err != nil {
		t.Fatal(err)
	}
	return c
}

func TestRestartResumesTheDocumentAndItsGeneration(t *testing.T) {
	r := newRestarter(t, "hello\n")
	s1 := r.open()
	c1 := dial(t, s1)
	eventually(t, "the text", func() bool { return c1.get() == "hello\n" })
	c1.insert(5, " world")
	eventually(t, "the file", fileIs(t, r.file, "hello world\n"))
	gen := s1.Generation()
	if len(gen) != 32 {
		t.Fatalf("generation %q", gen)
	}
	if err := s1.Close(); err != nil {
		t.Fatal(err)
	}

	s2 := r.open()
	t.Cleanup(func() { _ = s2.Close() })
	if s2.Generation() != gen {
		t.Fatalf("generation %q, want %q", s2.Generation(), gen)
	}
	c2 := reconnectWith(t, s2, c1)
	time.Sleep(200 * time.Millisecond)
	if got := s2.render(); got != "hello world\n" || c2.get() != got {
		t.Fatalf("doc %q, client %q: the old copy was duplicated or lost", got, c2.get())
	}
}

func TestFileEditedWhileDownIsMergedAndKeepsTheGeneration(t *testing.T) {
	r := newRestarter(t, "hello\n")
	s1 := r.open()
	c1 := dial(t, s1)
	eventually(t, "the text", func() bool { return c1.get() == "hello\n" })
	gen := s1.Generation()
	if err := s1.Close(); err != nil {
		t.Fatal(err)
	}
	write(t, r.file, "hello\nfrom an editor\n")

	s2 := r.open()
	t.Cleanup(func() { _ = s2.Close() })
	if s2.Generation() != gen {
		t.Fatalf("generation %q, want %q", s2.Generation(), gen)
	}
	c2 := reconnectWith(t, s2, c1)
	eventually(t, "the edit in the client", func() bool { return c2.get() == "hello\nfrom an editor\n" })
	if got := s2.render(); got != "hello\nfrom an editor\n" {
		t.Fatalf("doc %q", got)
	}
}

func TestUnusableStateIsDiscardedWithANewGeneration(t *testing.T) {
	stale := func(t *testing.T, path string, rec *stateRecord) {
		rec.Saved = time.Now().Add(-stateMaxAge - time.Hour)
		if err := writeState(path, *rec); err != nil {
			t.Fatal(err)
		}
	}
	for name, damage := range map[string]func(*testing.T, string, *stateRecord){
		"older than 7 days": stale,
		"newer version": func(t *testing.T, path string, rec *stateRecord) {
			rec.Version = stateVersion + 1
			if err := writeState(path, *rec); err != nil {
				t.Fatal(err)
			}
		},
		"unreadable": func(t *testing.T, path string, _ *stateRecord) {
			if err := os.WriteFile(path, []byte("{not json"), 0o600); err != nil {
				t.Fatal(err)
			}
		},
		"not private": func(t *testing.T, path string, _ *stateRecord) {
			if err := os.Chmod(path, 0o644); err != nil {
				t.Fatal(err)
			}
		},
		"doc is not what was written": func(t *testing.T, path string, rec *stateRecord) {
			rec.Written = "something else\n"
			if err := writeState(path, *rec); err != nil {
				t.Fatal(err)
			}
		},
	} {
		t.Run(name, func(t *testing.T) {
			if name == "not private" && runtime.GOOS == "windows" {
				t.Skip("Windows has no file mode; the owner is checked by SID instead")
			}
			r := newRestarter(t, "hello\n")
			s1 := r.open()
			gen, path := s1.Generation(), s1.statePath
			if err := s1.Close(); err != nil {
				t.Fatal(err)
			}
			rec := readState(path)
			if rec == nil {
				t.Fatal("no state after a clean exit")
			}
			damage(t, path, rec)

			s2 := r.open()
			t.Cleanup(func() { _ = s2.Close() })
			if s2.Generation() == gen {
				t.Fatal("the state was used")
			}
			if got := s2.render(); got != "hello\n" {
				t.Fatalf("doc %q", got)
			}
		})
	}
}

func TestStateIsRemovedWhenTheFileIsGone(t *testing.T) {
	r := newRestarter(t, "hello\n")
	s1 := r.open()
	path := s1.statePath
	if readState(path) == nil {
		t.Fatal("no state while serving")
	}
	if err := os.Remove(r.file); err != nil {
		t.Fatal(err)
	}
	_ = s1.Close()
	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Fatalf("state left behind after the file was removed: %v", err)
	}

	// A state left by a crash is removed by the next start that finds no file.
	if err := writeState(path, stateRecord{Version: stateVersion, Generation: "x", Saved: time.Now(), Doc: []byte{0}}); err != nil {
		t.Fatal(err)
	}
	if _, err := Open(r.file, Options{StateDir: r.base}); err == nil {
		t.Fatalf("open of a missing file: %v", err)
	}
	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Fatalf("state left behind: %v", err)
	}
}

func TestTwoInstancesNeverShareAState(t *testing.T) {
	r := newRestarter(t, "hello\n")
	s1 := r.open()
	t.Cleanup(func() { _ = s1.Close() })
	before := readState(s1.statePath)
	var held *HeldError
	if _, err := Open(r.file, Options{App: "second", StateDir: r.base}); !errors.As(err, &held) {
		t.Fatalf("second open: %v", err)
	}
	if after := readState(s1.statePath); after == nil || after.Generation != before.Generation {
		t.Fatal("the refused start touched the state")
	}
}

// A crash can come between saving the state and writing the file, or between
// writing the file and saving the state that says so: either way the edit
// must not come back as a new one.
func TestCrashAroundAFileWriteDoesNotRepeatTheEdit(t *testing.T) {
	for name, onDisk := range map[string]string{"file written": "hello world\n", "file not written": "hello\n"} {
		t.Run(name, func(t *testing.T) {
			r := newRestarter(t, "hello\n")
			s1 := r.open()
			c1 := dial(t, s1)
			eventually(t, "the text", func() bool { return c1.get() == "hello\n" })
			c1.insert(5, " world")
			eventually(t, "the file", fileIs(t, r.file, "hello world\n"))
			path, gen := s1.statePath, s1.Generation()
			if err := s1.Close(); err != nil {
				t.Fatal(err)
			}
			rec := readState(path)
			pending := "hello world\n"
			rec.Written, rec.Pending = "hello\n", &pending
			if err := writeState(path, *rec); err != nil {
				t.Fatal(err)
			}
			write(t, r.file, onDisk)

			s2 := r.open()
			t.Cleanup(func() { _ = s2.Close() })
			if s2.Generation() != gen {
				t.Fatal("the generation changed")
			}
			c2 := reconnectWith(t, s2, c1)
			eventually(t, "the file", fileIs(t, r.file, "hello world\n"))
			time.Sleep(200 * time.Millisecond)
			if got := s2.render(); got != "hello world\n" || c2.get() != got {
				t.Fatalf("doc %q, client %q", got, c2.get())
			}
		})
	}
}

// With a write in doubt, a file that is neither text cannot be merged from a
// known base: the state is discarded rather than guessed at.
func TestFileChangedAroundAnUncertainWriteStartsAfresh(t *testing.T) {
	r := newRestarter(t, "hello\n")
	s1 := r.open()
	c1 := dial(t, s1)
	eventually(t, "the text", func() bool { return c1.get() == "hello\n" })
	c1.insert(5, " world")
	eventually(t, "the file", fileIs(t, r.file, "hello world\n"))
	path, gen := s1.statePath, s1.Generation()
	if err := s1.Close(); err != nil {
		t.Fatal(err)
	}
	rec := readState(path)
	pending := "hello world\n"
	rec.Written, rec.Pending = "hello\n", &pending
	if err := writeState(path, *rec); err != nil {
		t.Fatal(err)
	}
	write(t, r.file, "hello world!\n")
	s2 := r.open()
	t.Cleanup(func() { _ = s2.Close() })
	if s2.Generation() == gen || s2.render() != "hello world!\n" {
		t.Fatalf("generation kept %v, doc %q", s2.Generation() == gen, s2.render())
	}
}
