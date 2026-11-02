//go:build windows

package filewriter

import (
	"errors"

	"golang.org/x/sys/windows"
)

// transientRename reports a rename refused because the file is open in
// another process: access denied, a sharing violation or a lock violation.
func transientRename(err error) bool {
	return errors.Is(err, windows.ERROR_ACCESS_DENIED) ||
		errors.Is(err, windows.ERROR_SHARING_VIOLATION) ||
		errors.Is(err, windows.ERROR_LOCK_VIOLATION)
}

// deniedForGood reports a refusal that waiting will not lift: the file has the
// read-only attribute (Go clears the write bits of its mode for it).
func (f *BoundFile) deniedForGood() bool {
	info, err := f.root.Lstat(f.name)
	return err == nil && info.Mode().IsRegular() && info.Mode().Perm()&0o200 == 0
}
