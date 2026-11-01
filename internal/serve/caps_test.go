package serve

import (
	"bufio"
	"context"
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/reearth/ygo/crdt"
	"github.com/reearth/ygo/encoding"
	ysync "github.com/reearth/ygo/sync"
)

// raw sends bytes as one frame, as they are.
func (c *tclient) raw(b []byte) {
	_ = c.conn.Write(context.Background(), websocket.MessageBinary, b)
}

// wantClosed waits for the server to end the connection with code and reason.
func (c *tclient) wantClosed(code websocket.StatusCode, reason string) {
	c.t.Helper()
	select {
	case <-c.done:
	case <-time.After(5 * time.Second):
		c.t.Fatal("the connection was not closed")
	}
	var ce websocket.CloseError
	if !errors.As(c.err, &ce) || ce.Code != code || ce.Reason != reason {
		c.t.Fatalf("closed with %v, want %d %q", c.err, code, reason)
	}
}

// insertUpdate is a Yjs update that inserts s at the start of the text.
func insertUpdate(s string) []byte {
	d := crdt.New()
	t := d.GetText("content")
	var u []byte
	d.OnUpdate(func(b []byte, _ any) { u = b })
	d.Transact(func(txn *crdt.Transaction) { t.Insert(txn, 0, s, nil) })
	return u
}

// syncFrame is a sync message whose type bytes are written as given.
func syncFrame(typ, sub []byte, update []byte) []byte {
	enc := encoding.NewEncoder()
	enc.WriteVarBytes(update)
	return append(append(append([]byte{}, typ...), sub...), enc.Bytes()...)
}

func awarenessIDsFrame(ids ...uint64) []byte {
	u := encoding.NewEncoder()
	u.WriteVarUint(uint64(len(ids)))
	for _, id := range ids {
		u.WriteVarUint(id)
		u.WriteVarUint(1)
		u.WriteVarString(`{"n":1}`)
	}
	enc := encoding.NewEncoder()
	enc.WriteVarBytes(u.Bytes())
	return frame(msgAwareness, enc.Bytes())
}

func TestReaderUpdatesCloseBeforeAnythingIsApplied(t *testing.T) {
	for name, sub := range map[string][]byte{
		"step 2 as 0x81 0x00": {0x81, 0x00},
		"update as 0x82 0x00": {0x82, 0x00},
		"step 2":              {0x01},
		"update":              {0x02},
	} {
		t.Run(name, func(t *testing.T) {
			s, file, _ := open(t, "base\n")
			for _, typ := range [][]byte{{0x00}, {0x80, 0x00}} {
				r := dialAs(t, s.SocketPath(), "read")
				eventually(t, "the document", func() bool { return r.get() == "base\n" })
				r.raw(syncFrame(typ, sub, insertUpdate("evil")))
				r.wantClosed(4003, "read-only connection")
			}
			time.Sleep(100 * time.Millisecond)
			if got := s.render(); got != "base\n" {
				t.Fatalf("document = %q", got)
			}
			if !fileIs(t, file, "base\n")() {
				t.Fatal("the file changed")
			}
		})
	}
}

func TestEditorOverlongUpdateIsApplied(t *testing.T) {
	s, file, _ := open(t, "base\n")
	e := dial(t, s.SocketPath())
	eventually(t, "the document", func() bool { return e.get() == "base\n" })
	e.raw(syncFrame([]byte{0x00}, []byte{0x82, 0x00}, insertUpdate("ok ")))
	eventually(t, "the edit in the file", func() bool {
		b, _ := os.ReadFile(file)
		return len(b) > len("base\n")
	})
}

func TestReaderReceivesDocumentAndAwarenessAndMaySendAwareness(t *testing.T) {
	s, _, _ := open(t, "hello\n")
	e := dial(t, s.SocketPath())
	e.setState(map[string]any{"name": "editor"})
	r := dialAs(t, s.SocketPath(), "read")
	eventually(t, "the document", func() bool { return r.get() == "hello\n" })
	eventually(t, "the editor's awareness", func() bool {
		r.mu.Lock()
		defer r.mu.Unlock()
		return len(r.aw.GetStates()) > 0
	})
	r.setState(map[string]any{"name": "reader"})
	eventually(t, "the reader's awareness", func() bool {
		e.mu.Lock()
		defer e.mu.Unlock()
		_, ok := e.aw.GetStates()[r.aw.ClientID()]
		return ok
	})
	select {
	case <-r.done:
		t.Fatal("the reader was closed")
	default:
	}
}

func TestMalformedFrameClosesWith1003(t *testing.T) {
	s, _, _ := open(t, "x\n")
	for _, b := range [][]byte{{0x80}, {}, {0x00, 0x80}, {0x00, 0x00}, {0x00, 0x02, 0x01, 0xff}, {0x01, 0x01, 0xff}} {
		c := dial(t, s.SocketPath())
		c.raw(b)
		c.wantClosed(websocket.StatusUnsupportedData, "malformed frame")
	}
}

func TestAwarenessCaps(t *testing.T) {
	s, _, _ := open(t, "x\n")
	const reason = "too many awareness clients"
	t.Run("nine in a frame", func(t *testing.T) {
		c := dial(t, s.SocketPath())
		c.raw(awarenessIDsFrame(1, 2, 3, 4, 5, 6, 7, 8, 9))
		c.wantClosed(websocket.StatusPolicyViolation, reason)
	})
	t.Run("nine over two frames", func(t *testing.T) {
		c := dial(t, s.SocketPath())
		c.raw(awarenessIDsFrame(11, 12, 13, 14, 15))
		c.raw(awarenessIDsFrame(11, 16, 17, 18, 19))
		c.wantClosed(websocket.StatusPolicyViolation, reason)
	})
	t.Run("eight are fine and announcing again is not counted twice", func(t *testing.T) {
		c := dial(t, s.SocketPath())
		c.raw(awarenessIDsFrame(21, 22, 23, 24, 25, 26, 27, 28))
		c.raw(awarenessIDsFrame(21, 22))
		time.Sleep(100 * time.Millisecond)
		select {
		case <-c.done:
			t.Fatal("closed")
		default:
		}
	})
	t.Run("the room holds sixty-four", func(t *testing.T) {
		s, _, _ := open(t, "x\n")
		for i := range 8 {
			c := dial(t, s.SocketPath())
			var ids []uint64
			for j := range 8 {
				ids = append(ids, uint64(1000+i*10+j))
			}
			c.raw(awarenessIDsFrame(ids...))
		}
		eventually(t, "sixty-four ids", func() bool {
			s.mu.Lock()
			defer s.mu.Unlock()
			n := 0
			for c := range s.clients {
				n += len(c.ids)
			}
			return n == 64
		})
		late := dial(t, s.SocketPath())
		late.raw(awarenessIDsFrame(5000))
		late.wantClosed(websocket.StatusPolicyViolation, reason)
	})
}

func TestEchoedAwarenessIsNotTheEchoersOwn(t *testing.T) {
	s, _, _ := open(t, "x\n")
	a, b := dial(t, s.SocketPath()), dial(t, s.SocketPath())
	var all []uint64
	for i := range 16 {
		all = append(all, uint64(100+i))
	}
	a.raw(awarenessIDsFrame(all[:8]...))
	b.raw(awarenessIDsFrame(all[8:]...))
	eventually(t, "sixteen ids", func() bool {
		s.mu.Lock()
		defer s.mu.Unlock()
		return len(s.aw.GetStates()) >= 16
	})
	// b echoes what it was told, as y-websocket does: all of it in one frame.
	b.raw(awarenessIDsFrame(all...))
	time.Sleep(100 * time.Millisecond)
	select {
	case <-b.done:
		t.Fatal("the echoing connection was closed")
	default:
	}
	_ = b.conn.Close(websocket.StatusNormalClosure, "")
	<-b.done
	time.Sleep(100 * time.Millisecond)
	s.mu.Lock()
	_, present := s.aw.GetStates()[all[0]]
	s.mu.Unlock()
	if !present {
		t.Fatal("an echo made b own a's awareness client")
	}
}

func TestRemovedIDsCannotBeBroughtBackPastTheCaps(t *testing.T) {
	s, _, _ := open(t, "x\n")
	c := dial(t, s.SocketPath())
	// Twelve removals, then bringing them back at a higher clock.
	entries := func(clock uint64, state string, ids ...uint64) []byte {
		u := encoding.NewEncoder()
		u.WriteVarUint(uint64(len(ids)))
		for _, id := range ids {
			u.WriteVarUint(id)
			u.WriteVarUint(clock)
			u.WriteVarString(state)
		}
		enc := encoding.NewEncoder()
		enc.WriteVarBytes(u.Bytes())
		return frame(msgAwareness, enc.Bytes())
	}
	c.raw(entries(1, "null", 1, 2, 3, 4, 5, 6, 7, 8))
	c.raw(entries(1, "null", 9, 10, 11, 12))
	c.raw(entries(2, `{"n":1}`, 1, 2, 3, 4, 5, 6, 7, 8))
	c.raw(entries(2, `{"n":1}`, 9, 10, 11, 12))
	c.wantClosed(websocket.StatusPolicyViolation, "too many awareness clients")
}

func TestRateLimits(t *testing.T) {
	s, _, _ := openWith(t, "x\n", func(o *Options) { o.FrameRate = 50 })
	t.Run("sync step 1", func(t *testing.T) {
		c := dial(t, s.SocketPath())
		for range 20 {
			c.send(msgSync, ysync.EncodeSyncStep1(crdt.New()))
		}
		c.wantClosed(websocket.StatusPolicyViolation, "too many sync requests")
	})
	t.Run("frames", func(t *testing.T) {
		c := dial(t, s.SocketPath())
		for range 500 {
			c.raw([]byte{0x07})
		}
		c.wantClosed(websocket.StatusPolicyViolation, "too many frames")
	})
	t.Run("text frames", func(t *testing.T) {
		c := dial(t, s.SocketPath())
		for range 500 {
			_ = c.conn.Write(context.Background(), websocket.MessageText, []byte("hi"))
		}
		c.wantClosed(websocket.StatusPolicyViolation, "too many frames")
	})
	t.Run("the server keeps serving", func(t *testing.T) {
		c := dial(t, s.SocketPath())
		eventually(t, "the document", func() bool { return c.get() == "x\n" })
	})
}

func TestIdleConnectionStaysWhilePongsAnswerAndGoesWhenTheyStop(t *testing.T) {
	s, _, _ := openWith(t, "x\n", func(o *Options) { o.PingInterval = 40 * time.Millisecond })
	live := dial(t, s.SocketPath())
	dead, err := net.Dial("unix", s.SocketPath())
	if err != nil {
		t.Fatal(err)
	}
	defer dead.Close()
	// A handshake by hand, and then never a pong.
	fmt.Fprint(dead, "GET /room HTTP/1.1\r\nHost: pedit\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n"+
		"Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n")
	br := bufio.NewReader(dead)
	_ = dead.SetReadDeadline(time.Now().Add(5 * time.Second))
	for {
		line, err := br.ReadString('\n')
		if err != nil {
			t.Fatal(err)
		}
		if line == "\r\n" {
			break
		}
	}
	pings := 0
	for {
		h := make([]byte, 2)
		if _, err := io.ReadFull(br, h); err != nil {
			t.Fatal(err)
		}
		body := make([]byte, h[1]&0x7f)
		if _, err := io.ReadFull(br, body); err != nil {
			t.Fatal(err)
		}
		switch h[0] & 0x0f {
		case 0x9:
			pings++
		case 0x8:
			if len(body) < 2 || int(body[0])<<8|int(body[1]) != 1001 {
				t.Fatalf("close frame %x, want 1001", body)
			}
			if pings < 2 {
				t.Fatalf("closed after %d pings", pings)
			}
			select {
			case <-live.done:
				t.Fatal("the connection that answers was closed")
			default:
			}
			return
		}
	}
}
