// Package prototest provides an in-memory stand-in for the Worker.
package prototest

import (
	"context"
	"errors"
	"net/http"
	"sync"

	"github.com/piconic-ai/pedit/internal/protocol"
)

// Relay relays every frame to all other connections.
//
// With Hosted set it behaves like the real Room: a connection that sent an
// Authorization header is the host, guests are turned away while no host is
// connected, and everyone is disconnected with RoomClosed when the last host
// leaves. With Guests set, guests beyond that many are turned away with
// RoomFull.
//
// With Refuse set it turns every connection away with that close code, as the
// Room does on a protocol version mismatch.
//
// With MaxFrame set, a connection that writes a larger frame is closed with
// MessageTooBig and the frame is not relayed, as the Room does at
// protocol.MaxFrameBytes.
type Relay struct {
	Hosted bool
	Guests int
	Refuse int
	// Busy turns away this many connections with RelayBusy before letting any in.
	Busy int
	// MaxFrame is the most bytes a frame may have; 0 for no limit.
	MaxFrame int

	mu      sync.Mutex
	conns   map[*Conn]bool
	urls    []string
	headers []http.Header
	frames  [][]byte
}

func NewRelay(hosted bool) *Relay {
	return &Relay{Hosted: hosted, conns: map[*Conn]bool{}}
}

// Dial is a protocol.Dialer.
func (r *Relay) Dial(_ context.Context, url string, header http.Header) (protocol.Conn, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.urls = append(r.urls, url)
	r.headers = append(r.headers, header.Clone())
	if r.Busy > 0 {
		r.Busy--
		return nil, &protocol.CloseError{Code: protocol.RelayBusy}
	}
	if r.Refuse != 0 {
		return nil, &protocol.CloseError{Code: r.Refuse}
	}
	c := &Conn{relay: r, isHost: header.Get("Authorization") != "", wake: make(chan struct{}, 1)}
	if r.Hosted && !c.isHost && !r.hasHost() {
		return nil, &protocol.CloseError{Code: protocol.RoomClosed}
	}
	if !c.isHost && r.Guests > 0 && r.guests() >= r.Guests {
		return nil, &protocol.CloseError{Code: protocol.RoomFull}
	}
	r.conns[c] = true
	return c, nil
}

// SetRefuse changes Refuse while connections may be dialing, as a relay
// closing for maintenance and opening again would.
func (r *Relay) SetRefuse(code int) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.Refuse = code
}

// URLs returns the URLs dialed so far.
func (r *Relay) URLs() []string {
	r.mu.Lock()
	defer r.mu.Unlock()
	return append([]string{}, r.urls...)
}

// Headers returns the handshake headers sent so far.
func (r *Relay) Headers() []http.Header {
	r.mu.Lock()
	defer r.mu.Unlock()
	return append([]http.Header{}, r.headers...)
}

// Frames returns every frame relayed so far.
func (r *Relay) Frames() [][]byte {
	r.mu.Lock()
	defer r.mu.Unlock()
	return append([][]byte{}, r.frames...)
}

// DropAll cuts every connection, as a network failure would.
func (r *Relay) DropAll() {
	r.mu.Lock()
	defer r.mu.Unlock()
	for c := range r.conns {
		delete(r.conns, c)
		c.closeWith(1006)
	}
}

func (r *Relay) hasHost() bool {
	for c := range r.conns {
		if c.isHost {
			return true
		}
	}
	return false
}

func (r *Relay) guests() int {
	n := 0
	for c := range r.conns {
		if !c.isHost {
			n++
		}
	}
	return n
}

// left is called with r.mu held.
func (r *Relay) left(c *Conn) {
	delete(r.conns, c)
	if r.Hosted && c.isHost && !r.hasHost() {
		for peer := range r.conns {
			delete(r.conns, peer)
			peer.closeWith(protocol.RoomClosed)
		}
	}
}

// Conn is one side of an in-memory connection.
type Conn struct {
	relay  *Relay
	isHost bool

	mu     sync.Mutex
	inbox  [][]byte
	closed error
	wake   chan struct{}
}

func (c *Conn) Read(ctx context.Context) ([]byte, error) {
	for {
		c.mu.Lock()
		if len(c.inbox) > 0 {
			data := c.inbox[0]
			c.inbox = c.inbox[1:]
			c.mu.Unlock()
			return data, nil
		}
		closed := c.closed
		c.mu.Unlock()
		if closed != nil {
			return nil, closed
		}
		select {
		case <-c.wake:
		case <-ctx.Done():
			return nil, ctx.Err()
		}
	}
}

func (c *Conn) Write(_ context.Context, data []byte) error {
	r := c.relay
	r.mu.Lock()
	defer r.mu.Unlock()
	if !r.conns[c] {
		return errors.New("connection closed")
	}
	if r.MaxFrame > 0 && len(data) > r.MaxFrame {
		r.left(c)
		c.closeWith(protocol.MessageTooBig)
		return errors.New("message too big")
	}
	r.frames = append(r.frames, append([]byte{}, data...))
	for peer := range r.conns {
		if peer != c {
			peer.deliver(append([]byte{}, data...))
		}
	}
	return nil
}

func (c *Conn) Close() error {
	r := c.relay
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.conns[c] {
		r.left(c)
	}
	c.closeWith(1000)
	return nil
}

func (c *Conn) deliver(data []byte) {
	c.mu.Lock()
	c.inbox = append(c.inbox, data)
	c.mu.Unlock()
	c.signal()
}

func (c *Conn) closeWith(code int) {
	c.mu.Lock()
	if c.closed == nil {
		c.closed = &protocol.CloseError{Code: code}
	}
	c.mu.Unlock()
	c.signal()
}

func (c *Conn) signal() {
	select {
	case c.wake <- struct{}{}:
	default:
	}
}
