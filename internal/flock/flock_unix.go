//go:build unix

package flock

import (
	"errors"
	"os"

	"golang.org/x/sys/unix"
)

// TryLock takes an exclusive lock on f without waiting; ok is false when
// another open file description holds it.
func TryLock(f *os.File) (ok bool, err error) {
	err = unix.Flock(int(f.Fd()), unix.LOCK_EX|unix.LOCK_NB)
	if errors.Is(err, unix.EWOULDBLOCK) {
		return false, nil
	}
	return err == nil, err
}
