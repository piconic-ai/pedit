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
