package session

import (
	"context"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"net/http"

	"github.com/piconic-ai/pedit/internal/hoststate"
	"github.com/piconic-ai/pedit/internal/protocol"
)

// keptRecoveryCandidate is held and disconnected. The relay cannot prove the
// unseen tail or the complete attachment inventory.
type keptRecoveryCandidate struct {
	session          *Session
	room             string
	path             string
	baseline         keptInitialRecord
	tailStatus       string
	attachmentStatus string
}

// inspectKeptRecovery loads a signed initial baseline and checks the exact
// checkpoint before applying the authenticated tail to an isolated session.
// It neither writes local files nor acknowledges or cuts the relay log.
func inspectKeptRecovery(ctx context.Context, store *hoststate.Store, room string, client *http.Client) (*keptRecoveryCandidate, error) {
	if store == nil || client == nil {
		return nil, errors.New("recovery credentials unavailable")
	}
	credentials, err := store.Load(room)
	if err != nil || credentials.Generation != 1 {
		return nil, errors.New("initial recovery credentials unavailable")
	}
	baseline, err := loadKeptInitial(credentials)
	if err != nil {
		return nil, err
	}
	keys, _, err := credentials.Keys()
	if err != nil {
		return nil, err
	}
	anchor := protocol.KeptReadAnchor{Epoch: hex.EncodeToString(baseline.Epoch[:]), Generation: 1, Cutoff: 0, Tail: 0, Ciphertext: base64.StdEncoding.EncodeToString(baseline.Checkpoint)}
	result, err := protocol.ReadKeptHost(ctx, client, credentials.Origin, room, credentials.HostToken, keys, 1, &anchor)
	if err != nil {
		return nil, err
	}
	var metaID uint64
	for _, entry := range result.Checkpoint.Manifest {
		if entry.Format == protocol.FormatMeta {
			metaID = entry.ID
		}
	}
	if metaID == 0 {
		return nil, errors.New("recovery metadata unavailable")
	}
	cp := recoveryCheckpoint{text: result.Checkpoint.Documents[0], comments: result.Checkpoint.Documents[metaID], metaID: metaID}
	opts := Options{File: baseline.File, Root: baseline.Project, Project: baseline.Project, Server: credentials.Origin}
	s, err := startKeptRecovery(ctx, opts, cp, result.Checkpoint.Ledger, keys, protocol.KeptRecordContext{RoomID: room, Epoch: baseline.Epoch, Generation: 1}, result.Frames)
	if err != nil {
		return nil, err
	}
	candidate := &keptRecoveryCandidate{session: s, room: room, baseline: baseline, tailStatus: "tail-unverified", attachmentStatus: "attachments-unverified"}
	candidate.path, err = candidate.exportRecoveryCandidate(store, room)
	if err != nil {
		return candidate, err
	}
	return candidate, nil
}
