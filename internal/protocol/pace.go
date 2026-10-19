package protocol

import (
	"math"
	"time"
)

// Rate is a burst, then a steady rate per second.
type Rate struct {
	Burst     float64
	PerSecond float64
}

// What one connection may send to the relay: messages, and their bytes on
// the wire. The relay (packages/worker) closes a connection over either with
// close code 1008, and a host closed so ends the room. Bytes allow every peer
// of a full room (32) to send a whole document at once. Keep equal to
// RELAY_MESSAGE_RATE and RELAY_BYTE_RATE in packages/protocol.
var (
	RelayMessages = Rate{Burst: 1000, PerSecond: 200}
	RelayBytes    = Rate{Burst: 32 * MaxFrameBytes, PerSecond: 1 << 20}
)

// paceMargin is the share of the relay's rates a Client keeps to, for clock
// drift.
const paceMargin = 7.0 / 8

// pacer paces what a Client sends on one connection so it stays within the
// relay's rates: a room that shares several files sends each file's state on
// connecting, and can outrun the relay's allowance where one file never
// does. Editing stays far below it and is never held back. Not safe for
// concurrent use: the outbox loop alone takes from it.
type pacer struct {
	messages, bytes           Rate
	messageTokens, byteTokens float64
	at                        time.Time
	now                       func() time.Time
}

func newPacer(messages, bytes Rate, now func() time.Time) *pacer {
	if messages == (Rate{}) {
		messages = RelayMessages
	}
	if bytes == (Rate{}) {
		bytes = RelayBytes
	}
	messages = Rate{messages.Burst * paceMargin, messages.PerSecond * paceMargin}
	bytes = Rate{bytes.Burst * paceMargin, bytes.PerSecond * paceMargin}
	return &pacer{
		messages:      messages,
		bytes:         bytes,
		messageTokens: messages.Burst,
		byteTokens:    bytes.Burst,
		at:            now(),
		now:           now,
	}
}

// take takes one message of n bytes from the allowance, and returns how long
// to wait before sending it: 0 within the allowance.
func (p *pacer) take(n int) time.Duration {
	now := p.now()
	seconds := max(0, now.Sub(p.at).Seconds())
	p.at = now
	p.messageTokens = min(p.messages.Burst, p.messageTokens+seconds*p.messages.PerSecond)
	p.byteTokens = min(p.bytes.Burst, p.byteTokens+seconds*p.bytes.PerSecond)
	p.messageTokens--
	p.byteTokens -= float64(n)
	wait := math.Max(-p.messageTokens/p.messages.PerSecond, -p.byteTokens/p.bytes.PerSecond)
	if wait <= 0 {
		return 0
	}
	return time.Duration(wait * float64(time.Second))
}
