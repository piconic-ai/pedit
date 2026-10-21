package meta

import (
	"errors"
	"fmt"

	"github.com/piconic-ai/pedit/internal/protocol"
	"github.com/reearth/ygo/crdt"
)

// Limits on a metadata doc, which every peer applies to each update it
// receives, so a hostile key holder cannot make a peer hold more than it can
// send: the relay closes the socket of a peer whose frame passes 1 MiB.
const (
	// MaxDocBytes bounds the doc, encoded, so its whole state fits the frame
	// it is sent in, with room for the frame's headers. The host shares no
	// comments larger (session.openMeta), so every peer can take the state
	// the host sends.
	MaxDocBytes = protocol.MaxFrameBytes - 4<<10
	// MaxClientClock bounds the operations of one client: setting a key, or
	// adding a comment, is one.
	MaxClientClock = 1 << 16
)

// MaxPlaceItems bounds the items that share a place in the doc: a parent,
// a key and the item they were inserted after. Honest peers make one, or a
// few when they set the same key at once; Yjs and ygo take time in the
// square of their number to apply them.
const MaxPlaceItems = 64

// ErrRefused marks an update a peer drops by these rules.
var ErrRefused = errors.New("refused")

// CheckUpdate tells whether update, received for doc, a metadata doc, may be
// applied. It reads the update without applying it, and refuses it when:
//
//   - it holds anything but maps and plain values, as no comments do;
//   - part of it, structs or deletions, would wait for updates not received
//     yet (Yjs keeps those as pending, and sends them on with the doc, past
//     every check). This refusal wraps protocol.ErrRetryLater: the client
//     asks the room again, and an honest peer's updates come back whole;
//   - it takes one of its clients past MaxClientClock operations;
//   - it puts more than MaxPlaceItems items in one place;
//   - the doc could pass MaxDocBytes.
//
// It costs time in the size of the doc and the update, and applying an
// update it passes costs no more. The caller holds the lock updates to doc
// are applied under.
func CheckUpdate(doc *crdt.Doc, update []byte) (err error) {
	// protocol.Client recovers too; this keeps the refusal an ErrRefused for
	// every caller, and fuzzing going.
	defer func() {
		if r := recover(); r != nil {
			err = fmt.Errorf("%w: update makes the check panic: %v", ErrRefused, r)
		}
	}()
	sv := doc.StateVector()
	known := make(map[uint64]uint64, len(sv))
	for c, clock := range sv {
		known[uint64(c)] = clock
	}
	u := newScanned(known)
	if err := scan(update, u); err != nil {
		return fmt.Errorf("%w: %v", ErrRefused, err)
	}
	for client, end := range u.end {
		if end > MaxClientClock {
			return fmt.Errorf("%w: client %d passed %d operations", ErrRefused, client, MaxClientClock)
		}
	}
	if missing(u) {
		return fmt.Errorf("%w: %w: it needs updates not received yet", ErrRefused, protocol.ErrRetryLater)
	}
	state := crdt.EncodeStateAsUpdateV1(doc, nil)
	if n := len(state) + len(update) + 32*u.ranges; n > MaxDocBytes {
		return fmt.Errorf("%w: the comments could take %d bytes", ErrRefused, n)
	}
	have := newScanned(nil)
	if err := scan(state, have); err != nil {
		return fmt.Errorf("%w: the doc: %v", ErrRefused, err)
	}
	for p, n := range u.places {
		if n+have.places[p] > MaxPlaceItems {
			return fmt.Errorf("%w: more than %d items in one place", ErrRefused, MaxPlaceItems)
		}
	}
	return nil
}

// missing tells whether an update, scanned, needs structs that neither it
// nor the doc, at sv, has.
func missing(u *scanned) bool {
	for client, start := range u.start {
		if start > u.known[client] {
			return true
		}
	}
	has := func(client, clock uint64) bool {
		return clock < max(u.known[client], u.end[client])
	}
	for _, d := range u.deps {
		if !has(d.client, d.clock) {
			return true
		}
	}
	for client, end := range u.deleted {
		if end > 0 && !has(client, end-1) {
			return true
		}
	}
	return false
}
