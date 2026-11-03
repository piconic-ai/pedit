//go:build windows

package sessiondir

import (
	"fmt"

	"github.com/piconic-ai/pedit/internal/fileowner"
)

// privateDir gives a directory this process just made an access list for
// the user alone.
func privateDir(dir string) error { return fileowner.MakePrivate(dir) }

// checkPrivate refuses a directory that others can reach.
func checkPrivate(dir string) error {
	if !fileowner.PrivatePath(dir) {
		return fmt.Errorf("%s must be a directory only you can reach", dir)
	}
	return nil
}
