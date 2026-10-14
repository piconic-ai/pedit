package protocol

import (
	"fmt"
	"regexp"
	"strconv"
)

var expiredReason = regexp.MustCompile(`^the room reached its time limit of (\d{1,10}) seconds$`)

// ExpiredReason is the close reason that tells clients how long the relay
// lets a room last. Keep it equal to expiredReason in packages/protocol.
func ExpiredReason(seconds int) string {
	return fmt.Sprintf("the room reached its time limit of %d seconds", seconds)
}

// ParseExpiredReason returns the limit in seconds a RoomExpired reason names,
// or false if it names none.
func ParseExpiredReason(reason string) (int, bool) {
	m := expiredReason.FindStringSubmatch(reason)
	if m == nil {
		return 0, false
	}
	n, err := strconv.Atoi(m[1])
	if err != nil || n <= 0 {
		return 0, false
	}
	return n, true
}
