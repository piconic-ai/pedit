//go:build !windows

package sessiondir

import (
	"fmt"
	"os"
	"syscall"
)

// privateDir is for Windows: the directory was made 0700 already.
func privateDir(string) error { return nil }

// checkPrivate refuses a directory that is a link, is not the user's own, or
// that others can reach.
func checkPrivate(dir string) error {
	info, err := os.Lstat(dir)
	if err != nil {
		return err
	}
	st, ok := info.Sys().(*syscall.Stat_t)
	if !info.IsDir() || !ok || int(st.Uid) != os.Geteuid() || info.Mode().Perm()&0o077 != 0 {
		return fmt.Errorf("%s must be a directory of yours that only you can reach (mode 0700)", dir)
	}
	return nil
}
