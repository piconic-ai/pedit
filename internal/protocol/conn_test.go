package protocol

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/reearth/ygo/awareness"
	"github.com/reearth/ygo/crdt"
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
		// As the room's Durable Object does.
		for {
			typ, data, err := c.Read(ctx)
			if err != nil {
				return
			}
			if typ == websocket.MessageText && string(data) == RelayPing {
				_ = c.Write(ctx, websocket.MessageText, []byte(RelayPong))
			}
		}
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

// Cloudflare's edge answers WebSocket pings even when the room has lost the
// connection, so only the room's own answer keeps a connection.
func TestDialWebSocketEndsAConnectionTheRoomLost(t *testing.T) {
	fastPings(t)
	// Reading answers WebSocket pings, but RelayPing goes unanswered.
	url := relayServer(t, func(ctx context.Context, c *websocket.Conn) {
		for {
			if _, _, err := c.Read(ctx); err != nil {
				return
			}
		}
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
		if err == nil {
			t.Fatal("Read returned a frame")
		}
	case <-time.After(5 * time.Second):
		t.Fatal("Read still waiting on a room that stopped answering")
	}
}

// The relay's own text frames come back as Signals, between binary frames.
func TestDialWebSocketReadsTheRelaysSignals(t *testing.T) {
	url := relayServer(t, func(ctx context.Context, c *websocket.Conn) {
		_ = c.Write(ctx, websocket.MessageText, []byte(HostAway))
		_ = c.Write(ctx, websocket.MessageBinary, []byte{1})
		_, _, _ = c.Read(ctx)
	})
	conn, err := DialWebSocket(context.Background(), url, http.Header{})
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if _, err := conn.Read(ctx); err != Signal(HostAway) {
		t.Fatalf("first Read = %v, want the HostAway signal", err)
	}
	if data, err := conn.Read(ctx); err != nil || len(data) != 1 {
		t.Fatalf("second Read = %v, %v", data, err)
	}
}

// A host leaving on purpose says so, where a dropped one does not.
func TestLeaveClosesWithHostLeft(t *testing.T) {
	codes := make(chan websocket.StatusCode, 1)
	url := relayServer(t, func(ctx context.Context, c *websocket.Conn) {
		_, _, err := c.Read(ctx)
		codes <- websocket.CloseStatus(err)
	})
	conn, err := DialWebSocket(context.Background(), url, http.Header{})
	if err != nil {
		t.Fatal(err)
	}
	_ = conn.Leave()
	select {
	case code := <-codes:
		if code != HostLeft {
			t.Fatalf("closed with %d, want HostLeft", code)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("the relay never heard the close")
	}
}

// A host destroyed with its read loop running still tells the relay it left
// on purpose: the read is cancelled only after.
func TestHostClientLeavesWithHostLeft(t *testing.T) {
	codes := make(chan websocket.StatusCode, 1)
	url := relayServer(t, func(ctx context.Context, c *websocket.Conn) {
		for {
			if _, _, err := c.Read(ctx); err != nil {
				codes <- websocket.CloseStatus(err)
				return
			}
		}
	})
	key, err := DecodeKey(GenerateKey())
	if err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 30; i++ {
		doc := crdt.New()
		aw := awareness.New(uint64(doc.ClientID()))
		aw.SetLocalState(map[string]any{})
		connected := make(chan struct{}, 1)
		c, err := NewClient(ClientOptions{
			URL: url, Key: key, Doc: doc, Awareness: aw, Host: true,
			OnStatus: func(s Status) {
				if s == StatusConnected {
					select {
					case connected <- struct{}{}:
					default:
					}
				}
			},
		})
		if err != nil {
			t.Fatal(err)
		}
		c.Connect()
		<-connected
		c.Destroy()
		select {
		case code := <-codes:
			if code != HostLeft {
				t.Fatalf("round %d: closed with %d, want HostLeft", i, code)
			}
		case <-time.After(5 * time.Second):
			t.Fatalf("round %d: the relay never heard the close", i)
		}
	}
}

// A connection keeps the ping interval it was dialled with. Tests make the
// intervals fast between dials, while a keepAlive of an earlier connection
// may still be ending, so keepAlive must not read the package variables.
func TestDialWebSocketKeepsThePingIntervalItWasDialledWith(t *testing.T) {
	pings := make(chan struct{}, 8)
	url := relayServer(t, func(ctx context.Context, c *websocket.Conn) {
		for {
			typ, data, err := c.Read(ctx)
			if err != nil {
				return
			}
			if typ == websocket.MessageText && string(data) == RelayPing {
				pings <- struct{}{}
			}
		}
	})
	conn, err := DialWebSocket(context.Background(), url, http.Header{})
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	// After the dial: the connection above was made with the 15-second default.
	fastPings(t)
	select {
	case <-pings:
		t.Fatal("pinged at the fast interval set after the dial")
	case <-time.After(200 * time.Millisecond):
	}
}
