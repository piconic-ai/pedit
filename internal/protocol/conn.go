package protocol

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/coder/websocket"
)

// Conn is the subset of a WebSocket connection used by Client.
type Conn interface {
	// Read returns the next binary frame. A close frame from the peer is
	// reported as a *CloseError.
	// A text frame, which only the relay itself sends, is reported as a
	// Signal and does not end the connection.
	Read(ctx context.Context) ([]byte, error)
	Write(ctx context.Context, data []byte) error
	Close() error
	// Leave closes the connection as a host ending the session on purpose
	// (HostLeft).
	Leave() error
}

// Signal is a text frame of the relay's own, HostAway or HostBack.
type Signal string

func (s Signal) Error() string { return "relay says: " + string(s) }

// Dialer opens a connection to url with extra handshake headers.
type Dialer func(ctx context.Context, url string, header http.Header) (Conn, error)

// CloseError reports that the connection was closed with a close code.
type CloseError struct {
	Code   int
	Reason string
}

func (e *CloseError) Error() string { return fmt.Sprintf("websocket closed: %d", e.Code) }

func closeCode(err error) int {
	var ce *CloseError
	if errors.As(err, &ce) {
		return ce.Code
	}
	return -1
}

// closeReason is the reason a close frame carried, if err is one.
func closeReason(err error) string {
	var ce *CloseError
	if errors.As(err, &ce) {
		return ce.Reason
	}
	return ""
}

// The relay passes nothing over MaxFrameBytes; cap reads well above it so a
// hostile relay cannot make us buffer without bound.
const readLimit = 64 << 20

// DialWebSocket is the default Dialer.
func DialWebSocket(ctx context.Context, url string, header http.Header) (Conn, error) {
	var protocols []string
	for _, p := range strings.Split(header.Get("Sec-WebSocket-Protocol"), ",") {
		if p = strings.TrimSpace(p); p != "" {
			protocols = append(protocols, p)
		}
	}
	client := &http.Client{CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	c, _, err := websocket.Dial(ctx, url, &websocket.DialOptions{HTTPHeader: header, Subprotocols: protocols, HTTPClient: client})
	if err != nil {
		return nil, err
	}
	c.SetReadLimit(readLimit)
	ctx, stop := context.WithCancel(context.Background())
	w := &wsConn{c: c, stop: stop}
	go w.keepAlive(ctx)
	return w, nil
}

// A connection can be dropped without a close reaching us: a laptop goes to
// sleep, a network is switched, a router forgets the connection. Reads then
// wait for good and writes may still succeed for many minutes, while the
// relay has long closed the room. So the connection is pinged, and closed
// when the relay stops answering, which ends the read and has the Client
// reconnect. The relay answers pings without waking the room, so they cost
// nothing there.
var (
	pingInterval = 15 * time.Second
	pingTimeout  = 10 * time.Second
)

type wsConn struct {
	c    *websocket.Conn
	stop context.CancelFunc
}

// keepAlive pings the relay until ctx is done or a ping goes unanswered. A
// pong is read by the Client's read loop, which always runs.
func (w *wsConn) keepAlive(ctx context.Context) {
	ticker := time.NewTicker(pingInterval)
	defer ticker.Stop()
	for {
		select {
		case <-ticker.C:
		case <-ctx.Done():
			return
		}
		pctx, cancel := context.WithTimeout(ctx, pingTimeout)
		err := w.c.Ping(pctx)
		cancel()
		if err != nil {
			// No close handshake: it would wait on the same silence.
			_ = w.c.CloseNow()
			return
		}
	}
}

func (w *wsConn) Read(ctx context.Context) ([]byte, error) {
	for {
		typ, data, err := w.c.Read(ctx)
		if err != nil {
			if code := websocket.CloseStatus(err); code != -1 {
				var ce websocket.CloseError
				errors.As(err, &ce)
				return nil, &CloseError{Code: int(code), Reason: ce.Reason}
			}
			return nil, err
		}
		if typ == websocket.MessageBinary {
			return data, nil
		}
		if typ == websocket.MessageText {
			return nil, Signal(data)
		}
	}
}

func (w *wsConn) Write(ctx context.Context, data []byte) error {
	return w.c.Write(ctx, websocket.MessageBinary, data)
}

func (w *wsConn) Close() error {
	w.stop()
	return w.c.Close(websocket.StatusNormalClosure, "")
}

func (w *wsConn) Leave() error {
	w.stop()
	return w.c.Close(HostLeft, "the host left")
}
