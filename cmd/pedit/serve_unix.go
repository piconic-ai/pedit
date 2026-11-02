//go:build unix

package main

import (
	"os/signal"
	"syscall"
)

// ignoreSIGPIPE keeps pedit serve alive when the app that started it has gone:
// Go ends a program that writes to a broken stdout or stderr pipe with SIGPIPE,
// and the final `saved` event is written while the file is being flushed on
// the way out. Ignoring the signal turns that write into an EPIPE error, which
// the event writer drops, and the shutdown (the last write, the state file,
// the lock) completes.
func ignoreSIGPIPE() { signal.Ignore(syscall.SIGPIPE) }
