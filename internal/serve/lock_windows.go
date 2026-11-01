//go:build windows

package serve

import (
	"errors"
	"os"

	"golang.org/x/sys/windows"
)

// lockFile takes an exclusive lock on one byte far past the end of f, so the
// holder's name in the file stays readable, without waiting.
func lockFile(f *os.File) (ok bool, err error) {
	ol := &windows.Overlapped{Offset: 1 << 30}
	err = windows.LockFileEx(windows.Handle(f.Fd()), windows.LOCKFILE_EXCLUSIVE_LOCK|windows.LOCKFILE_FAIL_IMMEDIATELY, 0, 1, 0, ol)
	if errors.Is(err, windows.ERROR_LOCK_VIOLATION) {
		return false, nil
	}
	return err == nil, err
}

// unlockFile closes the file, which releases the lock, then removes it: an
// open file cannot be removed here.
func unlockFile(f *os.File, path string) {
	_ = f.Close()
	_ = os.Remove(path)
}
