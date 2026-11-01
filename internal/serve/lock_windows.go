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

// openLock opens, creating it if needed, the lock file with FILE_SHARE_DELETE,
// which Go's own open leaves out, so the holder can remove it while locked.
func openLock(path string) (*os.File, error) {
	p, err := windows.UTF16PtrFromString(path)
	if err != nil {
		return nil, err
	}
	h, err := windows.CreateFile(p, windows.GENERIC_READ|windows.GENERIC_WRITE,
		windows.FILE_SHARE_READ|windows.FILE_SHARE_WRITE|windows.FILE_SHARE_DELETE,
		nil, windows.OPEN_ALWAYS, windows.FILE_ATTRIBUTE_NORMAL, 0)
	if err != nil {
		return nil, &os.PathError{Op: "open", Path: path, Err: err}
	}
	return os.NewFile(uintptr(h), path), nil
}

// unlockFile removes the file while still holding its lock, as on Unix: the
// name stays (delete pending) until the close, so nobody can lock the file
// or create a new one in between.
func unlockFile(f *os.File, path string) {
	_ = os.Remove(path)
	_ = f.Close()
}
