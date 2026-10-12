//go:build windows

package main

import "io/fs"

// currentUID is the user pedit runs as. Windows has no uids.
var currentUID = func() int { return -1 }

// ownerOf reports no owner: Windows files have security descriptors instead,
// and a user's directories are not writable by others by default.
func ownerOf(fs.FileInfo) (int, bool) { return 0, false }
