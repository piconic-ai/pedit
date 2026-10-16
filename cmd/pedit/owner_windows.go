//go:build windows

package main

import (
	"os"

	"golang.org/x/sys/windows"
)

// fileOwner returns the SID of the user who owns f, and whether that owner
// may configure pedit for the user pedit runs as. Anyone can create folders at
// the root of the system drive, so the owner is checked here as on Unix.
func fileOwner(f *os.File) (string, bool, error) {
	sd, err := windows.GetSecurityInfo(windows.Handle(f.Fd()), windows.SE_FILE_OBJECT, windows.OWNER_SECURITY_INFORMATION)
	if err != nil {
		return "", false, err
	}
	owner, _, err := sd.Owner()
	if err != nil {
		return "", false, err
	}
	user, err := windows.GetCurrentProcessToken().GetTokenUser()
	if err != nil {
		return "", false, err
	}
	sid := owner.String()
	return sid, trustedSID(sid, user.User.Sid.String()), nil
}
