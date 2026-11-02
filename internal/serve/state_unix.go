//go:build !windows

package serve

import "os"

// stateTrusted reports whether the state file may be read: a regular file of
// mode 0600 (written by this pedit, which creates its directory 0700).
func stateTrusted(_ string, info os.FileInfo) bool {
	return info.Mode().IsRegular() && info.Mode().Perm() == 0o600
}
