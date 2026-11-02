//go:build windows

// Package fileowner tells who owns a file on Windows, by SID. Windows has no
// 0600 mode, so a file or directory that only the user may be trusted with is
// checked by its owner.
package fileowner

import (
	"os"

	"golang.org/x/sys/windows"
)

// SIDs returns the SID of the owner of f (a file or a directory) and the SID
// of the user this process runs as.
func SIDs(f *os.File) (owner, me string, err error) {
	sd, err := windows.GetSecurityInfo(windows.Handle(f.Fd()), windows.SE_FILE_OBJECT, windows.OWNER_SECURITY_INFORMATION)
	if err != nil {
		return "", "", err
	}
	o, _, err := sd.Owner()
	if err != nil {
		return "", "", err
	}
	user, err := windows.GetCurrentProcessToken().GetTokenUser()
	if err != nil {
		return "", "", err
	}
	return o.String(), user.User.Sid.String(), nil
}

// OwnedByMe reports whether the user this process runs as owns path.
func OwnedByMe(path string) bool {
	f, err := os.Open(path)
	if err != nil {
		return false
	}
	defer f.Close()
	owner, me, err := SIDs(f)
	return err == nil && owner == me
}
