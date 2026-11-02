package filewriter

import "time"

// renameBackoff is how long to wait before each new try of a rename that
// failed for a reason that may pass. A var so tests can shorten it.
var renameBackoff = []time.Duration{
	10 * time.Millisecond, 25 * time.Millisecond, 50 * time.Millisecond,
	100 * time.Millisecond, 250 * time.Millisecond, 500 * time.Millisecond,
}

// transient tells whether a failed rename may succeed later. Only Windows has
// such failures (see transient_windows.go). A var so tests can set it.
var transient = transientRename

// rename moves tmpName over the file's name. On Windows another process (an
// editor, an indexer, antivirus) may hold the file open without sharing
// delete, so a refused rename is tried again with backoff before the error is
// returned. The rename is atomic, so a failure leaves the file as it was and
// never half written.
func (f *BoundFile) rename(tmpName string) error {
	err := f.calls.rename(f.root, tmpName, f.name)
	for _, d := range renameBackoff {
		if err == nil || !transient(err) {
			return err
		}
		time.Sleep(d)
		err = f.calls.rename(f.root, tmpName, f.name)
	}
	return err
}
