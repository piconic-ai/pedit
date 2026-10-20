package protocol

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"
)

// relayServer accepts one connection and hands it to serve.
func relayServer(t *testing.T, serve func(ctx context.Context, c *websocket.Conn)) string {
	t.Helper()
	s := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		c, err := websocket.Accept(w, r, nil)
		if err != nil {
			return
		}
		defer c.CloseNow()
		serve(r.Context(), c)
	}))
	t.Cleanup(s.Close)
	return "ws" + strings.TrimPrefix(s.URL, "http")
}

func fastPings(t *testing.T) {
	interval, timeout := pingInterval, pingTimeout
	pingInterval, pingTimeout = 20*time.Millisecond, 50*time.Millisecond
	t.Cleanup(func() { pingInterval, pingTimeout = interval, timeout })
}

// A relay that stops answering, as one whose connection was dropped without
// a close reaching us, ends the read instead of leaving it waiting for good.
func TestDialWebSocketEndsASilentConnection(t *testing.T) {
	fastPings(t)
	// Never reading, the server never answers a ping.
	url := relayServer(t, func(ctx context.Context, _ *websocket.Conn) { <-ctx.Done() })
	conn, err := DialWebSocket(context.Background(), url, http.Header{})
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	read := make(chan error, 1)
	go func() {
		_, err := conn.Read(context.Background())
		read <- err
	}()
	select {
	case err := <-read:
		if err == nil {
			t.Fatal("Read returned a frame")
		}
	case <-time.After(5 * time.Second):
		t.Fatal("Read still waiting on a relay that stopped answering")
	}
}

func TestDialWebSocketKeepsAnAnsweringConnection(t *testing.T) {
	fastPings(t)
	url := relayServer(t, func(ctx context.Context, c *websocket.Conn) {
		// Reading answers pings.
		_, _, _ = c.Read(ctx)
	})
	conn, err := DialWebSocket(context.Background(), url, http.Header{})
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	read := make(chan error, 1)
	go func() {
		_, err := conn.Read(context.Background())
		read <- err
	}()
	select {
	case err := <-read:
		t.Fatalf("Read = %v, want it still waiting after many pings", err)
	case <-time.After(500 * time.Millisecond):
	}
}
