package session

import (
	"fmt"
	"math"

	"github.com/piconic-ai/pedit/internal/protocol"
)

// SizeLimit is how much pedit shares, as people read it: a room gets the
// whole state in one frame, which the relay caps at protocol.MaxFrameBytes.
var SizeLimit = fmt.Sprintf("about %d MiB", protocol.MaxFrameBytes>>20)

// TooLargeError means a file is too large to share: a room gets its whole
// state in one frame, which the relay caps at protocol.MaxFrameBytes.
type TooLargeError struct {
	File string
	// Size is the file's size in bytes.
	Size int
	// Shared is the size of the frame that would carry a canvas, whose
	// shared form is larger than its file; 0 for text.
	Shared int
}

func (e *TooLargeError) Error() string {
	if e.Shared > 0 {
		return fmt.Sprintf("%s is %s, %s once shared as a board; pedit shares up to %s for now", e.File, mib(e.Size), mib(e.Shared), SizeLimit)
	}
	return fmt.Sprintf("%s is %s; pedit shares files up to %s for now", e.File, mib(e.Size), SizeLimit)
}

// mib writes n bytes in MiB to one decimal, rounded up, so a size over a
// limit never reads as within it.
func mib(n int) string { return fmt.Sprintf("%.1f MiB", math.Ceil(float64(n)*10/(1<<20))/10) }
