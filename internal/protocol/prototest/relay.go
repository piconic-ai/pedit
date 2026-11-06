// Package prototest provides an in-memory stand-in for the Worker.
package prototest

import (
	"context"
	"encoding/binary"
	"errors"
	"fmt"
	"net/http"
	"strconv"
	"sync"
	"time"

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
// With Keep set (seconds) it speaks version 7 and keeps a room whose host asked
// for it (X-Pedit-Keep) when the host leaves on purpose: guests stay and edit
// as entries, which it logs, answers with their id, and replays to a guest
// that joins. It holds the host's last snapshot and does not relay snapshots.
// Without Keep it keeps nothing, as a relay before version 6.
//
// With Refuse set it turns every connection away with that close code, as the
// Room does on a protocol version mismatch.
//
// With MaxFrame set, a connection that writes a larger frame is closed with
// MessageTooBig and the frame is not relayed, as the Room does at
// protocol.MaxFrameBytes.
//
// With Bytes set, a connection that writes more than that allowance is closed
// with RateLimited and the frame is not relayed, as the Room does.
type Relay struct {
	Hosted bool
	Guests int
	Refuse int
	// RefuseReason is the close reason that goes with Refuse.
	RefuseReason string
	// Busy turns away this many connections with RelayBusy before letting any in.
	Busy int
	// Keep is the seconds the relay keeps a room after its host leaves.
	Keep int64
	// MaxFrame is the most bytes a frame may have; 0 for no limit.
	MaxFrame int
	// Bytes is what one connection may write; zero for no limit.
	Bytes protocol.Rate

	mu         sync.Mutex
	hostPaused bool
	hostAway   bool
	limited    int
	conns      map[*Conn]bool
	urls       []string
	headers    []http.Header
	frames     [][]byte
	// What a kept room holds: the host's snapshot and the entries logged.
	kept     bool
	until    int64
	snapshot []byte
	log      [][]byte
}

// keptSignal tells a guest the room is kept until the deadline.
func (r *Relay) keptSignal() protocol.Signal {
	return protocol.Signal(fmt.Sprintf("kept %d", r.until))
}

// Log returns the entries a kept room logged, oldest first.
func (r *Relay) Log() [][]byte {
	r.mu.Lock()
	defer r.mu.Unlock()
	return append([][]byte{}, r.log...)
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
		return nil, &protocol.CloseError{Code: r.Refuse, Reason: r.RefuseReason}
	}
	c := &Conn{relay: r, isHost: header.Get("Authorization") != "", wake: make(chan struct{}, 1)}
	if c.isHost && r.hostPaused {
		return nil, errors.New("host network offline")
	}
	if c.isHost && r.hostAway {
		r.signalGuests(protocol.HostBack)
		r.hostAway = false
	}
	if r.Hosted && !c.isHost && !r.hasHost() && !r.kept {
		return nil, &protocol.CloseError{Code: protocol.RoomClosed}
	}
	if !c.isHost && r.Guests > 0 && r.guests() >= r.Guests {
		return nil, &protocol.CloseError{Code: protocol.RoomFull}
	}
	if c.isHost && r.Keep > 0 && header.Get(protocol.KeepHeader) != "" {
		c.keeps = true
		c.signals = append(c.signals, protocol.Signal(fmt.Sprintf("keep %d 0", r.Keep)))
	}
	if r.kept && !c.isHost {
		c.signals = append(c.signals, r.keptSignal())
		c.inbox = append(c.inbox, protocol.WithKind(protocol.KindReplay, r.snapshot))
		for i, entry := range r.log {
			c.inbox = append(c.inbox, protocol.EncodeLogged(uint64(i+1), entry))
		}
		c.inbox = append(c.inbox, protocol.EncodeLogEnd(uint64(len(r.log))))
	}
	if r.kept && c.isHost && c.keeps {
		r.hostReturns(c, header.Get(protocol.AfterHeader))
	}
	r.conns[c] = true
	return c, nil
}

// hostReturns replays the log after the last entry the host holds, as the
// relay does for a host that comes back to a kept room, and has the room live
// again: guests are told, and their entries are relayed. The log is not cut by
// the host's checkpoint, which is harmless: a guest that joins applies entries
// the snapshot holds again. Called with r.mu held.
func (r *Relay) hostReturns(c *Conn, after string) {
	held, _ := strconv.ParseUint(after, 10, 64)
	for i, entry := range r.log {
		if id := uint64(i + 1); id > held {
			c.inbox = append(c.inbox, protocol.EncodeLogged(id, entry))
		}
	}
	c.inbox = append(c.inbox, protocol.EncodeLogEnd(uint64(len(r.log))))
	r.kept = false
	r.signalGuests(protocol.HostBack)
}

// Limited counts the connections closed for going over Bytes.
func (r *Relay) Limited() int {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.limited
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

// CloseAll closes every connection with code and reason, as the Room does at
// its time limit.
func (r *Relay) CloseAll(code int, reason string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	for c := range r.conns {
		delete(r.conns, c)
		c.closeWithReason(code, reason)
	}
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

// SeverAll forgets every connection without telling it, as a connection
// dropped without a close reaching us: writes fail and reads go on waiting.
func (r *Relay) SeverAll() {
	r.mu.Lock()
	defer r.mu.Unlock()
	for c := range r.conns {
		r.left(c)
	}
}

// Signal sends every guest a text frame of the relay's own, such as
// protocol.HostAway.
func (r *Relay) Signal(sig protocol.Signal) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.signalGuests(sig)
}

func (r *Relay) signalGuests(sig protocol.Signal) {
	for c := range r.conns {
		if c.isHost {
			continue
		}
		c.mu.Lock()
		c.signals = append(c.signals, sig)
		c.mu.Unlock()
		c.signal()
	}
}

// PauseHost cuts only the host's network while guests remain in the room's
// grace period. The returned function lets the same host reconnect.
func (r *Relay) PauseHost() func() {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.hostPaused = true
	r.hostAway = true
	for c := range r.conns {
		if c.isHost {
			delete(r.conns, c)
			c.closeWith(1006)
		}
	}
	r.signalGuests(protocol.HostAway)
	return func() {
		r.mu.Lock()
		defer r.mu.Unlock()
		r.hostPaused = false
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
	if c.keeps && c.leaving {
		r.kept = true
		r.until = time.Now().Add(time.Duration(r.Keep) * time.Second).UnixMilli()
		r.signalGuests(r.keptSignal())
		return
	}
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
	// keeps: the host asked the relay to keep the room. leaving: it is
	// leaving on purpose.
	keeps, leaving bool

	mu      sync.Mutex
	inbox   [][]byte
	signals []protocol.Signal
	closed  error
	wake    chan struct{}

	// The byte allowance under Relay.Bytes, and when it was counted. Guarded
	// by the relay's mu.
	bytes   float64
	counted time.Time
}

// RateLimited is the Room's close code for a connection over its rate.
const RateLimited = 1008

func (c *Conn) Read(ctx context.Context) ([]byte, error) {
	for {
		c.mu.Lock()
		if len(c.signals) > 0 {
			sig := c.signals[0]
			c.signals = c.signals[1:]
			c.mu.Unlock()
			return nil, sig
		}
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
	if rate := r.Bytes; rate != (protocol.Rate{}) {
		now := time.Now()
		if c.counted.IsZero() {
			c.bytes = rate.Burst
		} else {
			c.bytes = min(rate.Burst, c.bytes+now.Sub(c.counted).Seconds()*rate.PerSecond)
		}
		c.counted = now
		if c.bytes < float64(len(data)) {
			r.limited++
			r.left(c)
			c.closeWith(RateLimited)
			return errors.New("rate limited")
		}
		c.bytes -= float64(len(data))
	}
	r.frames = append(r.frames, append([]byte{}, data...))
	if r.Keep > 0 && len(data) > 0 {
		switch {
		case c.isHost && data[0] == protocol.KindSnapshot:
			r.snapshot = append([]byte{}, data[1:]...)
			return nil
		case c.isHost && data[0] == protocol.KindCheckpoint && len(data) > 8:
			r.snapshot = append([]byte{}, data[9:]...)
			c.mu.Lock()
			c.signals = append(c.signals, protocol.Signal(fmt.Sprintf("checkpoint %d %d", binary.BigEndian.Uint64(data[1:9]), len(r.log))))
			c.mu.Unlock()
			c.signal()
			return nil
		case !c.isHost && data[0] == protocol.KindEntry && r.kept:
			r.log = append(r.log, append([]byte{}, data[1:]...))
			c.deliver(protocol.EncodeLogged(uint64(len(r.log)), data[1:]))
			return nil
		}
	}
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

// Leave is Close as a host leaving on purpose.
func (c *Conn) Leave() error {
	c.relay.mu.Lock()
	c.leaving = true
	c.relay.mu.Unlock()
	return c.Close()
}

// Subprotocol is the version the relay speaks.
func (c *Conn) Subprotocol() string {
	if c.relay.Keep > 0 {
		return "pedit-v7"
	}
	return ""
}

func (c *Conn) deliver(data []byte) {
	c.mu.Lock()
	c.inbox = append(c.inbox, data)
	c.mu.Unlock()
	c.signal()
}

func (c *Conn) closeWith(code int) { c.closeWithReason(code, "") }

func (c *Conn) closeWithReason(code int, reason string) {
	c.mu.Lock()
	if c.closed == nil {
		c.closed = &protocol.CloseError{Code: code, Reason: reason}
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
