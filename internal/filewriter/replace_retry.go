package filewriter

import "time"

// renameBackoff is how long renameChecked waits before each new try of a
// rename that failed for a reason that may pass. A var so tests can shorten it.
var renameBackoff = []time.Duration{
	10 * time.Millisecond, 25 * time.Millisecond, 50 * time.Millisecond,
	100 * time.Millisecond, 250 * time.Millisecond, 500 * time.Millisecond,
}

// transient tells whether a failed rename may succeed later. Only Windows has
// such failures (see transient_windows.go): another process (an editor, an
// indexer, antivirus) holds the file open without sharing delete. A var so
// tests can set it.
var transient = transientRename
