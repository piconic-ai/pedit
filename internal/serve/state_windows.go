//go:build windows

package serve

import (
	"os"
	"path/filepath"

	"github.com/piconic-ai/pedit/internal/fileowner"
)

// stateTrusted reports whether the state file may be read. Windows has no
// 0600: the file and its directory must be owned by the user this process runs
// as (or by SYSTEM or the Administrators group, who own what an elevated user
// creates), so another user cannot plant a state.
func stateTrusted(path string, info os.FileInfo) bool {
	return info.Mode().IsRegular() && fileowner.Trusted(path) && fileowner.Trusted(filepath.Dir(path))
}
