package meta

import (
	"errors"
	"fmt"

	"github.com/reearth/ygo/crdt"
)

// Limits on a metadata doc, which every peer applies to each update it
// receives, so a hostile key holder cannot make a peer hold more than it can
// send: the relay closes the socket of a peer whose frame passes 1 MiB.
const (
	// MaxDocBytes bounds the doc, encoded: well under the 1 MiB frame its
	// whole state is sent in.
	MaxDocBytes = 512 << 10
	// MaxClientClock bounds the operations of one client: setting a key, or
	// adding a comment, is one.
	MaxClientClock = 1 << 16
)

// ErrRefused marks an update a peer drops by these rules.
var ErrRefused = errors.New("refused")

// CheckUpdate tells whether update, received for doc, a metadata doc, may be
// applied. It applies it to a copy of doc first, and refuses it when:
//
//   - part of it would wait for updates not received yet (Yjs keeps those as
//     pending, and sends them on with the doc, past every check);
//   - it takes one client past MaxClientClock operations;
//   - the doc would pass MaxDocBytes.
//
// An honest update refused for a gap comes back with the answer to this
// peer's next SyncStep1. The caller holds the lock updates to doc are
// applied under.
func CheckUpdate(doc *crdt.Doc, update []byte) (err error) {
	defer func() {
		if r := recover(); r != nil {
			err = fmt.Errorf("%w: update makes ygo panic: %v", ErrRefused, r)
		}
	}()
	want, err := stateOf(update)
	if err != nil {
		return fmt.Errorf("%w: %v", ErrRefused, err)
	}
	copied := crdt.New()
	if err := crdt.ApplyUpdateV1(copied, crdt.EncodeStateAsUpdateV1(doc, nil), nil); err != nil {
		return err
	}
	if err := crdt.ApplyUpdateV1(copied, update, nil); err != nil {
		return fmt.Errorf("%w: %v", ErrRefused, err)
	}
	got := copied.StateVector()
	for client, clock := range want {
		if got[client] < clock {
			return fmt.Errorf("%w: it skips updates of client %d", ErrRefused, client)
		}
		if clock > MaxClientClock {
			return fmt.Errorf("%w: client %d passed %d operations", ErrRefused, client, MaxClientClock)
		}
	}
	if n := len(crdt.EncodeStateAsUpdateV1(copied, nil)); n > MaxDocBytes {
		return fmt.Errorf("%w: the comments would take %d bytes", ErrRefused, n)
	}
	return nil
}

// stateOf is the state an update brings each client to.
func stateOf(update []byte) (crdt.StateVector, error) {
	sv, err := crdt.EncodeStateVectorFromUpdate(update)
	if err != nil {
		return nil, err
	}
	return crdt.DecodeStateVectorV1(sv)
}
