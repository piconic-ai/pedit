package serve

import (
	"errors"
	"fmt"
	"sync"

	"github.com/reearth/ygo/awareness"
	"github.com/reearth/ygo/crdt"
	"github.com/reearth/ygo/encoding"
)

var (
	errPeerClosed   = errors.New("serve: the peer is closed")
	errPeerAttached = errors.New("serve: a peer is already attached")
	errServerClosed = errors.New("serve: the server is closing")
)

// PeerHandler receives what changed in the server's doc and awareness. Its
// functions are called in order from one goroutine, never with the server's
// lock held, so they may call the peer's Apply on another goroutine. They must
// not call Close.
type PeerHandler struct {
	// Update receives each Yjs update (v1) applied to the doc by anyone but
	// the peer: browser streams, saves made by other editors.
	Update func(update []byte)
	// Awareness receives each awareness update (y-protocols encoding) applied
	// by anyone but the peer.
	Awareness func(update []byte)
}

// A Peer is an in-process client of the server's doc, for a room that keeps a
// doc of its own. Unlike a stream it is held to no rate, cap or queue limit,
// and it is never counted among the open streams.
type Peer struct {
	s *Server
	h PeerHandler
	// c holds the awareness client IDs the peer introduced, for leave.
	c   *client
	off func() // stops watching awareness
	// closed is guarded by s.mu.
	closed bool

	state, awState []byte

	// q is what the handler has yet to receive; unbounded, so nothing is
	// dropped and the server never waits for the handler.
	qmu  sync.Mutex
	q    []peerMsg
	stop bool
	wake chan struct{}
	done chan struct{} // closes when the delivery goroutine has returned
}

type peerMsg struct {
	update    []byte
	awareness bool
}

// AttachPeer takes in a peer. At most one is attached at a time.
func (s *Server) AttachPeer(h PeerHandler) (*Peer, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closing {
		return nil, errServerClosed
	}
	if s.peer != nil {
		return nil, errPeerAttached
	}
	p := &Peer{s: s, h: h, c: &client{ids: map[uint64]bool{}}, wake: make(chan struct{}, 1), done: make(chan struct{})}
	// The state and the registration are taken under one lock: no update falls
	// between them, and none comes twice.
	p.state = crdt.EncodeStateAsUpdateV1(s.doc, nil)
	var live []uint64
	for id, st := range s.aw.GetStates() {
		if st.State != nil {
			live = append(live, id)
		}
	}
	p.awState = s.aw.EncodeUpdate(live)
	p.off = s.aw.OnUpdate(func(ev awareness.UpdateEvent) {
		if ev.Origin == p {
			// The peer owns the IDs ygo accepted from it, as a stream does.
			for _, id := range append(append([]uint64{}, ev.Added...), ev.Updated...) {
				p.c.ids[id] = true
			}
			return
		}
		ids := append(append(append([]uint64{}, ev.Added...), ev.Updated...), ev.Removed...)
		p.push(peerMsg{update: s.aw.EncodeUpdate(ids), awareness: true})
	})
	s.peer = p
	go p.deliver()
	return p, nil
}

// State is the doc's whole state as one v1 update, as of when the peer was
// attached: every later update reaches Update.
func (p *Peer) State() []byte { return p.state }

// AwarenessState is every awareness state present when the peer was attached.
func (p *Peer) AwarenessState() []byte { return p.awState }

// Apply applies a Yjs update from the room: the streams get it and the file
// is written as for a browser's edit. Update does not receive it.
func (p *Peer) Apply(update []byte) (err error) {
	defer func() {
		// ygo can panic on a malformed update; it must not end the process.
		if r := recover(); r != nil {
			err = fmt.Errorf("serve: malformed update: %v", r)
		}
	}()
	p.s.mu.Lock()
	defer p.s.mu.Unlock()
	if p.closed {
		return errPeerClosed
	}
	return crdt.ApplyUpdateV1(p.s.doc, update, p)
}

// ApplyAwareness applies an awareness update from the room. The IDs it
// introduces are the peer's, and leave when it closes.
func (p *Peer) ApplyAwareness(update []byte) (err error) {
	defer func() {
		if r := recover(); r != nil {
			err = fmt.Errorf("serve: malformed awareness update: %v", r)
		}
	}()
	s := p.s
	s.mu.Lock()
	defer s.mu.Unlock()
	if p.closed {
		return errPeerClosed
	}
	if err := s.aw.ApplyUpdate(update, p); err != nil {
		return err
	}
	enc := encoding.NewEncoder()
	enc.WriteVarBytes(update)
	s.broadcast(frame(msgAwareness, enc.Bytes()), p)
	return nil
}

// Close detaches the peer and removes its awareness states from the streams'
// view. When it returns the handler is not running and is never called again.
// It may be called more than once, but not from the handler.
func (p *Peer) Close() {
	s := p.s
	s.mu.Lock()
	if !p.closed {
		p.closed = true
		p.off()
		s.peer = nil
		s.leave(p.c)
	}
	s.mu.Unlock()
	p.qmu.Lock()
	p.stop = true
	p.qmu.Unlock()
	select {
	case p.wake <- struct{}{}:
	default:
	}
	<-p.done
}

// push queues m for the handler.
func (p *Peer) push(m peerMsg) {
	p.qmu.Lock()
	p.q = append(p.q, m)
	p.qmu.Unlock()
	select {
	case p.wake <- struct{}{}:
	default:
	}
}

// deliver calls the handler for each queued message, in order.
func (p *Peer) deliver() {
	defer close(p.done)
	for {
		p.qmu.Lock()
		if p.stop {
			p.qmu.Unlock()
			return
		}
		if len(p.q) == 0 {
			p.qmu.Unlock()
			<-p.wake
			continue
		}
		m := p.q[0]
		p.q[0] = peerMsg{}
		p.q = p.q[1:]
		p.qmu.Unlock()
		if m.awareness {
			if p.h.Awareness != nil {
				p.h.Awareness(m.update)
			}
		} else if p.h.Update != nil {
			p.h.Update(m.update)
		}
	}
}
