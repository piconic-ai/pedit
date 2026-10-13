package protocol

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"strings"

	"github.com/coder/websocket"
)

// Conn is the subset of a WebSocket connection used by Client.
type Conn interface {
	// Read returns the next binary frame. A close frame from the peer is
	// reported as a *CloseError.
	Read(ctx context.Context) ([]byte, error)
	Write(ctx context.Context, data []byte) error
	Close() error
}

// Dialer opens a connection to url with extra handshake headers.
type Dialer func(ctx context.Context, url string, header http.Header) (Conn, error)

// CloseError reports that the connection was closed with a close code.
type CloseError struct {
	Code int
}

func (e *CloseError) Error() string { return fmt.Sprintf("websocket closed: %d", e.Code) }

func closeCode(err error) int {
	var ce *CloseError
	if errors.As(err, &ce) {
		return ce.Code
	}
	return -1
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
	return &wsConn{c: c}, nil
}

type wsConn struct {
	c *websocket.Conn
}

func (w *wsConn) Read(ctx context.Context) ([]byte, error) {
	for {
		typ, data, err := w.c.Read(ctx)
		if err != nil {
			if code := websocket.CloseStatus(err); code != -1 {
				return nil, &CloseError{Code: int(code)}
			}
			return nil, err
		}
		if typ == websocket.MessageBinary {
			return data, nil
		}
	}
}

func (w *wsConn) Write(ctx context.Context, data []byte) error {
	return w.c.Write(ctx, websocket.MessageBinary, data)
}

func (w *wsConn) Close() error {
	return w.c.Close(websocket.StatusNormalClosure, "")
}
