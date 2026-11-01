//go:build unix

package serve

import (
	"errors"
	"os"

	"golang.org/x/sys/unix"
)

// openLock opens, creating it if needed, the lock file.
func openLock(path string) (*os.File, error) {
	return os.OpenFile(path, os.O_RDWR|os.O_CREATE, 0o600)
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
func unlockFile(f *os.File, path string) {
	_ = os.Remove(path)
	_ = f.Close()
}
