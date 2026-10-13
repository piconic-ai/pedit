package filewriter

import (
	"errors"
	"os"

	"golang.org/x/sys/unix"
)

// exchange swaps the entries a and b of root's directory atomically, so what b
// named is moved to a rather than unlinked.
func exchange(root *os.Root, a, b string) error {
	return renameat2(root, a, b, unix.RENAME_EXCHANGE)
}

// renameNoReplace renames from to to. It fails with os.ErrExist if to exists.
func renameNoReplace(root *os.Root, from, to string) error {
	return renameat2(root, from, to, unix.RENAME_NOREPLACE)
}

// renameat2 works on a descriptor of the directory root holds and is given
// only plain names, so nothing is looked up outside that directory and it
// follows a link in neither name.
func renameat2(root *os.Root, from, to string, flags uint) error {
	dir, err := root.Open(".")
	if err != nil {
		return err
	}
	defer dir.Close()
	conn, err := dir.SyscallConn()
	if err != nil {
		return err
	}
	var errno error
	if err := conn.Control(func(fd uintptr) {
		errno = unix.Renameat2(int(fd), from, int(fd), to, flags)
	}); err != nil {
		return err
	}
	switch {
	case errno == nil:
		return nil
	case errors.Is(errno, unix.ENOSYS), errors.Is(errno, unix.EINVAL), errors.Is(errno, unix.EOPNOTSUPP):
		// Kernels before 3.15, and file systems such as NFS.
		return errUnsupported
	}
	return &os.LinkError{Op: "renameat2", Old: from, New: to, Err: errno}
}
