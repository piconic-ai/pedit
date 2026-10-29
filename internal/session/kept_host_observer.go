package session

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"net/http"
	"sync"

	"github.com/coder/websocket"
	"github.com/piconic-ai/pedit/internal/hoststate"
	"github.com/piconic-ai/pedit/internal/keptclient"
	"github.com/piconic-ai/pedit/internal/protocol"
)

// keptHostObserver is an internal, read-only replica. It never writes files,
// publishes host changes, acknowledges a cut, or proves tail completeness.
type keptHostObserver struct {
	lifecycle sync.Mutex
	mu        sync.Mutex
	host      *keptclient.Host
	socket    *websocket.Conn
	done      chan struct{}
	keys      *protocol.KeptRoomKeys
	context   protocol.KeptRecordContext
	anchor    protocol.KeptReadAnchor
	current   keptObservedState
}
type keptObservedState struct {
	text, comments               []byte
	receipts                     []protocol.KeptReceipt
	tail                         uint64
	tailStatus, attachmentStatus string
}

func newKeptHostObserver(store *hoststate.Store, room string, client *http.Client) (*keptHostObserver, error) {
	if store == nil || client == nil {
		return nil, errors.New("host observer unavailable")
	}
	credentials, err := store.Load(room)
	if err != nil || credentials.Generation != 1 {
		return nil, errors.New("initial host state unavailable")
	}
	baseline, err := loadKeptInitial(credentials)
	if err != nil {
		return nil, err
	}
	keys, _, err := credentials.Keys()
	if err != nil {
		return nil, err
	}
	plain, err := protocol.OpenKeptCheckpoint(keys, protocol.KeptCheckpointContext{RoomID: room, Epoch: baseline.Epoch, Generation: 1}, baseline.Checkpoint)
	if err != nil {
		return nil, err
	}
	payload, err := protocol.DecodeKeptTextPayload(plain, protocol.MaxKeptCheckpointReceipts)
	if err != nil {
		return nil, err
	}
	metaID := keptMetadataID(payload)
	if metaID == 0 {
		return nil, errors.New("host metadata unavailable")
	}
	context := protocol.KeptRecordContext{RoomID: room, Epoch: baseline.Epoch, Generation: 1}
	cp, err := replayKeptRecovery(recoveryCheckpoint{text: payload.Documents[0], comments: payload.Documents[metaID], metaID: metaID}, payload.Ledger, keys, context, nil)
	if err != nil {
		return nil, err
	}
	host, err := keptclient.Open(store, room, client)
	if err != nil {
		return nil, err
	}
	return &keptHostObserver{host: host, keys: keys, context: context, anchor: protocol.KeptReadAnchor{Epoch: hex.EncodeToString(baseline.Epoch[:]), Generation: 1, Ciphertext: base64.StdEncoding.EncodeToString(baseline.Checkpoint)}, current: keptObservedState{text: cp.text, comments: cp.comments, receipts: cp.ledger.Snapshot(), tailStatus: "tail-unverified", attachmentStatus: "attachments-unverified"}}, nil
}

func keptMetadataID(payload protocol.KeptTextPayload) uint64 {
	for _, entry := range payload.Manifest {
		if entry.Format == protocol.FormatMeta {
			return entry.ID
		}
	}
	return 0
}

func (o *keptHostObserver) Connect(ctx context.Context) error {
	o.lifecycle.Lock()
	defer o.lifecycle.Unlock()
	o.mu.Lock()
	defer o.mu.Unlock()
	if o.socket != nil {
		return errors.New("host observer already connected")
	}
	socket, err := o.host.Connect(ctx)
	if err != nil {
		return err
	}
	done := make(chan struct{})
	o.socket = socket
	o.done = done
	go o.watch(socket, done)
	return nil
}
func (o *keptHostObserver) watch(socket *websocket.Conn, done chan struct{}) {
	defer close(done)
	_, _, _ = socket.Read(context.Background())
	_ = socket.CloseNow()
	o.mu.Lock()
	defer o.mu.Unlock()
	if o.socket == socket {
		o.socket = nil
		o.done = nil
	}
}
func (o *keptHostObserver) Disconnect() error {
	o.lifecycle.Lock()
	defer o.lifecycle.Unlock()
	o.mu.Lock()
	socket, done := o.socket, o.done
	o.socket = nil
	o.done = nil
	o.mu.Unlock()
	if socket == nil {
		return nil
	}
	err := socket.CloseNow()
	<-done
	return err
}

// Refresh replays from the authenticated initial snapshot on every read. It
// replaces the visible candidate only after the entire read and replay succeed.
func (o *keptHostObserver) Refresh(ctx context.Context) error {
	o.mu.Lock()
	defer o.mu.Unlock()
	if o.socket == nil {
		return errors.New("host observer disconnected")
	}
	read, err := o.host.Inspect(ctx, &o.anchor)
	if err != nil {
		return err
	}
	id := keptMetadataID(read.Checkpoint)
	if id == 0 {
		return errors.New("host metadata unavailable")
	}
	cp, err := replayKeptRecovery(recoveryCheckpoint{text: read.Checkpoint.Documents[0], comments: read.Checkpoint.Documents[id], metaID: id}, read.Checkpoint.Ledger, o.keys, o.context, read.Frames)
	if err != nil {
		return err
	}
	o.current = keptObservedState{text: cp.text, comments: cp.comments, receipts: cp.ledger.Snapshot(), tail: read.Snapshot.Tail, tailStatus: "tail-unverified", attachmentStatus: "attachments-unverified"}
	o.anchor.Tail = read.Snapshot.Tail
	return nil
}
func (o *keptHostObserver) Snapshot() keptObservedState {
	o.mu.Lock()
	defer o.mu.Unlock()
	s := o.current
	s.text = bytes.Clone(s.text)
	s.comments = bytes.Clone(s.comments)
	s.receipts = append([]protocol.KeptReceipt(nil), s.receipts...)
	return s
}
