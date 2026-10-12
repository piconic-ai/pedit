//go:build unix

package filewriter

import (
	"errors"
	"os"
	"path/filepath"
	"slices"
	"syscall"
	"testing"
)

// A file Write moved aside and then cannot open is left where it is: it may
// be a save made outside pedit, and removing it would lose it.
func TestWriteKeepsWhatItCannotCheckWhileItIsThere(t *testing.T) {
	requireExchange(t)
	r := newRace(t, "v0")
	var old syscall.Rlimit
	if err := syscall.Getrlimit(syscall.RLIMIT_NOFILE, &old); err != nil {
		t.Fatal(err)
	}
	// Restored even after a Fatal; a lowered limit would break the other tests.
	t.Cleanup(func() { _ = syscall.Setrlimit(syscall.RLIMIT_NOFILE, &old) })
	// With no descriptor to give, the second read of the moved-aside file fails
	// with EMFILE while the file is still there. The limit is process-wide, so
	// no test here may be parallel.
	r.at(StepRechecking, 1, func() {
		lim := old
		lim.Cur = 3
		if err := syscall.Setrlimit(syscall.RLIMIT_NOFILE, &lim); err != nil {
			t.Fatal(err)
		}
	})
	err := r.flush("pedit")
	if serr := syscall.Setrlimit(syscall.RLIMIT_NOFILE, &old); serr != nil {
		t.Fatal(serr)
	}
	var kept *KeptError
	if !errors.As(err, &kept) {
		t.Fatalf("Flush = %v, want a KeptError", err)
	}
	if left := r.leftovers(); !slices.Equal(left, []string{kept.Name}) {
		t.Fatalf("leftovers = %v, want only %s", left, kept.Name)
	}
	b, rerr := os.ReadFile(filepath.Join(filepath.Dir(r.path), kept.Name))
	if rerr != nil || string(b) != "v0" {
		t.Fatalf("kept file = %q, %v", b, rerr)
	}
	if got := r.onDisk(); got != "pedit" {
		t.Fatalf("file = %q", got)
	}
}
