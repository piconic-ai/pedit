//go:build unix

package serve

import (
	"errors"
	"os"
	"strings"
	"syscall"

	"golang.org/x/sys/unix"
)

// openLock opens, creating it if needed, the lock file name in root, never
// through a symlink and without blocking on a FIFO.
func openLock(root *os.Root, name string) (*os.File, error) {
	return root.OpenFile(name, os.O_RDWR|os.O_CREATE|unix.O_NOFOLLOW|unix.O_NONBLOCK, 0o600)
}

func openLockRead(root *os.Root, name string) (*os.File, error) {
	return root.OpenFile(name, os.O_RDONLY|unix.O_NOFOLLOW|unix.O_NONBLOCK, 0)
}

// isNotLock reports an open that failed because of what is at the path: a
// symlink, a directory or a device.
func isNotLock(err error) bool {
	return err != nil && (errors.Is(err, unix.ELOOP) || errors.Is(err, unix.EISDIR) || errors.Is(err, unix.ENXIO) ||
		strings.Contains(err.Error(), "path escapes from parent")) // os.Root on a link planted after the Lstat
}

// ours reports a regular file owned by the current user.
func ours(info os.FileInfo) bool {
	st, ok := info.Sys().(*syscall.Stat_t)
	return ok && info.Mode().IsRegular() && int(st.Uid) == os.Geteuid()
}

// lockFile takes an exclusive advisory lock on f without waiting; ok is false
// when another open file description holds it.
func lockFile(f *os.File) (ok bool, err error) {
	err = unix.Flock(int(f.Fd()), unix.LOCK_EX|unix.LOCK_NB)
	if errors.Is(err, unix.EWOULDBLOCK) {
		return false, nil
	}
	return err == nil, err
}

// unlockFile removes the file while still holding its lock, so nobody can
// lock the removed file and mistake it for the lock.
func unlockFile(f *os.File, root *os.Root, name string) {
	_ = root.Remove(name)
	_ = f.Close()
}
