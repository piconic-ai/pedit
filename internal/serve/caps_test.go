package serve

import (
	"errors"
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
	c.conn.Write(b)
}

// wantClosed waits for the server to end the connection with code and reason.
func (c *tclient) wantClosed(code websocket.StatusCode, reason string) {
	c.t.Helper()
	select {
	case <-c.done:
	case <-time.After(5 * time.Second):
		c.t.Fatal("the connection was not closed")
	}
	var ce closeErr
	if !errors.As(c.err, &ce) || ce.code != code || ce.reason != reason {
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
				r := dialAs(t, s, "read")
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
	e := dial(t, s)
	eventually(t, "the document", func() bool { return e.get() == "base\n" })
	e.raw(syncFrame([]byte{0x00}, []byte{0x82, 0x00}, insertUpdate("ok ")))
	eventually(t, "the edit in the file", func() bool {
		b, _ := os.ReadFile(file)
		return len(b) > len("base\n")
	})
}

func TestReaderReceivesDocumentAndAwarenessAndMaySendAwareness(t *testing.T) {
	s, _, _ := open(t, "hello\n")
	e := dial(t, s)
	e.setState(map[string]any{"name": "editor"})
	r := dialAs(t, s, "read")
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
		c := dial(t, s)
		c.raw(b)
		c.wantClosed(websocket.StatusUnsupportedData, "malformed frame")
	}
}

func TestAwarenessCaps(t *testing.T) {
	s, _, _ := open(t, "x\n")
	const reason = "too many awareness clients"
	t.Run("nine in a frame", func(t *testing.T) {
		c := dial(t, s)
		c.raw(awarenessIDsFrame(1, 2, 3, 4, 5, 6, 7, 8, 9))
		c.wantClosed(websocket.StatusPolicyViolation, reason)
	})
	t.Run("nine over two frames", func(t *testing.T) {
		c := dial(t, s)
		c.raw(awarenessIDsFrame(11, 12, 13, 14, 15))
		c.raw(awarenessIDsFrame(11, 16, 17, 18, 19))
		c.wantClosed(websocket.StatusPolicyViolation, reason)
	})
	t.Run("eight are fine and announcing again is not counted twice", func(t *testing.T) {
		c := dial(t, s)
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
			c := dial(t, s)
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
		late := dial(t, s)
		late.raw(awarenessIDsFrame(5000))
		late.wantClosed(websocket.StatusPolicyViolation, reason)
	})
}

func TestEchoedAwarenessIsNotTheEchoersOwn(t *testing.T) {
	s, _, _ := open(t, "x\n")
	a, b := dial(t, s), dial(t, s)
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
	b.conn.Close()
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
	c := dial(t, s)
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

func TestManyRemovalsDoNotHideLaterPresence(t *testing.T) {
	s, _, _ := open(t, "x\n")
	spam := dial(t, s)
	for batch := range 6 {
		u := encoding.NewEncoder()
		u.WriteVarUint(50)
		for i := range 50 {
			u.WriteVarUint(uint64(10000 + batch*50 + i))
			u.WriteVarUint(1)
			u.WriteVarString("null")
		}
		enc := encoding.NewEncoder()
		enc.WriteVarBytes(u.Bytes())
		spam.raw(frame(msgAwareness, enc.Bytes()))
	}
	time.Sleep(100 * time.Millisecond)
	a, b := dial(t, s), dial(t, s)
	a.setState(map[string]any{"name": "a"})
	eventually(t, "a's presence for b", func() bool {
		b.mu.Lock()
		defer b.mu.Unlock()
		_, ok := b.aw.GetStates()[a.aw.ClientID()]
		return ok
	})
	late := dial(t, s)
	eventually(t, "a's presence for a late client", func() bool {
		late.mu.Lock()
		defer late.mu.Unlock()
		_, ok := late.aw.GetStates()[a.aw.ClientID()]
		return ok
	})
}

func TestConnectionCannotIntroduceMoreThanTheLifetimeCap(t *testing.T) {
	s, _, _ := open(t, "x\n")
	spam := dial(t, s)
	for batch := range 25 { // 25 * 50 = 1250 > 1024
		u := encoding.NewEncoder()
		u.WriteVarUint(50)
		for i := range 50 {
			u.WriteVarUint(uint64(20000 + batch*50 + i))
			u.WriteVarUint(1)
			u.WriteVarString("null")
		}
		enc := encoding.NewEncoder()
		enc.WriteVarBytes(u.Bytes())
		spam.raw(frame(msgAwareness, enc.Bytes()))
	}
	spam.wantClosed(websocket.StatusPolicyViolation, "too many awareness clients")
	a, b := dial(t, s), dial(t, s)
	a.setState(map[string]any{"name": "a"})
	eventually(t, "a's presence for b", func() bool {
		b.mu.Lock()
		defer b.mu.Unlock()
		_, ok := b.aw.GetStates()[a.aw.ClientID()]
		return ok
	})
}

func TestRateLimits(t *testing.T) {
	s, _, _ := openWith(t, "x\n", func(o *Options) { o.FrameRate = 50 })
	t.Run("sync step 1", func(t *testing.T) {
		c := dial(t, s)
		for range 20 {
			c.send(msgSync, ysync.EncodeSyncStep1(crdt.New()))
		}
		c.wantClosed(websocket.StatusPolicyViolation, "too many sync requests")
	})
	t.Run("frames", func(t *testing.T) {
		c := dial(t, s)
		for range 500 {
			c.raw([]byte{0x07})
		}
		c.wantClosed(websocket.StatusPolicyViolation, "too many frames")
	})
	t.Run("the server keeps serving", func(t *testing.T) {
		c := dial(t, s)
		eventually(t, "the document", func() bool { return c.get() == "x\n" })
	})
}
