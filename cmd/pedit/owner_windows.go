//go:build windows

package main

import (
	"os"

	"github.com/piconic-ai/pedit/internal/fileowner"
)

// fileOwner returns the SID of the user who owns f, and whether that owner
// may configure pedit for the user pedit runs as. Anyone can create folders at
// the root of the system drive, so the owner is checked here as on Unix.
func fileOwner(f *os.File) (string, bool, error) {
	owner, me, err := fileowner.SIDs(f)
	if err != nil {
		return "", false, err
	}
	return owner, trustedSID(owner, me), nil
}
