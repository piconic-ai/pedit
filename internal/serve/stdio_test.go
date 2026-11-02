package serve

import (
	"bytes"
	"encoding/binary"
	"os"
	"path/filepath"
	"testing"
	"time"

	ysync "github.com/reearth/ygo/sync"
)

// serveFrames feeds frames to a session and returns how Serve ended.
func serveFrames(t *testing.T, s *Server, in ...[]byte) error {
	t.Helper()
	st := NewStdio(&bytes.Buffer{})
	defer st.Close()
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
