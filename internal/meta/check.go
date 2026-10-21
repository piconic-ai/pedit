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

// MaxListItems bounds the items of one list in the doc: those set under
// one key of a map, in the order Yjs keeps them. Honest peers add one each
// time they set the key; Yjs and ygo take time in the square of a list's
// length to apply items to it.
const MaxListItems = 1024

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
//   - it makes a list longer than MaxListItems;
//   - the doc could pass MaxDocBytes.
//
// It costs time in the size of the doc and the update, and applying an
// update it passes costs no more than its lists allow. The caller holds the
// lock updates to doc are applied under.
func CheckUpdate(doc *crdt.Doc, update []byte) (err error) {
	// protocol.Client recovers too; this keeps the refusal an ErrRefused for
	// every caller, and fuzzing going.
	defer func() {
		if r := recover(); r != nil {
			err = fmt.Errorf("%w: update makes the check panic: %v", ErrRefused, r)
		}
	}()
	u, err := scan(update)
	if err != nil {
		return fmt.Errorf("%w: %v", ErrRefused, err)
	}
	known := map[uint64]uint64{}
	for c, clock := range doc.StateVector() {
		known[uint64(c)] = clock
	}
	end := map[uint64]uint64{}
	for _, r := range u.recs {
		c := r.at.client
		if _, ok := end[c]; !ok && r.at.clock > known[c] {
			return fmt.Errorf("%w: %w: it skips structs of client %d", ErrRefused, protocol.ErrRetryLater, c)
		}
		if end[c] = r.at.clock + r.length; end[c] > MaxClientClock {
			return fmt.Errorf("%w: client %d passed %d operations", ErrRefused, c, MaxClientClock)
		}
	}
	for c, e := range u.deleted {
		if e > max(known[c], end[c]) {
			return fmt.Errorf("%w: %w: it deletes what was not received", ErrRefused, protocol.ErrRetryLater)
		}
	}
	state := crdt.EncodeStateAsUpdateV1(doc, nil)
	if n := len(state) + len(update) + 32*u.ranges; n > MaxDocBytes {
		return fmt.Errorf("%w: the comments could take %d bytes", ErrRefused, n)
	}
	have, err := scan(state)
	if err != nil {
		return fmt.Errorf("%w: the doc: %v", ErrRefused, err)
	}
	missing, long := newLists(have.recs, u.recs, known).check()
	if missing {
		return fmt.Errorf("%w: %w: it needs updates not received yet", ErrRefused, protocol.ErrRetryLater)
	}
	if long {
		return fmt.Errorf("%w: a list of more than %d items", ErrRefused, MaxListItems)
	}
	return nil
}
