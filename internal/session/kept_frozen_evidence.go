package session

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net/http"
	"reflect"
	"regexp"

	"github.com/piconic-ai/pedit/internal/hoststate"
)

const frozenEvidenceDomain = "pedit/v6/frozen-observation\x00"

var frozenTokenPattern = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`)

type observedFrozenCut struct {
	Epoch      string `json:"epoch"`
	Generation uint64 `json:"generation"`
	Cutoff     uint64 `json:"cutoff"`
	Token      string `json:"token"`
}

func (observedFrozenCut) String() string   { return "[frozen cut]" }
func (observedFrozenCut) GoString() string { return "[frozen cut]" }

type frozenEvidence struct {
	Version      int               `json:"version"`
	Room         string            `json:"room"`
	Cut          observedFrozenCut `json:"cut"`
	EvidencePath string            `json:"evidencePath"`
	EvidenceHash [32]byte          `json:"evidenceHash"`
	Status       string            `json:"status"`
	Signature    []byte            `json:"signature"`
}
type frozenCapture struct {
	ObservationPath string
	ReadPath        string
}
type pendingFrozenCut func(context.Context) (*observedFrozenCut, error)

func (frozenEvidence) String() string   { return "[frozen observation]" }
func (frozenEvidence) GoString() string { return "[frozen observation]" }

func frozenMessage(v frozenEvidence) ([]byte, error) {
	v.Signature = nil
	b, err := json.Marshal(v)
	if err != nil {
		return nil, err
	}
	return append([]byte(frozenEvidenceDomain), b...), nil
}

// captureFrozenEvidence observes an already frozen test transport. pending
// must authenticate the host. It never freezes, aborts, commits or cuts itself.
// A match is historical: neither relay completeness nor future freeze state is
// proven. A failed later step can leave a separately saved read evidence path.
func captureFrozenEvidence(ctx context.Context, store *hoststate.Store, room string, client *http.Client, pending pendingFrozenCut) (result frozenCapture, err error) {
	if store == nil || client == nil || pending == nil {
		return result, errors.New("frozen observation unavailable")
	}
	creds, err := store.Load(room)
	if err != nil {
		return result, err
	}
	first, err := pending(ctx)
	if err != nil || first == nil || !validObservedCut(*first) {
		return result, errors.New("pending frozen state unavailable")
	}
	cut := *first
	result.ReadPath, err = captureReadEvidence(ctx, store, room, client)
	if err != nil {
		return result, err
	}
	raw, err := store.ReadCandidate(room, result.ReadPath)
	if err != nil {
		return result, err
	}
	evidence, err := verifyReadEvidence(creds, raw)
	if err != nil || !frozenMatches(cut, evidence) {
		return result, errors.New("frozen read observation mismatch")
	}
	again, err := pending(ctx)
	if err != nil || again == nil || *again != cut {
		return result, errors.New("frozen state changed during observation")
	}
	_, signer, err := creds.Keys()
	if err != nil {
		return result, err
	}
	record := frozenEvidence{Version: 1, Room: room, Cut: cut, EvidencePath: result.ReadPath, EvidenceHash: sha256.Sum256(raw), Status: "observed-not-complete"}
	msg, err := frozenMessage(record)
	if err != nil {
		return result, err
	}
	record.Signature = ed25519.Sign(signer, msg)
	encoded, err := json.Marshal(record)
	if err != nil {
		return result, err
	}
	result.ObservationPath, err = publishReadEvidence(store, creds, encoded)
	return result, err
}

func validObservedCut(c observedFrozenCut) bool {
	b, err := hex.DecodeString(c.Epoch)
	return err == nil && len(b) == 32 && !bytes.Equal(b, make([]byte, 32)) && hex.EncodeToString(b) == c.Epoch && c.Generation > 0 && c.Generation <= 1<<53-1 && c.Cutoff <= 1<<53-1 && frozenTokenPattern.MatchString(c.Token)
}
func frozenMatches(c observedFrozenCut, e recoveryEvidence) bool {
	return c.Epoch == hex.EncodeToString(e.Epoch[:]) && c.Generation == e.Generation && c.Cutoff == e.Tail && e.TailStatus == "unverified"
}

// openFrozenEvidence verifies the signed historical observation and the exact
// evidence bytes. It does not assert that the relay is still frozen.
func openFrozenEvidence(store *hoststate.Store, room, path string) (frozenEvidence, error) {
	var v frozenEvidence
	if store == nil {
		return v, errors.New("frozen observation unavailable")
	}
	creds, err := store.Load(room)
	if err != nil {
		return v, err
	}
	raw, err := store.ReadCandidate(room, path)
	if err != nil {
		return v, err
	}
	if json.Unmarshal(raw, &v) != nil {
		return frozenEvidence{}, errors.New("invalid frozen observation")
	}
	canonical, err := json.Marshal(v)
	if err != nil || !bytes.Equal(raw, canonical) {
		return frozenEvidence{}, errors.New("invalid frozen observation")
	}
	keys, _, err := creds.Keys()
	if err != nil {
		return frozenEvidence{}, err
	}
	msg, err := frozenMessage(v)
	if err != nil || len(v.Signature) != ed25519.SignatureSize || !ed25519.Verify(keys.HostKey, msg, v.Signature) || v.Version != 1 || v.Room != room || v.Status != "observed-not-complete" || !validObservedCut(v.Cut) {
		return frozenEvidence{}, errors.New("invalid frozen observation")
	}
	evidenceRaw, err := store.ReadCandidate(room, v.EvidencePath)
	if err != nil || sha256.Sum256(evidenceRaw) != v.EvidenceHash {
		return frozenEvidence{}, errors.New("frozen evidence changed")
	}
	evidence, err := verifyReadEvidence(creds, evidenceRaw)
	if err != nil || !frozenMatches(v.Cut, evidence) {
		return frozenEvidence{}, errors.New("invalid frozen evidence")
	}
	latest, err := store.Load(room)
	if err != nil || !reflect.DeepEqual(creds, latest) {
		return frozenEvidence{}, errors.New("frozen credentials changed")
	}
	return v, nil
}
