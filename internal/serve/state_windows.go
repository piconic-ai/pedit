//go:build windows

package serve

import (
	"os"
	"path/filepath"

	"github.com/piconic-ai/pedit/internal/fileowner"
)

// stateTrusted reports whether the state file f (open, and the Lstat info taken
// before) may be read. Windows has no 0600: the owner and the access list are
// checked on the handle readState holds, so the file cannot be swapped after
// the check, and its directory must be private too (see fileowner.Private).
func stateTrusted(f *os.File, info os.FileInfo) bool {
	return info.Mode().IsRegular() && fileowner.Private(f) && fileowner.PrivatePath(filepath.Dir(f.Name()))
}

// privateDir makes a state directory this process just created private; a
// directory that was there is left as its owner set it.
func privateDir(dir string) error { return fileowner.MakePrivate(dir) }
