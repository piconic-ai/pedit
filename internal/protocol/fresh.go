package protocol

import (
	"crypto/rand"
	"errors"
	"sync"
	"time"
)

// Anyone with a read link decrypts every frame, so they could keep a signed
// frame and have it sent again later. The replay guard (message.go) drops it
// for peers that saw the sender's later frames, but a peer that has just
// joined has seen none, and would take it as new. So a Client takes signed
// frames from a sender only once the sender showed it is live (#122):
//
//   - On every connection the Client picks a random nonce and sends it in a
//     fresh message, before anything else.
//   - A Client answers every nonce it has not answered yet with a fresh
//     message of its own carrying the nonce, numbered after everything it
//     sent before. A signer's answer shows it is live; any answer also
//     carries the Client's own nonce, so a peer that came later answers it
//     in turn.
//   - Until a signer's answer to the Client's own nonce of this connection
//     arrives, the Client takes that signer's frames as a reader's (requests
//     only), and drops its awareness. The answer's counter then becomes the
//     floor of the replay guard for the signer: what it sent before seeing
//     the nonce is dropped, as anything kept from before would be. This
//     holds on every connection, a reconnection too: what a signer sent
//     while the Client was away could be kept and sent again.
//   - A peer drops what the Client sent until the Client answers its nonce.
//     So after each answer the Client sends its awareness again. Its state,
//     a peer asks for after the answer, unless the peer was in the room
//     before the Client (its answer carried the Client's nonce) and the
//     Client sent content of its own since connecting, or the Client sent
//     content of its own shortly before the nonce reached it, which may have
//     been after the peer connected: then the Client sends its state again
//     too. Both at most every resendEvery. Only content of its own counts
//     (edits, and a state with something in it pushed on connecting or
//     adding a file): a state the peer has already still makes an update
//     there.
//
//   - What the Client sends once rather than as state (attachments and
//     canvas messages) is not sent again. So a Client that signs holds it
//     after connecting until it settles: resendEvery after the last answer
//     from a peer that was in the room before it, or settleAfter if none
//     answers. Then it sends what it held, in order.
//
// Peers that stay connected answer each other once; a newcomer gets one
// answer from each signer before their answers to its requests.
//
// Keep in sync with packages/protocol/src/fresh.ts.

// MessageFresh asks peers to show they are live, and answers a peer's asking
// (fresh.go). Type 5 marks a signed message (signed.go).
const MessageFresh MessageType = 6

// NonceBytes is the size of a connection's nonce.
const NonceBytes = 16

// Nonce is what a Client asks its peers to answer, new on every connection.
type Nonce [NonceBytes]byte

const (
	// maxAnswered bounds the nonces a Client remembers having answered.
	maxAnswered = 1024
	// resendEvery spaces out the state the Client sends again after
	// answering: long enough to cover the answers of everyone in the room
	// to its connecting, short enough not to keep them waiting.
	resendEvery = 250 * time.Millisecond
	// stateWindow is how long before a nonce reached the Client the content
	// it sent may have reached the nonce's peer after it connected.
	stateWindow = 5 * time.Second
	// settleAfter is how long a Client that hears no answer after
	// connecting holds what it sends once: alone in the room, nobody drops it.
	settleAfter = time.Second
)

// FreshMessage is a fresh message: the sender's nonce of its connection,
// and the nonce of the peer it answers, if any.
type FreshMessage struct {
	Nonce  Nonce
	Answer *Nonce
}

// EncodeFresh encodes a fresh message's payload: the nonce, then the answer.
func EncodeFresh(m FreshMessage) []byte {
	out := append([]byte(nil), m.Nonce[:]...)
	if m.Answer != nil {
		out = append(out, m.Answer[:]...)
	}
	return out
}

// DecodeFresh reverses EncodeFresh.
func DecodeFresh(payload []byte) (FreshMessage, error) {
	var m FreshMessage
	switch len(payload) {
	case NonceBytes:
	case 2 * NonceBytes:
		var answer Nonce
		copy(answer[:], payload[NonceBytes:])
		m.Answer = &answer
	default:
		return m, errors.New("malformed fresh message")
	}
	copy(m.Nonce[:], payload)
	return m, nil
}

// freshness keeps a Client's side of the handshake.
type freshness struct {
	mu       sync.Mutex
	nonce    Nonce
	answered map[Nonce]bool
	order    []Nonce
	// When the Client last sent content of its own, whether it did since
	// connecting, when it last sent its state again for peers that dropped
	// it, and the timer that sends it again.
	wroteAt     time.Time
	wroteSince  bool
	resentAt    time.Time
	resendTimer *time.Timer
	resendState bool

	// heldMu guards what the Client holds until it settles, and keeps it in
	// order with what it sends after.
	heldMu      sync.Mutex
	settled     bool
	held        []heldMessage
	settleTimer *time.Timer
}

// heldMessage is a message the Client sends once it settles.
type heldMessage struct {
	t       MessageType
	payload []byte
}

// wrote notes that the Client sent content of its own.
func (f *freshness) wrote() {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.wroteAt = time.Now()
	f.wroteSince = true
}

// connected starts counting what the Client sends on a new connection.
func (f *freshness) connected() {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.wroteSince = false
}

// hasToResend tells whether the Client sent content of its own a peer
// whose nonce it answers may have dropped: lately, or since connecting if
// the peer was in the room before it.
func (f *freshness) hasToResend(peerWasFirst bool) bool {
	f.mu.Lock()
	defer f.mu.Unlock()
	return time.Since(f.wroteAt) < stateWindow || peerWasFirst && f.wroteSince
}

// renew picks the nonce of a new connection.
func (f *freshness) renew() Nonce {
	f.mu.Lock()
	defer f.mu.Unlock()
	_, _ = rand.Read(f.nonce[:]) // never fails
	return f.nonce
}

// current is the nonce of the Client's connection.
func (f *freshness) current() Nonce {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.nonce
}

// toAnswer tells whether n is yet to be answered, and counts it answered.
func (f *freshness) toAnswer(n Nonce) bool {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.answered[n] {
		return false
	}
	if f.answered == nil {
		f.answered = map[Nonce]bool{}
	}
	if len(f.order) == maxAnswered {
		delete(f.answered, f.order[0])
		f.order = f.order[1:]
	}
	f.answered[n] = true
	f.order = append(f.order, n)
	return true
}

// sendFresh asks the room to show it is live, with a new nonce for this
// connection.
func (c *Client) sendFresh() {
	c.send(MessageFresh, EncodeFresh(FreshMessage{Nonce: c.fresh.renew()}))
}

// receiveFresh takes a fresh message: an answer to the Client's nonce shows
// its signer is live, and a nonce not answered yet gets an answer.
func (c *Client) receiveFresh(access Access, vouched bool, from Sender, counter uint64, payload []byte) error {
	m, err := DecodeFresh(payload)
	if err != nil {
		return err
	}
	answersMe := m.Answer != nil && *m.Answer == c.fresh.current()
	if answersMe && access != AccessRead && !vouched {
		c.guard.vouch(access, from, counter)
	}
	if !c.fresh.toAnswer(m.Nonce) {
		return nil
	}
	state := c.fresh.hasToResend(answersMe)
	c.send(MessageFresh, EncodeFresh(FreshMessage{Nonce: c.fresh.current(), Answer: &m.Nonce}))
	c.resend(state)
	if answersMe {
		c.settleIn(resendEvery)
	}
	return nil
}

// sendOnce sends what is sent once rather than as state: held until the
// Client settles, for a Client that signs.
func (c *Client) sendOnce(t MessageType, payload []byte) {
	f := &c.fresh
	f.heldMu.Lock()
	defer f.heldMu.Unlock()
	if !f.settled && c.keys.Signer != nil {
		f.held = append(f.held, heldMessage{t, payload})
		return
	}
	c.send(t, payload)
}

// settleIn has the Client settle after d, unless something puts it off.
func (c *Client) settleIn(d time.Duration) {
	f := &c.fresh
	f.heldMu.Lock()
	defer f.heldMu.Unlock()
	if f.settleTimer != nil {
		f.settleTimer.Stop()
	}
	f.settleTimer = time.AfterFunc(d, c.settle)
}

// unsettle holds what is sent once, on connecting, until the Client settles.
func (c *Client) unsettle() {
	c.fresh.heldMu.Lock()
	c.fresh.settled = false
	c.fresh.heldMu.Unlock()
	c.settleIn(settleAfter)
}

// settle sends what the Client held, in order.
func (c *Client) settle() {
	f := &c.fresh
	f.heldMu.Lock()
	defer f.heldMu.Unlock()
	f.settled = true
	for _, m := range f.held {
		c.send(m.t, m.payload)
	}
	f.held = nil
}

// resend sends again, at most every resendEvery, what a peer that did not
// know yet that this Client is live dropped: its awareness, and with state
// the Doc's state and that of each file the Client writes.
func (c *Client) resend(state bool) {
	f := &c.fresh
	f.mu.Lock()
	f.resendState = f.resendState || state
	if wait := time.Until(f.resentAt.Add(resendEvery)); wait > 0 {
		if f.resendTimer == nil {
			f.resendTimer = time.AfterFunc(wait, func() {
				f.mu.Lock()
				f.resendTimer = nil
				f.mu.Unlock()
				c.resend(false)
			})
		}
		f.mu.Unlock()
		return
	}
	f.resentAt = time.Now()
	state = f.resendState
	f.resendState = false
	f.mu.Unlock()
	if c.isDestroyed() {
		return
	}
	c.sendAwareness([]uint64{c.aw.ClientID()})
	if !state {
		return
	}
	if c.edits() {
		if step2 := syncStep2(c.doc); FrameBytes(len(step2)) <= MaxFrameBytes {
			c.send(MessageSync, step2)
		}
	}
	c.resendFiles()
}

// stop stops the timers of resend and settle.
func (f *freshness) stop() {
	f.mu.Lock()
	if f.resendTimer != nil {
		f.resendTimer.Stop()
		f.resendTimer = nil
	}
	f.mu.Unlock()
	f.heldMu.Lock()
	defer f.heldMu.Unlock()
	if f.settleTimer != nil {
		f.settleTimer.Stop()
	}
	f.held = nil
}
