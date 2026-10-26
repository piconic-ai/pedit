package protocol

import (
	"fmt"
	"sync"
	"time"

	"github.com/reearth/ygo/encoding"
)

// Everyone in a room is listed among its participants, by the awareness
// state each peer sends of itself (#122). Peers below an editor must not be
// able to hide or change what others show of an editor, nor pass for one, so
// a Client applies a peer's awareness by these rules:
//
//   - A frame holds one entry. Nobody forwards another client's state, or
//     its removal: every peer times others out on its own.
//   - For each client ID, the Client remembers the highest access it heard
//     the ID's state with, for the session, and drops states for it from
//     below that. What a participant is shown as (editor, comment only, read
//     only), and the host's own fields (role, file, format, attachments),
//     follow from that access, never from the state.
//   - A signed state is applied at the next clock after the one the Client
//     holds, so a clock someone below claimed first does not hold it back;
//     signed frames come in order already (replayGuard). States from below
//     may not claim clocks past maxWireClock, so that next clock never runs
//     out.
//   - The Client follows at most maxUnsigned clients that sign nothing at
//     once, and forgets each when its state is gone, so ones that come and
//     go take no room. It sends its own state to newcomers at most every
//     announceEvery.
//   - When a client ID's access rises, how it is shown may change though its
//     state does not, so the Client says so (OnAccess).
//
// Keep in sync with packages/protocol/src/presence.ts.
const (
	maxWireClock  = 1 << 32
	maxUnsigned   = 64
	announceEvery = 2 * time.Second
)

// presence remembers the highest access each client ID spoke with.
type presence struct {
	mu     sync.Mutex
	access map[uint64]Access
}

// admit tells whether a state for id, from a peer with this access, may be
// applied, remembering the access when it is the highest yet. active tells
// whether the Client holds a state for id now, and unsigned counts the
// clients that sign nothing whose states it holds.
func (p *presence) admit(id uint64, access Access, active bool, unsigned int) bool {
	p.mu.Lock()
	defer p.mu.Unlock()
	seen, known := p.access[id]
	if known && access < seen {
		return false
	}
	if access == AccessRead && !active && unsigned >= maxUnsigned {
		return false
	}
	if p.access == nil {
		p.access = map[uint64]Access{}
	}
	if !known || access > seen {
		p.access[id] = access
	}
	return true
}

// forget forgets a client that signed nothing; access from above is kept for
// the session.
func (p *presence) forget(id uint64) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if a, ok := p.access[id]; ok && a == AccessRead {
		delete(p.access, id)
	}
}

func (p *presence) of(id uint64) (Access, bool) {
	p.mu.Lock()
	defer p.mu.Unlock()
	a, ok := p.access[id]
	return a, ok
}

// awarenessEntry is the one entry of an awareness update.
type awarenessEntry struct {
	id, clock uint64
	state     []byte
}

func decodeAwarenessEntry(update []byte) (awarenessEntry, error) {
	dec := encoding.NewDecoder(update)
	n, err := dec.ReadVarUint()
	if err != nil {
		return awarenessEntry{}, err
	}
	if n != 1 {
		return awarenessEntry{}, fmt.Errorf("awareness of %d clients in one frame", n)
	}
	var e awarenessEntry
	if e.id, err = dec.ReadVarUint(); err != nil {
		return awarenessEntry{}, err
	}
	if e.clock, err = dec.ReadVarUint(); err != nil {
		return awarenessEntry{}, err
	}
	if e.state, err = dec.ReadVarBytes(); err != nil {
		return awarenessEntry{}, err
	}
	if dec.HasContent() {
		return awarenessEntry{}, fmt.Errorf("trailing bytes after an awareness entry")
	}
	return e, nil
}

func (e awarenessEntry) encode() []byte {
	enc := encoding.NewEncoder()
	enc.WriteVarUint(1)
	enc.WriteVarUint(e.id)
	enc.WriteVarUint(e.clock)
	enc.WriteVarBytes(e.state)
	return enc.Bytes()
}

// AccessOf tells what access the peer with this awareness client ID has,
// from the frames its state came in, if the Client heard of it. The
// Client's own ID has its link's.
func (c *Client) AccessOf(id uint64) (Access, bool) {
	if id == c.aw.ClientID() {
		return c.keys.Access, true
	}
	return c.presence.of(id)
}

// unsignedStates counts the clients that sign nothing whose states the
// Client holds now.
func (c *Client) unsignedStates() int {
	n := 0
	for id := range c.aw.GetStates() {
		if a, ok := c.presence.of(id); ok && a == AccessRead {
			n++
		}
	}
	return n
}
