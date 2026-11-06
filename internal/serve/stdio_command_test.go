package serve

import (
	"bufio"
	"bytes"
	"io"
	"testing"
	"time"
)

func TestCommandFramesReachTheCallbackWhileAStreamExchangesData(t *testing.T) {
	s, _, _ := open(t, "x\n")
	inR, inW := io.Pipe()
	outR, outW := io.Pipe()
	st := NewStdio(outW)
	got := make(chan string, 4)
	st.OnCommand = func(p []byte) { got <- string(p) }
	served := make(chan error, 1)
	go func() {
		served <- st.Serve(s, inR)
		st.Close(time.Second)
		_ = outW.Close()
	}()
	t.Cleanup(func() { _ = inW.Close(); _ = outR.Close() })
	out := bufio.NewReader(outR)
	send := func(b []byte) {
		if _, err := inW.Write(b); err != nil {
			t.Fatal(err)
		}
	}
	command := func(want string) {
		t.Helper()
		select {
		case p := <-got:
			if p != want {
				t.Fatalf("got %s, want %s", p, want)
			}
		case <-time.After(5 * time.Second):
			t.Fatalf("no command %s", want)
		}
	}

	send(openRole(1, 0))
	send(encodeFrame(kindCmd, 0, []byte(`{"cmd":"a"}`)))
	command(`{"cmd":"a"}`)
	// A sync step 1: pedit answers on the stream.
	send(encodeFrame(kindData, 1, []byte{0, 1, 0}))
	if kind, id, _, err := readFrame(out); err != nil || kind != kindData || id != 1 {
		t.Fatalf("frame %d on stream %d, %v", kind, id, err)
	}
	send(encodeFrame(kindCmd, 0, []byte(`{"cmd":"b"}`)))
	command(`{"cmd":"b"}`)
	select {
	case err := <-served:
		t.Fatalf("Serve ended: %v", err)
	default:
	}
}

func TestCommandFrameViolationsEndTheServer(t *testing.T) {
	s, _, _ := open(t, "x\n")
	cases := map[string][][]byte{
		"on stream 3":    {openRole(3, 0), encodeFrame(kindCmd, 3, []byte("{}"))},
		"on stream 1":    {encodeFrame(kindCmd, 1, []byte("{}"))},
		"over 64 KiB":    {encodeFrame(kindCmd, 0, make([]byte, maxCommand+1))},
		"cut short":      {encodeFrame(kindCmd, 0, []byte("{}"))[:10]},
		"event from app": {encodeFrame(kindEvent, 0, []byte("{}"))},
	}
	for name, frames := range cases {
		t.Run(name, func(t *testing.T) {
			if err := serveFrames(t, s, frames...); err == nil {
				t.Fatal("Serve accepted it")
			}
		})
	}
}

func TestCommandFrameOf64KiBIsFineAndDroppedWithoutACallback(t *testing.T) {
	s, _, _ := open(t, "x\n")
	if err := serveFrames(t, s, encodeFrame(kindCmd, 0, make([]byte, maxCommand))); err != nil {
		t.Fatalf("a command of 64 KiB ended with %v", err)
	}
	st := NewStdio(&bytes.Buffer{})
	defer st.Close(time.Second)
	n := 0
	st.OnCommand = func(p []byte) { n = len(p) }
	if err := st.Serve(s, bytes.NewReader(encodeFrame(kindCmd, 0, make([]byte, maxCommand)))); err != nil || n != maxCommand {
		t.Fatalf("%d bytes, %v", n, err)
	}
}
