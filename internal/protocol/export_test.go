package protocol

import (
	"testing"
	"time"
)

// ShortenResyncForTest has Clients ask the room again after d, not
// resyncEvery, until the test ends.
func ShortenResyncForTest(t *testing.T, d time.Duration) {
	old := resyncEvery
	resyncEvery = d
	t.Cleanup(func() { resyncEvery = old })
}
