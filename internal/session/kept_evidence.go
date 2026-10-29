package session

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net/http"
	"reflect"

	"github.com/piconic-ai/pedit/internal/hoststate"
	"github.com/piconic-ai/pedit/internal/protocol"
)

const evidenceDomain = "pedit/v6/read-evidence\x00"
const maxEvidenceCipherBytes = 10 << 20

type evidenceEntry struct {
	Sequence   uint64 `json:"sequence"`
	Ciphertext []byte `json:"ciphertext"`
}
type recoveryEvidence struct {
	Version    int             `json:"version"`
	Room       string          `json:"room"`
	Epoch      [32]byte        `json:"epoch"`
	Generation uint64          `json:"generation"`
	Cutoff     uint64          `json:"cutoff"`
	Tail       uint64          `json:"tail"`
	Checkpoint []byte          `json:"checkpoint"`
	Entries    []evidenceEntry `json:"entries"`
	Text       []byte          `json:"text"`
	Comments   []byte          `json:"comments"`
	MetadataID uint64          `json:"metadataId"`
	Ledger     []byte          `json:"ledger"`
	TailStatus string          `json:"tailStatus"`
	Signature  []byte          `json:"signature"`
}

func evidenceMessage(e recoveryEvidence) ([]byte, error) {
	e.Signature = nil
	raw, err := json.Marshal(e)
	if err != nil {
		return nil, err
	}
	return append([]byte(evidenceDomain), raw...), nil
}

// captureReadEvidence records what the host observed. It cannot prove that the
// relay delivered unseen records and does not authorize saving or cutting.
func captureReadEvidence(ctx context.Context, store *hoststate.Store, room string, client *http.Client) (string, error) {
	if store == nil || client == nil {
		return "", errors.New("evidence configuration unavailable")
	}
	credentials, err := store.Load(room)
	if err != nil || credentials.Generation != 1 {
		return "", errors.New("initial recovery credentials unavailable")
	}
	baseline, err := loadKeptInitial(credentials)
	if err != nil {
		return "", err
	}
	keys, _, err := credentials.Keys()
	if err != nil {
		return "", err
	}
	anchor := protocol.KeptReadAnchor{Epoch: hex.EncodeToString(baseline.Epoch[:]), Generation: 1, Cutoff: 0, Tail: 0, Ciphertext: base64.StdEncoding.EncodeToString(baseline.Checkpoint)}
	read, err := protocol.ReadKeptHost(ctx, client, credentials.Origin, room, credentials.HostToken, keys, 1, &anchor)
	if err != nil {
		return "", err
	}
	raw, err := buildReadEvidence(credentials, read)
	if err != nil {
		return "", err
	}
	return publishReadEvidence(store, credentials, raw)
}

func buildReadEvidence(credentials hoststate.Credentials, read protocol.KeptReadInspection) ([]byte, error) {
	room := credentials.RoomID
	baseline, err := loadKeptInitial(credentials)
	if err != nil {
		return nil, err
	}
	keys, signer, err := credentials.Keys()
	if err != nil {
		return nil, err
	}
	entries, err := makeEvidenceEntries(read, baseline.Checkpoint)
	if err != nil {
		return nil, err
	}
	var metaID uint64
	for _, f := range read.Checkpoint.Manifest {
		if f.Format == protocol.FormatMeta {
			metaID = f.ID
		}
	}
	cp := recoveryCheckpoint{text: read.Checkpoint.Documents[0], comments: read.Checkpoint.Documents[metaID], metaID: metaID}
	replayed, err := replayKeptRecovery(cp, read.Checkpoint.Ledger, keys, protocol.KeptRecordContext{RoomID: room, Epoch: baseline.Epoch, Generation: 1}, read.Frames)
	if err != nil {
		return nil, err
	}
	ledger, err := protocol.EncodeKeptLedger(replayed.ledger)
	if err != nil {
		return nil, err
	}
	e := recoveryEvidence{Version: 1, Room: room, Epoch: baseline.Epoch, Generation: 1, Cutoff: read.Snapshot.Cutoff, Tail: read.Snapshot.Tail, Checkpoint: bytes.Clone(baseline.Checkpoint), Entries: entries, Text: replayed.text, Comments: replayed.comments, MetadataID: metaID, Ledger: ledger, TailStatus: "unverified"}
	message, err := evidenceMessage(e)
	if err != nil {
		return nil, err
	}
	e.Signature = ed25519.Sign(signer, message)
	raw, err := json.Marshal(e)
	if err != nil {
		return nil, err
	}
	if _, err = verifyReadEvidence(credentials, raw); err != nil {
		return nil, err
	}
	return raw, nil
}

func publishReadEvidence(store *hoststate.Store, credentials hoststate.Credentials, raw []byte) (string, error) {
	latest, err := store.Load(credentials.RoomID)
	if err != nil || !reflect.DeepEqual(credentials, latest) {
		return "", errors.New("evidence credentials changed")
	}
	path, err := store.PublishCandidate(credentials.RoomID, raw)
	if err != nil {
		return path, err
	}
	latest, err = store.Load(credentials.RoomID)
	if err != nil || !reflect.DeepEqual(credentials, latest) {
		return path, errors.New("evidence credentials changed")
	}
	return path, nil
}

func makeEvidenceEntries(read protocol.KeptReadInspection, checkpoint []byte) ([]evidenceEntry, error) {
	if len(read.Sequences) != len(read.Frames) {
		return nil, errors.New("missing read sequence")
	}
	entries := make([]evidenceEntry, len(read.Frames))
	total := len(checkpoint)
	for i, frame := range read.Frames {
		total += len(frame)
		if total > maxEvidenceCipherBytes {
			return nil, errors.New("read evidence exceeds capacity")
		}
		entries[i] = evidenceEntry{Sequence: read.Sequences[i], Ciphertext: bytes.Clone(frame)}
	}
	return entries, nil
}

// openReadEvidence replays the authenticated data again; the returned state is
// an observation only and may not be used as authority for cut or ACK.
func openReadEvidence(store *hoststate.Store, room, path string) (recoveryEvidence, error) {
	if store == nil {
		return recoveryEvidence{}, errors.New("evidence unavailable")
	}
	credentials, err := store.Load(room)
	if err != nil {
		return recoveryEvidence{}, err
	}
	raw, err := store.ReadCandidate(room, path)
	if err != nil {
		return recoveryEvidence{}, err
	}
	e, err := verifyReadEvidence(credentials, raw)
	if err != nil {
		return recoveryEvidence{}, err
	}
	latest, err := store.Load(room)
	if err != nil || !reflect.DeepEqual(credentials, latest) {
		return recoveryEvidence{}, errors.New("evidence credentials changed")
	}
	return e, nil
}

func verifyReadEvidence(credentials hoststate.Credentials, raw []byte) (recoveryEvidence, error) {
	var e recoveryEvidence
	bad := errors.New("invalid read evidence")
	if len(raw) == 0 || len(raw) > 16<<20 || json.Unmarshal(raw, &e) != nil {
		return recoveryEvidence{}, bad
	}
	canonical, err := json.Marshal(e)
	if err != nil || !bytes.Equal(raw, canonical) {
		return recoveryEvidence{}, bad
	}
	baseline, err := loadKeptInitial(credentials)
	if err != nil {
		return recoveryEvidence{}, bad
	}
	keys, _, err := credentials.Keys()
	if err != nil {
		return recoveryEvidence{}, bad
	}
	message, err := evidenceMessage(e)
	if err != nil || len(e.Signature) != ed25519.SignatureSize || !ed25519.Verify(keys.HostKey, message, e.Signature) {
		return recoveryEvidence{}, bad
	}
	if !validEvidenceHeader(e, credentials, baseline) {
		return recoveryEvidence{}, bad
	}
	plain, err := protocol.OpenKeptCheckpoint(keys, protocol.KeptCheckpointContext{RoomID: e.Room, Epoch: e.Epoch, Generation: e.Generation, Cutoff: e.Cutoff}, e.Checkpoint)
	if err != nil {
		return recoveryEvidence{}, bad
	}
	cp, err := protocol.DecodeKeptTextPayload(plain, protocol.MaxKeptCheckpointReceipts)
	if err != nil {
		return recoveryEvidence{}, bad
	}
	frames, err := evidenceFrames(e)
	if err != nil {
		return recoveryEvidence{}, bad
	}
	replayed, err := replayKeptRecovery(recoveryCheckpoint{text: cp.Documents[0], comments: cp.Documents[e.MetadataID], metaID: e.MetadataID}, cp.Ledger, keys, protocol.KeptRecordContext{RoomID: e.Room, Epoch: e.Epoch, Generation: e.Generation}, frames)
	if err != nil {
		return recoveryEvidence{}, bad
	}
	ledger, err := protocol.EncodeKeptLedger(replayed.ledger)
	if err != nil || !bytes.Equal(ledger, e.Ledger) || !bytes.Equal(replayed.text, e.Text) || !bytes.Equal(replayed.comments, e.Comments) {
		return recoveryEvidence{}, bad
	}
	return e, nil
}

func validEvidenceHeader(e recoveryEvidence, credentials hoststate.Credentials, baseline keptInitialRecord) bool {
	if credentials.Generation != 1 || e.Version != 1 || e.Room != credentials.RoomID || e.Generation != 1 || e.Epoch != baseline.Epoch || e.Cutoff != 0 || e.TailStatus != "unverified" || !bytes.Equal(e.Checkpoint, baseline.Checkpoint) {
		return false
	}
	return e.Tail <= 1<<53-1 && e.Tail >= e.Cutoff && len(e.Entries) <= protocol.MaxKeptReadRecords && e.Entries != nil
}
func evidenceFrames(e recoveryEvidence) ([][]byte, error) {
	frames := make([][]byte, len(e.Entries))
	after := e.Cutoff
	total := len(e.Checkpoint)
	for i, entry := range e.Entries {
		total += len(entry.Ciphertext)
		if entry.Sequence <= after || entry.Sequence > e.Tail || len(entry.Ciphertext) == 0 || len(entry.Ciphertext) > protocol.MaxFrameBytes || total > maxEvidenceCipherBytes {
			return nil, errors.New("invalid evidence entries")
		}
		after = entry.Sequence
		frames[i] = entry.Ciphertext
	}
	if after != e.Tail {
		return nil, errors.New("invalid evidence tail")
	}
	return frames, nil
}
