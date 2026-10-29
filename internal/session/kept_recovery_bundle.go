package session

import (
	"bytes"
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"reflect"
	"unicode/utf8"

	"github.com/piconic-ai/pedit/internal/hoststate"
	"github.com/piconic-ai/pedit/internal/meta"
	"github.com/reearth/ygo/crdt"
)

const recoveryBundleDomain = "pedit/v6/recovery-bundle\x00"

type recoveryBundleArtifacts struct {
	Evidence, Text, Comments, Manifest string
}
type recoveryBundleView struct {
	Text, Comments                                     []byte
	TextPath, CommentsPath, EvidencePath, ManifestPath string
	TailStatus, AttachmentStatus, CommentsFormat       string
}
type recoveryBundleManifest struct {
	Kind             string   `json:"kind"`
	Version          int      `json:"version"`
	Room             string   `json:"room"`
	Generation       uint64   `json:"generation"`
	Epoch            [32]byte `json:"epoch"`
	Tail             uint64   `json:"tail"`
	TailStatus       string   `json:"tailStatus"`
	AttachmentStatus string   `json:"attachmentStatus"`
	CommentsFormat   string   `json:"commentsFormat"`
	EvidencePath     string   `json:"evidencePath"`
	EvidenceHash     string   `json:"evidenceHash"`
	TextPath         string   `json:"textPath"`
	TextHash         string   `json:"textHash"`
	CommentsPath     string   `json:"commentsPath"`
	CommentsHash     string   `json:"commentsHash"`
	Signature        []byte   `json:"signature"`
}

func recoveryBundleMessage(m recoveryBundleManifest) ([]byte, error) {
	m.Signature = nil
	raw, err := json.Marshal(m)
	if err != nil {
		return nil, err
	}
	return append([]byte(recoveryBundleDomain), raw...), nil
}
func recoveryBundleHash(data []byte) string {
	sum := sha256.Sum256(data)
	return hex.EncodeToString(sum[:])
}

func renderRecoveryEvidence(e recoveryEvidence) (text, comments []byte, err error) {
	defer func() {
		if recover() != nil {
			text = nil
			comments = nil
			err = errors.New("invalid recovery evidence state")
		}
	}()
	if _, _, err = recoveryCheckpointWork(e.Text, e.Comments); err != nil {
		return nil, nil, err
	}
	textDoc, commentsDoc := crdt.New(), crdt.New()
	defer textDoc.Destroy()
	defer commentsDoc.Destroy()
	if err = crdt.ApplyUpdateV1(textDoc, e.Text, nil); err != nil {
		return nil, nil, err
	}
	if err = crdt.ApplyUpdateV1(commentsDoc, e.Comments, nil); err != nil {
		return nil, nil, err
	}
	value := textDoc.GetText("content").ToString()
	if !utf8.ValidString(value) {
		return nil, nil, errors.New("invalid recovery text")
	}
	raw, err := commentsDoc.GetMap(meta.CommentsKey).ToJSON()
	if err != nil {
		return nil, nil, err
	}
	var pretty bytes.Buffer
	if err = json.Indent(&pretty, raw, "", "  "); err != nil {
		return nil, nil, err
	}
	return []byte(value), append(pretty.Bytes(), '\n'), nil
}

// publishRecoveryBundle never edits the shared file or changes relay history.
// Nonempty paths returned with an error may already have been published.
func publishRecoveryBundle(store *hoststate.Store, room, evidencePath string) (result recoveryBundleArtifacts, err error) {
	result.Evidence = evidencePath
	if store == nil {
		return result, errors.New("recovery store unavailable")
	}
	credentials, err := store.Load(room)
	if err != nil {
		return result, err
	}
	raw, err := store.ReadCandidate(room, evidencePath)
	if err != nil {
		return result, err
	}
	e, err := verifyReadEvidence(credentials, raw)
	if err != nil {
		return result, err
	}
	text, comments, err := renderRecoveryEvidence(e)
	if err != nil {
		return result, err
	}
	result.Text, err = store.PublishRecoveryOutput(room, hoststate.RecoveryText, text)
	if err != nil {
		return result, err
	}
	result.Comments, err = store.PublishRecoveryOutput(room, hoststate.RecoveryComments, comments)
	if err != nil {
		return result, err
	}
	latest, err := store.Load(room)
	if err != nil || !reflect.DeepEqual(credentials, latest) {
		return result, errors.New("recovery credentials changed")
	}
	_, signer, err := credentials.Keys()
	if err != nil {
		return result, err
	}
	m := recoveryBundleManifest{Kind: "recovery-bundle", Version: 1, Room: room, Generation: e.Generation, Epoch: e.Epoch, Tail: e.Tail, TailStatus: "unverified", AttachmentStatus: "unverified", CommentsFormat: "inspection-json", EvidencePath: evidencePath, EvidenceHash: recoveryBundleHash(raw), TextPath: result.Text, TextHash: recoveryBundleHash(text), CommentsPath: result.Comments, CommentsHash: recoveryBundleHash(comments)}
	message, err := recoveryBundleMessage(m)
	if err != nil {
		return result, err
	}
	m.Signature = ed25519.Sign(signer, message)
	manifest, err := json.Marshal(m)
	if err != nil {
		return result, err
	}
	result.Manifest, err = store.PublishCandidate(room, manifest)
	if err != nil {
		return result, err
	}
	if _, err = openRecoveryBundle(store, room, result.Manifest); err != nil {
		return result, err
	}
	latest, err = store.Load(room)
	if err != nil || !reflect.DeepEqual(credentials, latest) {
		return result, errors.New("recovery credentials changed")
	}
	return result, nil
}

var errInvalidRecoveryBundle = errors.New("invalid recovery bundle")

func readRecoveryBundleManifest(store *hoststate.Store, credentials hoststate.Credentials, room, path string) (recoveryBundleManifest, error) {
	var m recoveryBundleManifest
	raw, err := store.ReadCandidate(room, path)
	if err != nil || len(raw) > 16<<10 || json.Unmarshal(raw, &m) != nil {
		return m, errInvalidRecoveryBundle
	}
	canonical, err := json.Marshal(m)
	if err != nil || !bytes.Equal(canonical, raw) || m.Kind != "recovery-bundle" || m.Version != 1 || m.Room != room || m.Generation != credentials.Generation || m.TailStatus != "unverified" || m.AttachmentStatus != "unverified" || m.CommentsFormat != "inspection-json" {
		return m, errInvalidRecoveryBundle
	}
	keys, _, err := credentials.Keys()
	if err != nil {
		return m, errInvalidRecoveryBundle
	}
	message, err := recoveryBundleMessage(m)
	if err != nil || len(m.Signature) != ed25519.SignatureSize || !ed25519.Verify(keys.HostKey, message, m.Signature) {
		return m, errInvalidRecoveryBundle
	}
	return m, nil
}

func readRecoveryBundleEvidence(store *hoststate.Store, credentials hoststate.Credentials, m recoveryBundleManifest) (recoveryEvidence, error) {
	var empty recoveryEvidence
	raw, err := store.ReadCandidate(m.Room, m.EvidencePath)
	if err != nil || recoveryBundleHash(raw) != m.EvidenceHash {
		return empty, errInvalidRecoveryBundle
	}
	e, err := verifyReadEvidence(credentials, raw)
	if err != nil || e.Generation != m.Generation || e.Epoch != m.Epoch || e.Tail != m.Tail {
		return empty, errInvalidRecoveryBundle
	}
	return e, nil
}

func readVerifiedRecoveryOutput(store *hoststate.Store, room string, kind hoststate.RecoveryOutputKind, path, hash string, expected []byte) ([]byte, error) {
	output, err := store.ReadRecoveryOutput(room, kind, path)
	if err != nil || recoveryBundleHash(output) != hash || !bytes.Equal(output, expected) {
		return nil, errInvalidRecoveryBundle
	}
	return output, nil
}

// openRecoveryBundle returns verified bytes, not a promise that paths cannot
// later be replaced. It does not establish a complete tail or attachment list.
func openRecoveryBundle(store *hoststate.Store, room, path string) (recoveryBundleView, error) {
	var result recoveryBundleView
	if store == nil {
		return result, errInvalidRecoveryBundle
	}
	credentials, err := store.Load(room)
	if err != nil {
		return result, errInvalidRecoveryBundle
	}
	m, err := readRecoveryBundleManifest(store, credentials, room, path)
	if err != nil {
		return result, err
	}
	e, err := readRecoveryBundleEvidence(store, credentials, m)
	if err != nil {
		return result, err
	}
	expectedText, expectedComments, err := renderRecoveryEvidence(e)
	if err != nil {
		return result, errInvalidRecoveryBundle
	}
	text, err := readVerifiedRecoveryOutput(store, room, hoststate.RecoveryText, m.TextPath, m.TextHash, expectedText)
	if err != nil {
		return result, err
	}
	comments, err := readVerifiedRecoveryOutput(store, room, hoststate.RecoveryComments, m.CommentsPath, m.CommentsHash, expectedComments)
	if err != nil {
		return result, err
	}
	latest, err := store.Load(room)
	if err != nil || !reflect.DeepEqual(credentials, latest) {
		return result, errInvalidRecoveryBundle
	}
	return recoveryBundleView{Text: text, Comments: comments, TextPath: m.TextPath, CommentsPath: m.CommentsPath, EvidencePath: m.EvidencePath, ManifestPath: path, TailStatus: m.TailStatus, AttachmentStatus: m.AttachmentStatus, CommentsFormat: m.CommentsFormat}, nil
}
