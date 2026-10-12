//go:build unix

package main

import (
	"io/fs"
	"os"
	"syscall"
)

// currentUID is the user pedit runs as. Tests replace it.
var currentUID = os.Geteuid

// ownerOf returns the uid of the user who owns a file.
func ownerOf(info fs.FileInfo) (int, bool) {
	st, ok := info.Sys().(*syscall.Stat_t)
	if !ok {
		return 0, false
	}
	return int(st.Uid), true
}
