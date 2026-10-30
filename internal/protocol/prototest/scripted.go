package prototest

import (
	"context"
	"errors"
	"net/http"
	"sync"

	"github.com/piconic-ai/pedit/internal/protocol"
)

// Scripted is a Dialer whose connections the test drives: it reads what the
// client writes and sends what the relay would. Its connections speak
// Subprotocol, "pedit-v6" unless set otherwise.
type Scripted struct {
	Subprotocol string
	// OnDial is called with each new connection before Dial returns it, to
	// queue what the relay sends first.
	OnDial func(*ScriptConn)
	// Refuse, when set, makes Dial fail with it.
	Refuse error

	mu    sync.Mutex
	conns []*ScriptConn
}

// ScriptConn is one connection of a Scripted dialer.
type ScriptConn struct {
	Header http.Header
	// Sent has every binary message the client wrote.
	Sent chan []byte

	version string
	mu      sync.Mutex
	inbox   []any // []byte or protocol.Signal
	wake    chan struct{}
	closed  error
	// Left is set when the client left as a host does on purpose.
	left bool
}

// Dial is a protocol.Dialer.
func (s *Scripted) Dial(_ context.Context, _ string, header http.Header) (protocol.Conn, error) {
	if s.Refuse != nil {
		return nil, s.Refuse
	}
	version := s.Subprotocol
	if version == "" {
		version = "pedit-v6"
	}
	c := &ScriptConn{Header: header.Clone(), Sent: make(chan []byte, 1024), version: version, wake: make(chan struct{}, 1)}
	if s.OnDial != nil {
		s.OnDial(c)
	}
	s.mu.Lock()
	s.conns = append(s.conns, c)
	s.mu.Unlock()
	return c, nil
}

// Conns lists the connections dialed so far.
func (s *Scripted) Conns() []*ScriptConn {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]*ScriptConn{}, s.conns...)
}

// Push queues a binary message from the relay.
func (c *ScriptConn) Push(data []byte) { c.queue(data) }

// Say queues a text message from the relay.
func (c *ScriptConn) Say(text string) { c.queue(protocol.Signal(text)) }

// CloseWith ends the connection as the relay would, with a close code.
func (c *ScriptConn) CloseWith(code int) {
	c.mu.Lock()
	c.closed = &protocol.CloseError{Code: code}
	c.mu.Unlock()
	c.signal()
}

// Left tells whether the client left on purpose.
func (c *ScriptConn) Left() bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.left
}

func (c *ScriptConn) queue(m any) {
	c.mu.Lock()
	c.inbox = append(c.inbox, m)
	c.mu.Unlock()
	c.signal()
}

func (c *ScriptConn) signal() {
	select {
	case c.wake <- struct{}{}:
	default:
	}
}

func (c *ScriptConn) Subprotocol() string { return c.version }

func (c *ScriptConn) Read(ctx context.Context) ([]byte, error) {
	for {
		c.mu.Lock()
		if len(c.inbox) > 0 {
			m := c.inbox[0]
			c.inbox = c.inbox[1:]
			c.mu.Unlock()
			if sig, ok := m.(protocol.Signal); ok {
				return nil, sig
			}
			return m.([]byte), nil
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

func (c *ScriptConn) Write(_ context.Context, data []byte) error {
	c.mu.Lock()
	closed := c.closed
	c.mu.Unlock()
	if closed != nil {
		return errors.New("connection closed")
	}
	c.Sent <- append([]byte{}, data...)
	return nil
}

func (c *ScriptConn) Close() error {
	c.mu.Lock()
	if c.closed == nil {
		c.closed = &protocol.CloseError{Code: 1000}
	}
	c.mu.Unlock()
	c.signal()
	return nil
}

func (c *ScriptConn) Leave() error {
	c.mu.Lock()
	c.left = true
	c.mu.Unlock()
	return c.Close()
}
