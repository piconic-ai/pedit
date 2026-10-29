//go:build darwin

package hoststate

import (
	"bytes"
	"os"

	"golang.org/x/sys/unix"
)

// CheckPrivateFile verifies a local APFS regular file has an explicit empty ACL
// and is owned by the caller with mode 0600 and a single link.
func CheckPrivateFile(f *os.File) error {
	return checkPrivateFileLinks(f, 1)
}

// CheckPrivateRetainedFile permits the two private names held by a recovery journal.
func CheckPrivateRetainedFile(f *os.File) error {
	return checkPrivateFileLinks(f, 2)
}

func checkPrivateFileLinks(f *os.File, maxLinks uint16) error {
	var fs unix.Statfs_t
	if f == nil || unix.Fstatfs(int(f.Fd()), &fs) != nil || string(bytes.TrimRight(fs.Fstypename[:], "\x00")) != "apfs" || fs.Flags&unix.MNT_LOCAL == 0 {
		return ErrUnavailable
	}
	var st unix.Stat_t
	if unix.Fstat(int(f.Fd()), &st) != nil || st.Mode&unix.S_IFMT != unix.S_IFREG || st.Uid != uint32(os.Geteuid()) || st.Mode&07777 != 0600 || st.Nlink < 1 || st.Nlink > maxLinks || emptyACL(int(f.Fd())) != nil {
		return ErrUnavailable
	}
	return nil
}

// PreparePrivateFile is only for a caller's freshly created, empty file.
func PreparePrivateFile(f *os.File) error {
	if f == nil {
		return ErrUnavailable
	}
	info, err := f.Stat()
	if err != nil || !info.Mode().IsRegular() || info.Size() != 0 {
		return ErrUnavailable
	}
	if err = setEmptyACL(int(f.Fd())); err != nil {
		return ErrUnavailable
	}
	return CheckPrivateFile(f)
}

// SyncPrivateFile flushes file data and requests a device flush on macOS.
func SyncPrivateFile(f *os.File) error {
	if err := CheckPrivateFile(f); err != nil {
		return err
	}
	if err := f.Sync(); err != nil {
		return err
	}
	_, err := unix.FcntlInt(f.Fd(), unix.F_FULLFSYNC, 0)
	return err
}

// SyncDirectory requests directory and device synchronization. The caller is
// responsible for checking the directory identity and parent permissions.
func SyncDirectory(dir *os.File) error {
	if dir == nil {
		return ErrUnavailable
	}
	var fs unix.Statfs_t
	if unix.Fstatfs(int(dir.Fd()), &fs) != nil || string(bytes.TrimRight(fs.Fstypename[:], "\x00")) != "apfs" || fs.Flags&unix.MNT_LOCAL == 0 {
		return ErrUnavailable
	}
	if err := dir.Sync(); err != nil {
		return err
	}
	_, err := unix.FcntlInt(dir.Fd(), unix.F_FULLFSYNC, 0)
	return err
}

// CheckPrivateDirectory restricts recovery to an owned local APFS directory
// with an explicit empty ACL and mode 0700.
func CheckPrivateDirectory(f *os.File) error {
	if f == nil {
		return ErrUnavailable
	}
	var fs unix.Statfs_t
	if unix.Fstatfs(int(f.Fd()), &fs) != nil || string(bytes.TrimRight(fs.Fstypename[:], "\x00")) != "apfs" || fs.Flags&unix.MNT_LOCAL == 0 {
		return ErrUnavailable
	}
	if _, err := checked(int(f.Fd()), true); err != nil {
		return ErrUnavailable
	}
	return nil
}
