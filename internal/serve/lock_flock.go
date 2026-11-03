package serve

import (
	"os"

	"github.com/piconic-ai/pedit/internal/flock"
)

// lockFile takes the lock on f without waiting (flock.TryLock).
func lockFile(f *os.File) (ok bool, err error) { return flock.TryLock(f) }
