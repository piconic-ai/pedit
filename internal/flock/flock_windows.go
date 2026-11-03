//go:build windows

package flock

import (
	"errors"
	"os"

	"golang.org/x/sys/windows"
)

// TryLock takes an exclusive lock on one byte far past the end of f, so what
// the file says stays readable, without waiting; ok is false when another
// handle holds it.
func TryLock(f *os.File) (ok bool, err error) {
	ol := &windows.Overlapped{Offset: 1 << 30}
	err = windows.LockFileEx(windows.Handle(f.Fd()), windows.LOCKFILE_EXCLUSIVE_LOCK|windows.LOCKFILE_FAIL_IMMEDIATELY, 0, 1, 0, ol)
	if errors.Is(err, windows.ERROR_LOCK_VIOLATION) {
		return false, nil
	}
	return err == nil, err
}
