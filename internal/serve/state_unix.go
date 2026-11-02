//go:build !windows

package serve

import "os"

// stateTrusted reports whether the state file may be read: a regular file of
// mode 0600 (written by this pedit, which creates its directory 0700).
func stateTrusted(_ *os.File, info os.FileInfo) bool {
	return info.Mode().IsRegular() && info.Mode().Perm() == 0o600
}

// privateDir is for Windows: the directory was made 0700 already.
func privateDir(string) error { return nil }
