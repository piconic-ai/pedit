package filewriter

import (
	"errors"
	"os"
	"runtime"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// retryDelay is how long the tests' Writers wait before they try a write again.
const retryDelay = 20 * time.Millisecond

// recorder collects what a Writer reports.
type recorder struct {
	mu      sync.Mutex
	errs    []error
	written int
}

// options are the Writer's with a short delay, so a retry comes soon.
func (r *recorder) options(bound *BoundFile) Options {
	return Options{
		Bound:      bound,
		Delay:      5 * time.Millisecond,
		RetryDelay: retryDelay,
		OnError: func(err error) {
			r.mu.Lock()
			defer r.mu.Unlock()
			r.errs = append(r.errs, err)
		},
		OnWritten: func() {
			r.mu.Lock()
			defer r.mu.Unlock()
			r.written++
		},
	}
}

// counts are how often the Writer reported an error, and a write that landed.
func (r *recorder) counts() (errs, written int) {
	r.mu.Lock()
	defer r.mu.Unlock()
	return len(r.errs), r.written
}

// waitUntil polls cond until it holds, and fails the test if it does not.
func waitUntil(t *testing.T, what string, cond func() bool) {
	t.Helper()
	for deadline := time.Now().Add(3 * time.Second); !cond(); time.Sleep(5 * time.Millisecond) {
		if time.Now().After(deadline) {
			t.Fatalf("timed out waiting for %s", what)
		}
	}
}

// blockWithDirectory replaces the file with a directory, which cannot be
// written over.
func blockWithDirectory(t *testing.T, path string) {
	t.Helper()
	if err := os.Remove(path); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(path, 0o755); err != nil {
		t.Fatal(err)
	}
}

// openBound opens path and closes it when the test ends.
func openBound(t *testing.T, path string) *BoundFile {
	t.Helper()
	bound, err := OpenBound(path)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = bound.Close() })
	return bound
}

// noTimer fails the test if the Writer has a write waiting.
func noTimer(t *testing.T, w *Writer) {
	t.Helper()
	w.mu.Lock()
	defer w.mu.Unlock()
	if w.timer != nil || w.pending != nil {
		t.Fatalf("a write is waiting: timer = %v, pending = %v", w.timer, w.pending)
	}
}

func TestRetriesAWriteThatFailed(t *testing.T) {
	path := setup(t, "v0")
	bound := openBound(t, path)
	r := &recorder{}
	w := New(path, "v0", r.options(bound))

	blockWithDirectory(t, path)
	w.Schedule("v1")
	waitUntil(t, "the write to be tried again", func() bool { errs, _ := r.counts(); return errs >= 3 })
	r.mu.Lock()
	for _, err := range r.errs {
		if !errors.Is(err, ErrNotRegular) {
			t.Errorf("error = %v", err)
		}
	}
	written := r.written
	r.mu.Unlock()
	if written != 0 {
		t.Fatalf("%d writes landed while the file was blocked", written)
	}

	// Whatever blocked the file is gone: the next try lands, and none follows.
	if err := os.Remove(path); err != nil {
		t.Fatal(err)
	}
	waitUntil(t, "the write to land", func() bool { _, written := r.counts(); return written == 1 })
	if got := read(t, path); got != "v1" || w.LastWritten() != "v1" {
		t.Fatalf("file = %q, LastWritten = %q", got, w.LastWritten())
	}
	noTimer(t, w)
}

func TestFlushLeavesNoRetryBehind(t *testing.T) {
	path := setup(t, "v0")
	bound := openBound(t, path)
	r := &recorder{}
	// A long debounce: the timer Schedule arms must not fire before Flush
	// takes the content, however long the test's goroutine is held up between
	// the two.
	opts := r.options(bound)
	opts.Delay = time.Minute
	w := New(path, "v0", opts)

	blockWithDirectory(t, path)
	w.Schedule("v1")
	if err := w.Flush(); !errors.Is(err, ErrNotRegular) {
		t.Fatalf("Flush = %v", err)
	}
	noTimer(t, w)
	time.Sleep(4 * retryDelay)
	if errs, written := r.counts(); errs != 1 || written != 0 {
		t.Fatalf("errors = %d, writes = %d", errs, written)
	}
}

func TestRetryGivesWayToNewerContent(t *testing.T) {
	path := setup(t, "v0")
	bound := openBound(t, path)
	r := &recorder{}
	w := New(path, "v0", r.options(bound))

	// The file is blocked just before v1 is put in place, and v2 is scheduled
	// while v1 is being written.
	var once sync.Once
	bound.SetTestHook(func(s Step) {
		if s != StepTempWritten {
			return
		}
		once.Do(func() {
			// Not blockWithDirectory: this is not the test's goroutine.
			if err := errors.Join(os.Remove(path), os.Mkdir(path, 0o755)); err != nil {
				t.Error(err)
			}
			w.Schedule("v2")
		})
	})
	w.Schedule("v1")
	waitUntil(t, "v2 to fail as well", func() bool { errs, _ := r.counts(); return errs >= 2 })
	if err := os.Remove(path); err != nil {
		t.Fatal(err)
	}
	waitUntil(t, "the write to land", func() bool { _, written := r.counts(); return written == 1 })
	// v1 was tried again at no time: it would have replaced v2.
	time.Sleep(4 * retryDelay)
	if got := read(t, path); got != "v2" || w.LastWritten() != "v2" {
		t.Fatalf("file = %q, LastWritten = %q", got, w.LastWritten())
	}
	if _, written := r.counts(); written != 1 {
		t.Fatalf("%d writes landed", written)
	}
	noTimer(t, w)
}

func TestDoesNotRetryOnceClosed(t *testing.T) {
	path := setup(t, "v0")
	bound, err := OpenBound(path)
	if err != nil {
		t.Fatal(err)
	}
	r := &recorder{}
	w := New(path, "v0", r.options(bound))

	if err := bound.Close(); err != nil {
		t.Fatal(err)
	}
	w.Schedule("v1")
	waitUntil(t, "the write to fail", func() bool { errs, _ := r.counts(); return errs == 1 })
	r.mu.Lock()
	first := r.errs[0]
	r.mu.Unlock()
	if !errors.Is(first, os.ErrClosed) {
		t.Fatalf("error = %v, want os.ErrClosed", first)
	}
	noTimer(t, w)
	time.Sleep(4 * retryDelay)
	if errs, _ := r.counts(); errs != 1 {
		t.Fatalf("%d errors: the write was tried again", errs)
	}
}

// A write that returns an error but left the content in the file is not
// written again: that would only repeat it.
func TestDoesNotRetryAWriteThatLanded(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("pedit holds the file open while it renames over it")
	}
	path := setup(t, "v0")
	bound := openBound(t, path)
	bound.noExchange.Store(true)
	// An editor opens the file just before pedit replaces it, and writes into
	// it a moment later: its save is lost.
	var editor *os.File
	var open, write sync.Once
	bound.SetTestHook(func(s Step) {
		switch s {
		case StepBeforeReplace:
			open.Do(func() {
				f, err := os.OpenFile(path, os.O_WRONLY, 0)
				if err != nil {
					t.Error(err)
					return
				}
				editor = f
			})
		case StepRechecking:
			write.Do(func() {
				if editor == nil {
					return
				}
				if _, err := editor.WriteAt([]byte("editor"), 0); err != nil {
					t.Error(err)
				}
				if err := editor.Close(); err != nil {
					t.Error(err)
				}
			})
		}
	})
	r := &recorder{}
	w := New(path, "v0", r.options(bound))
	w.Schedule("pedit")

	waitUntil(t, "the lost save to be reported", func() bool { errs, _ := r.counts(); return errs == 1 })
	r.mu.Lock()
	first := r.errs[0]
	written := r.written
	r.mu.Unlock()
	if !errors.Is(first, ErrSaveOverwritten) {
		t.Fatalf("error = %v, want ErrSaveOverwritten", first)
	}
	if written != 1 || w.LastWritten() != "pedit" {
		t.Fatalf("writes = %d, LastWritten = %q", written, w.LastWritten())
	}
	// The decision is made before the error is reported.
	w.mu.Lock()
	timer := w.timer
	w.mu.Unlock()
	if timer != nil {
		t.Fatal("a write that landed was left to be tried again")
	}
}

// A change outside pedit is merged first, which schedules the write again.
func TestDoesNotRetryAnExternalChange(t *testing.T) {
	path := setup(t, "v0")
	bound := openBound(t, path)
	bound.noExchange.Store(true)
	// Someone saves the file after pedit wrote its temporary file.
	var once sync.Once
	bound.SetTestHook(func(s Step) {
		if s != StepTempWritten {
			return
		}
		once.Do(func() {
			if err := os.WriteFile(path, []byte("editor"), 0o644); err != nil {
				t.Error(err)
			}
		})
	})
	r := &recorder{}
	var changed atomic.Int32
	opts := r.options(bound)
	opts.OnExternalChange = func() { changed.Add(1) }
	w := New(path, "v0", opts)
	w.Schedule("pedit")

	waitUntil(t, "the change to be found", func() bool { return changed.Load() == 1 })
	w.mu.Lock()
	timer := w.timer
	w.mu.Unlock()
	if timer != nil {
		t.Fatal("a write skipped for a change outside pedit was left to be tried again")
	}
	if errs, written := r.counts(); errs != 0 || written != 0 {
		t.Fatalf("errors = %d, writes = %d", errs, written)
	}
}
