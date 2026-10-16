//go:build unix

package main

import (
	"fmt"
	"io/fs"
	"os"
	"syscall"
)

// currentUID is the user pedit runs as. Tests replace it.
var currentUID = os.Geteuid

// fileOwner returns the uid of the user who owns f, and whether that owner
// may configure pedit for the user pedit runs as.
func fileOwner(f *os.File) (string, bool, error) {
	info, err := f.Stat()
	if err != nil {
		return "", false, err
	}
	uid, ok := ownerOf(info)
	if !ok {
		return "", true, nil
	}
	return fmt.Sprintf("uid %d", uid), trustedOwner(uid, currentUID()), nil
}

// ownerOf returns the uid of the user who owns a file.
func ownerOf(info fs.FileInfo) (int, bool) {
	st, ok := info.Sys().(*syscall.Stat_t)
	if !ok {
		return 0, false
	}
	return int(st.Uid), true
}
