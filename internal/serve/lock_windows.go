//go:build windows

package serve

import (
	"os"
	"path/filepath"

	"golang.org/x/sys/windows"
)

// openLock opens, creating it if needed, the lock file with FILE_SHARE_DELETE,
// which Go's own open leaves out, so the holder can remove it while locked.
func openLock(root *os.Root, name string) (*os.File, error) {
	return createLock(root, name, windows.OPEN_ALWAYS)
}

// createLock opens the lock with FILE_FLAG_OPEN_REPARSE_POINT, so a link at
// the name is opened itself, not its target, and ours then refuses it.
func createLock(root *os.Root, name string, disposition uint32) (*os.File, error) {
	path := filepath.Join(root.Name(), name)
	p, err := windows.UTF16PtrFromString(path)
	if err != nil {
		return nil, err
	}
	h, err := windows.CreateFile(p, windows.GENERIC_READ|windows.GENERIC_WRITE,
		windows.FILE_SHARE_READ|windows.FILE_SHARE_WRITE|windows.FILE_SHARE_DELETE,
		nil, disposition, windows.FILE_ATTRIBUTE_NORMAL|windows.FILE_FLAG_OPEN_REPARSE_POINT, 0)
	if err != nil {
		return nil, &os.PathError{Op: "open", Path: path, Err: err}
	}
	return os.NewFile(uintptr(h), path), nil
}

func openLockRead(root *os.Root, name string) (*os.File, error) {
	return createLock(root, name, windows.OPEN_EXISTING)
}

// isNotLock reports an open refused for what is at the path; the Lstat before
// the open has caught those on Windows.
func isNotLock(error) bool { return false }

// ours reports a regular file; the directory's ACL decides who else has it.
func ours(info os.FileInfo) bool { return info.Mode().IsRegular() }

// unlockFile removes the file while still holding its lock, as on Unix: the
// name stays (delete pending) until the close, so nobody can lock the file
// or create a new one in between.
func unlockFile(f *os.File, root *os.Root, name string) {
	_ = root.Remove(name)
	_ = f.Close()
}
