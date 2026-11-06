package protocol

import (
	"errors"
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
	// senders is the sender each editor's state last came from, so that a
	// frame can be told to be the host's (IsHost).
	senders map[uint64]Sender
}

// heardFrom records that an editor's state, of awareness client id, came
// from sender.
func (p *presence) heardFrom(id uint64, from Sender) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.senders == nil {
		p.senders = map[uint64]Sender{}
	}
	p.senders[id] = from
}

// editorSent tells whether from sent the state of editor id.
func (p *presence) editorSent(id uint64, from Sender) bool {
	p.mu.Lock()
	defer p.mu.Unlock()
	s, ok := p.senders[id]
	return ok && s == from && p.access[id] == AccessEdit
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
	delete(p.senders, id)
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

// isHost tells whether frames of from are the host's: from sent the state
// of an editor that says it is the host, as a guest finds the host. An
// editor could claim the role, but an edit link can rewrite everything
// anyway.
func (c *Client) isHost(from Sender) bool {
	for id, st := range c.aw.GetStates() {
		if role, _ := st.State["role"].(string); role == "host" && c.presence.editorSent(id, from) {
			return true
		}
	}
	return false
}

// ParseState reads an awareness update that holds one entry: the client
// ID, the clock and the state, which is JSON, "null" for a removal.
func ParseState(update []byte) (id, clock uint64, state []byte, err error) {
	e, err := decodeAwarenessEntry(update)
	return e.id, e.clock, e.state, err
}

// EncodeState is the awareness update of one client's state at a clock.
func EncodeState(id, clock uint64, state []byte) []byte {
	return awarenessEntry{id: id, clock: clock, state: state}.encode()
}

// SendStateAt sends an awareness update of one client, other than the
// Client's own, to the room as that client's own link would: signed for an
// editor, plain for a read link (signed.go). It is for a host that speaks
// for pages it does not run, such as an app's. A state is never sent above
// the access it is given, so peers take it for what it is: the frame says
// who may have written it, never the state.
//
// A plain frame is neither counted nor ordered by its receivers, and a read
// state's clock is its own: it must rise with each state, and stay within
// maxWireClock, or peers drop it. Only AccessEdit and AccessRead are
// allowed, and an editing Client alone may speak for an editor.
func (c *Client) SendStateAt(update []byte, access Access) error {
	e, err := decodeAwarenessEntry(update)
	if err != nil {
		return err
	}
	switch {
	case e.id == c.aw.ClientID():
		return errors.New("a state of this client is sent by the client itself")
	case access != AccessRead && access != AccessEdit:
		return fmt.Errorf("awareness cannot be sent at %s access", access)
	case access > c.keys.Access:
		return fmt.Errorf("a client with %s access cannot speak at %s access", c.keys.Access, access)
	case access == AccessRead && e.clock > maxWireClock:
		return errors.New("an awareness clock out of range for read access")
	}
	enc := encoding.NewEncoder()
	enc.WriteVarBytes(update)
	c.sendAt(access, MessageAwareness, enc.Bytes())
	return nil
}
