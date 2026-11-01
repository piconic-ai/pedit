package serve

import (
	"context"
	"time"

	"github.com/coder/websocket"
	"github.com/reearth/ygo/encoding"
)

// Caps on what one connection, and the room, may ask of pedit.
const (
	// maxConnAwareness is how many awareness client IDs one connection may
	// announce; maxRoomAwareness is how many distinct ones the room holds.
	maxConnAwareness = 8
	maxRoomAwareness = 64

	defaultPingInterval = 30 * time.Second
	defaultFrameRate    = 1000 // frames per second, as the relay's burst limit
	defaultStep1Rate    = 10   // sync step 1 per second: each encodes the whole doc

	// roleHeader marks a read-only connection. It is trusted: only processes
	// of the same user reach the 0700 socket, and the embedding library that
	// drives them sets it for the clients it does not trust.
	roleHeader = "X-Pedit-Role"
	roleRead   = "read"
)

// closeError ends a connection with a WebSocket close code and a reason.
type closeError struct {
	code   websocket.StatusCode
	reason string
	cause  error // what went wrong, for OnError; not sent
}

func (e *closeError) Error() string {
	if e.cause != nil {
		return e.reason + ": " + e.cause.Error()
	}
	return e.reason
}

// malformed is a frame the client got wrong: a close with 1003.
func malformed(cause error) error {
	return &closeError{websocket.StatusUnsupportedData, "malformed frame", cause}
}

var (
	errReadOnly      = &closeError{4003, "read-only connection", nil}
	errTooManyFrames = &closeError{websocket.StatusPolicyViolation, "too many frames", nil}
	errTooManyStep1  = &closeError{websocket.StatusPolicyViolation, "too many sync requests", nil}
	errTooManyAware  = &closeError{websocket.StatusPolicyViolation, "too many awareness clients", nil}
)

// bucket is a token bucket of rate tokens per second, rate at most at once.
type bucket struct {
	rate, tokens float64
	last         time.Time
}

func newBucket(rate int) *bucket {
	return &bucket{rate: float64(rate), tokens: float64(rate), last: time.Now()}
}

func (b *bucket) allow() bool {
	now := time.Now()
	b.tokens = min(b.rate, b.tokens+now.Sub(b.last).Seconds()*b.rate)
	b.last = now
	if b.tokens < 1 {
		return false
	}
	b.tokens--
	return true
}

// parseFrame reads a frame's type and, for a sync message, its sub-type with
// ygo's own varuint reader, which ApplySyncMessage uses too, so that the
// checks here and the message applied cannot disagree (it accepts overlong
// forms such as 0x81 0x00 for 1). rest starts at the sub-type for a sync
// message, as ApplySyncMessage wants it, and after the type otherwise.
func parseFrame(data []byte) (kind, sub uint64, rest []byte, err error) {
	dec := encoding.NewDecoder(data)
	if kind, err = dec.ReadVarUint(); err != nil {
		return 0, 0, nil, err
	}
	rest = data[len(data)-dec.Remaining():]
	if kind == msgSync {
		sub, err = dec.ReadVarUint()
	}
	return kind, sub, rest, err
}

// awarenessIDs lists the client IDs of an awareness update that carry a
// state; an entry with the state "null" is a removal and adds no one.
func awarenessIDs(update []byte) ([]uint64, error) {
	dec := encoding.NewDecoder(update)
	n, err := dec.ReadVarUint()
	if err != nil {
		return nil, err
	}
	var ids []uint64
	for range n {
		id, err := dec.ReadVarUint()
		if err != nil {
			return nil, err
		}
		if _, err = dec.ReadVarUint(); err != nil { // clock
			return nil, err
		}
		state, err := dec.ReadVarString()
		if err != nil {
			return nil, err
		}
		if state != "null" {
			ids = append(ids, id)
		}
	}
	return ids, nil
}

// checkAwareness refuses an update that would make c or the room hold too
// many awareness client IDs. Only IDs that are not present in the room count:
// a provider echoes what it received, and an echo is neither new nor c's. An
// ID that was removed and is brought back counts as new. The IDs c owns are
// recorded as ygo accepts them (see accept). The caller holds s.mu.
func (s *Server) checkAwareness(c *client, ids []uint64) error {
	var fresh []uint64
	present := s.aw.GetStates()
	for _, id := range ids {
		if _, here := present[id]; !here && !c.ids[id] && !contains(fresh, id) {
			fresh = append(fresh, id)
		}
	}
	if len(fresh) == 0 {
		return nil
	}
	if len(c.ids)+len(fresh) > maxConnAwareness {
		return errTooManyAware
	}
	room := map[uint64]bool{}
	for o := range s.clients {
		for id := range o.ids {
			room[id] = true
		}
	}
	if len(room)+len(fresh) > maxRoomAwareness {
		return errTooManyAware
	}
	return nil
}

func contains(ids []uint64, id uint64) bool {
	for _, x := range ids {
		if x == id {
			return true
		}
	}
	return false
}

// heartbeat pings conn every interval and closes it with 1001 after two pings
// in a row went unanswered, so an idle tab that is gone does not keep the
// server (and its child process) alive. It runs until ctx ends.
func heartbeat(ctx context.Context, conn *websocket.Conn, interval time.Duration) {
	t := time.NewTicker(interval)
	defer t.Stop()
	missed := 0
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
		}
		pctx, cancel := context.WithTimeout(ctx, interval)
		err := conn.Ping(pctx)
		cancel()
		switch {
		case err == nil:
			missed = 0
		case ctx.Err() != nil:
			return
		default:
			if missed++; missed >= 2 {
				_ = conn.Close(websocket.StatusGoingAway, "ping timeout")
				return
			}
		}
	}
}
