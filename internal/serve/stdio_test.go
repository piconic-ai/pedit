package serve

import (
	"bytes"
	"encoding/binary"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	ysync "github.com/reearth/ygo/sync"
)

// serveFrames feeds frames to a session and returns how Serve ended.
func serveFrames(t *testing.T, s *Server, in ...[]byte) error {
	t.Helper()
	st := NewStdio(&bytes.Buffer{})
	defer st.Close(time.Second)
	done := make(chan error, 1)
	go func() { done <- st.Serve(s, bytes.NewReader(bytes.Join(in, nil))) }()
	select {
	case err := <-done:
		return err
	case <-time.After(5 * time.Second):
		t.Fatal("Serve did not end")
		return nil
	}
}

func openRole(id uint32, role byte) []byte { return encodeFrame(kindOpen, id, []byte{role}) }

func TestFormatViolationsEndTheServer(t *testing.T) {
	s, _, _ := open(t, "x\n")
	big := make([]byte, headerLen)
	big[0] = kindData
	binary.BigEndian.PutUint32(big[1:], 1)
	binary.BigEndian.PutUint32(big[5:], maxPayload+1)
	var nine [][]byte
	for id := uint32(1); id <= maxStreams+1; id++ {
		nine = append(nine, openRole(id, 0))
	}
	cases := map[string][][]byte{
		"unknown kind":        {encodeFrame(9, 1, nil)},
		"kind zero":           {encodeFrame(0, 0, nil)},
		"event from the app":  {encodeFrame(kindEvent, 0, []byte("{}"))},
		"too long":            {big},
		"cut short header":    {{kindData, 0}},
		"cut short payload":   {encodeFrame(kindData, 1, []byte("abc"))[:11]},
		"open id zero":        {openRole(0, 0)},
		"open id repeated":    {openRole(1, 0), openRole(1, 0)},
		"open id lower":       {openRole(5, 0), openRole(3, 0)},
		"role changed":        {openRole(1, 1), openRole(1, 0)},
		"bad role":            {openRole(1, 7)},
		"a path in an open":   {encodeFrame(kindOpen, 1, []byte("/etc/passwd"))},
		"nine streams":        nine,
		"data never opened":   {encodeFrame(kindData, 4, []byte{0})},
		"close never opened":  {encodeFrame(kindClose, 4, nil)},
		"data on stream zero": {encodeFrame(kindData, 0, nil)},
		"close with payload":  {openRole(1, 0), encodeFrame(kindClose, 1, []byte{1})},
		"open with 2 bytes":   {encodeFrame(kindOpen, 1, []byte{0, 0})},
		"open with none":      {encodeFrame(kindOpen, 1, nil)},
	}
	for name, frames := range cases {
		t.Run(name, func(t *testing.T) {
			if err := serveFrames(t, s, frames...); err == nil {
				t.Fatal("Serve accepted it")
			}
		})
	}
	if err := serveFrames(t, s, openRole(1, 0), encodeFrame(kindClose, 1, nil)); err != nil {
		t.Fatalf("a clean session ended with %v", err)
	}
}

func TestDataAfterPeditClosedTheStreamIsIgnored(t *testing.T) {
	s, _, _ := open(t, "x\n")
	c := dial(t, s)
	c.send(msgSync, []byte{2, 5, 1, 2})
	c.wantClosed(1003, "malformed frame")
	// The app sent these before it saw the close.
	c.conn.frame(kindData, 1, []byte{0})
	c.conn.frame(kindClose, 1, nil)
	// A spent id is not reused.
	c.conn.frame(kindOpen, 1, []byte{0})
	select {
	case err := <-c.conn.served:
		if err == nil {
			t.Fatal("reopening a spent id was accepted")
		}
	case <-time.After(5 * time.Second):
		t.Fatal("the server did not end")
	}
}

// A stream's role comes from its open frame alone, and no frame names a file.
func TestRoleIsFixedAndNoFrameOpensAFile(t *testing.T) {
	s, file, _ := open(t, "x\n")
	other := filepath.Join(filepath.Dir(file), "other.md")
	r := dialAs(t, s, "read")
	r.raw(frame(msgSync, ysync.EncodeUpdate(insertUpdate("nope"))))
	r.wantClosed(4003, "read-only connection")
	c := dial(t, s)
	c.conn.frame(kindOpen, 2, []byte(other))
	if err := <-c.conn.served; err == nil {
		t.Fatal("an open naming a path was accepted")
	}
	if _, err := os.Stat(other); !os.IsNotExist(err) {
		t.Fatalf("a file appeared: %v", err)
	}
}

// A frame that cannot be valid is refused from its header, before its payload
// is read: the payload never arrives here.
func TestBadHeaderIsRefusedBeforeThePayload(t *testing.T) {
	s, _, _ := open(t, "x\n")
	for name, h := range map[string]header{
		"open of 2":  {kindOpen, 1, 2},
		"close of 1": {kindClose, 1, 1},
		"kind 7":     {7, 1, 5},
	} {
		b := make([]byte, headerLen)
		b[0] = h.kind
		binary.BigEndian.PutUint32(b[1:], h.stream)
		binary.BigEndian.PutUint32(b[5:], h.length)
		err := serveFrames(t, s, b)
		if err == nil || strings.Contains(err.Error(), "cut short") {
			t.Errorf("%s: %v", name, err)
		}
	}
}

// Once pedit closes a stream its slot is free: the app may open the next at
// once, on seeing the close, with seven others still open.
func TestSlotIsFreeWhenTheAppSeesTheClose(t *testing.T) {
	s, _, _ := open(t, "x\n")
	for range 20 {
		c := pipeTo(t, s)
		c.frame(kindOpen, 1, []byte{1}) // a reader: an update closes it with 4003
		for id := uint32(2); id <= maxStreams; id++ {
			c.frame(kindOpen, id, []byte{0})
		}
		c.frame(kindData, 1, frame(msgSync, ysync.EncodeUpdate(insertUpdate("no"))))
		for {
			kind, id, _, err := readFrame(c.out)
			if err != nil {
				t.Fatal(err)
			}
			if kind == kindClose && id == 1 {
				break
			}
		}
		c.frame(kindOpen, 9, []byte{0})
		_ = c.in.Close()
		select {
		case err := <-c.served:
			if err != nil {
				t.Fatalf("the open after a close was refused: %v", err)
			}
		case <-time.After(5 * time.Second):
			t.Fatal("Serve did not end")
		}
	}
}

// pipeUnread is a stdio session whose stdout nobody reads.
func pipeUnread(t *testing.T, s *Server) (*Stdio, *io.PipeWriter, chan error) {
	t.Helper()
	inR, inW := io.Pipe()
	_, outW := io.Pipe()
	st := NewStdio(outW)
	served := make(chan error, 1)
	go func() { served <- st.Serve(s, inR) }()
	t.Cleanup(func() { _ = inW.Close(); _ = outW.Close() })
	return st, inW, served
}

func TestShutdownDoesNotWaitForAParentThatStoppedReading(t *testing.T) {
	big := strings.Repeat("0123456789abcdef\n", 64<<10) // 1 MiB
	s, file, _ := open(t, big)
	st, in, _ := pipeUnread(t, s)
	_, _ = in.Write(openRole(1, 0))
	eventually(t, "the stream", func() bool {
		s.mu.Lock()
		defer s.mu.Unlock()
		return len(s.clients) == 1
	})
	other := dial(t, s)
	eventually(t, "the document", func() bool { return len(other.get()) == len(big) })
	other.insert(0, "edit:")
	done := make(chan error, 1)
	go func() { done <- s.Close() }()
	select {
	case err := <-done:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("Close waited for stdout")
	}
	if got, _ := os.ReadFile(file); !strings.HasPrefix(string(got), "edit:") {
		t.Fatal("the last edit was not written")
	}
	closed := make(chan struct{})
	go func() { st.Close(100 * time.Millisecond); close(closed) }()
	select {
	case <-closed:
	case <-time.After(5 * time.Second):
		t.Fatal("Stdio.Close waited for stdout")
	}
}

func TestAppCloseDoesNotHoldUpTheReadLoop(t *testing.T) {
	big := strings.Repeat("0123456789abcdef\n", 64<<10)
	s, _, _ := open(t, big)
	_, in, _ := pipeUnread(t, s)
	_, _ = in.Write(openRole(1, 0))
	eventually(t, "the stream", func() bool {
		s.mu.Lock()
		defer s.mu.Unlock()
		return len(s.clients) == 1
	})
	// Stream 1 has messages queued that stdout will never take.
	_, _ = in.Write(encodeFrame(kindClose, 1, nil))
	_, _ = in.Write(openRole(2, 0))
	eventually(t, "the second stream, the first gone", func() bool {
		s.mu.Lock()
		defer s.mu.Unlock()
		for c := range s.clients {
			if c.conn.(*stream).id != 2 {
				return false
			}
		}
		return len(s.clients) == 1
	})
}
