// Package keptclient provides internal host transport. It is not a public CLI.
package keptclient

import (
	"bytes"
	"context"
	"encoding/hex"
	"errors"
	"fmt"
	"net/http"
	"strconv"
	"time"

	"github.com/coder/websocket"
	"github.com/piconic-ai/pedit/internal/hoststate"
	"github.com/piconic-ai/pedit/internal/protocol"
)

type Host struct {
	credentials hoststate.Credentials
	http        *http.Client
}

// Open loads validated, previously saved credentials. The caller retains the
// store and is responsible for durably saving the checkpoint and its baseline.
func Open(store *hoststate.Store, room string, client *http.Client) (*Host, error) {
	if store == nil || client == nil {
		return nil, errors.New("invalid host configuration")
	}
	c, err := store.Load(room)
	if err != nil {
		return nil, err
	}
	if _, _, err = c.Keys(); err != nil {
		return nil, err
	}
	copyClient := *client
	copyClient.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	return &Host{credentials: c, http: &copyClient}, nil
}
func (h *Host) endpoint(action string) string {
	return h.credentials.Origin + "/internal/kept/" + h.credentials.RoomID + "/" + action
}
func (h *Host) request(ctx context.Context, action string, body []byte, headers http.Header) (*http.Response, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, h.endpoint(action), bytes.NewReader(body))
	if err != nil {
		return nil, errors.New("invalid host request")
	}
	req.Header = headers.Clone()
	req.Header.Set("Authorization", "Host "+h.credentials.HostToken)
	response, err := h.http.Do(req)
	if err != nil {
		return nil, errors.New("host request failed")
	}
	return response, nil
}

// Initialize publishes an already durably saved, authenticated initial snapshot.
// It initializes away, and does not claim that the host socket is connected.
func (h *Host) Initialize(ctx context.Context, epoch [32]byte, checkpoint []byte, keep time.Duration) (time.Duration, error) {
	if keep <= 0 || keep%time.Second != 0 || h.credentials.Generation != 1 {
		return 0, errors.New("invalid initialization")
	}
	keys, _, err := h.credentials.Keys()
	if err != nil {
		return 0, err
	}
	cp := protocol.KeptCheckpointContext{RoomID: h.credentials.RoomID, Epoch: epoch, Generation: 1}
	payload, err := protocol.OpenKeptCheckpoint(keys, cp, checkpoint)
	if err != nil {
		return 0, errors.New("invalid checkpoint")
	}
	if _, err = protocol.DecodeKeptTextPayload(payload, 10000); err != nil {
		return 0, errors.New("invalid checkpoint payload")
	}
	seconds := int64(keep / time.Second)
	headers := http.Header{}
	headers.Set("X-Pedit-Editor", keys.EditAdmission)
	headers.Set("X-Pedit-Commenter", keys.CommentAdmission)
	headers.Set("X-Pedit-Reader", keys.ReadAdmission)
	headers.Set("X-Pedit-Epoch", hex.EncodeToString(epoch[:]))
	headers.Set("X-Pedit-Keep-Seconds", strconv.FormatInt(seconds, 10))
	resp, err := h.request(ctx, "initialize", checkpoint, headers)
	if err != nil {
		return 0, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusNoContent {
		return 0, fmt.Errorf("initialization failed (HTTP %d)", resp.StatusCode)
	}
	effective, err := strconv.ParseInt(resp.Header.Get("X-Pedit-Keep-Seconds"), 10, 64)
	if err != nil || effective <= 0 || effective > seconds {
		return 0, errors.New("invalid relay keep duration")
	}
	return time.Duration(effective) * time.Second, nil
}

// Connect establishes host presence. Losing or closing the socket makes the
// relay transition to away; callers must not claim that transition succeeded.
func (h *Host) Connect(ctx context.Context) (*websocket.Conn, error) {
	headers := http.Header{}
	headers.Set("Authorization", "Host "+h.credentials.HostToken)
	conn, resp, err := websocket.Dial(ctx, h.endpoint("host"), &websocket.DialOptions{HTTPClient: h.http, HTTPHeader: headers})
	if err != nil {
		if resp != nil {
			resp.Body.Close()
		}
		return nil, errors.New("host connection failed")
	}
	return conn, nil
}

// CloseRoom requests permanent closure. A lost response is ambiguous; the
// caller must not treat an error as proof either of closure or of retention.
func (h *Host) CloseRoom(ctx context.Context) error {
	resp, err := h.request(ctx, "close", nil, http.Header{})
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusNoContent {
		return fmt.Errorf("room close failed (HTTP %d)", resp.StatusCode)
	}
	return nil
}

// Inspect reads and verifies one fixed checkpoint and tail. It does not apply,
// acknowledge or cut records, and cannot prove an unseen tail is complete.
func (h *Host) Inspect(ctx context.Context, anchor *protocol.KeptReadAnchor) (protocol.KeptReadInspection, error) {
	keys, _, err := h.credentials.Keys()
	if err != nil {
		return protocol.KeptReadInspection{}, err
	}
	return protocol.ReadKeptHost(ctx, h.http, h.credentials.Origin, h.credentials.RoomID, h.credentials.HostToken, keys, anchor)
}
