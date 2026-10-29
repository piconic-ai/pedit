//go:build darwin

package session

import (
	"bytes"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"reflect"

	"github.com/piconic-ai/pedit/internal/hoststate"
)

const recoveryTransactionDomain = "pedit/v6/recovery-transaction\x00"

type recoveryTransaction struct {
	Kind             string `json:"kind"`
	Version          int    `json:"version"`
	Room             string `json:"room"`
	IntentPath       string `json:"intentPath"`
	IntentHash       string `json:"intentHash"`
	Text             []byte `json:"text"`
	Metadata         []byte `json:"metadata"`
	TextStage        string `json:"textStage"`
	TextRetained     string `json:"textRetained"`
	MetadataStage    string `json:"metadataStage"`
	MetadataRetained string `json:"metadataRetained"`
	Signature        []byte `json:"signature"`
}

type recoveryTransactionView struct {
	Intent                                                   recoveryIntentResult
	Journal                                                  string
	TextStage, TextRetained, MetadataStage, MetadataRetained string
	State                                                    string
}

func recoveryTransactionMessage(j recoveryTransaction) ([]byte, error) {
	j.Signature = nil
	raw, err := json.Marshal(j)
	if err != nil {
		return nil, err
	}
	return append([]byte(recoveryTransactionDomain), raw...), nil
}

// prepareRecoveryTransaction records names and exact candidate bytes only.
// It does not create destination artifacts, exchange files, or modify relay state.
func prepareRecoveryTransaction(store *hoststate.Store, room, intentPath string) (result recoveryTransactionView, err error) {
	view, metadata, err := recoveryMetadata(store, room, intentPath)
	result.Intent = view.Paths
	if err != nil {
		return result, err
	}
	rawIntent, err := store.ReadCandidate(room, intentPath)
	if err != nil {
		return result, err
	}
	credentials, err := store.Load(room)
	if err != nil {
		return result, err
	}
	intent, err := verifyRecoveryIntentBytes(rawIntent, room, credentials)
	if err != nil || !bytes.Equal(intent.NewText, view.NewText) || !bytes.Equal(intent.CommentsYjs, view.CommentsYjs) {
		return result, errors.New("recovery intent changed")
	}
	var random [16]byte
	if _, err = rand.Read(random[:]); err != nil {
		return result, err
	}
	suffix := hex.EncodeToString(random[:])
	textDir := filepath.Dir(intent.File)
	metaDir := filepath.Join(intent.Project, metaDir, filepath.Dir(mustRelative(intent.Project, intent.File)))
	j := recoveryTransaction{Kind: "recovery-transaction", Version: 1, Room: room, IntentPath: intentPath, IntentHash: recoveryBundleHash(rawIntent), Text: bytes.Clone(view.NewText), Metadata: bytes.Clone(metadata), TextStage: filepath.Join(textDir, ".pedit-stage-"+suffix), TextRetained: filepath.Join(textDir, ".pedit-retained-"+suffix), MetadataStage: filepath.Join(metaDir, ".pedit-stage-"+suffix), MetadataRetained: filepath.Join(metaDir, ".pedit-retained-"+suffix)}
	result.TextStage, result.TextRetained = j.TextStage, j.TextRetained
	result.MetadataStage, result.MetadataRetained = j.MetadataStage, j.MetadataRetained
	_, signer, err := credentials.Keys()
	if err != nil {
		return result, err
	}
	message, err := recoveryTransactionMessage(j)
	if err != nil {
		return result, err
	}
	j.Signature = ed25519.Sign(signer, message)
	encoded, err := json.Marshal(j)
	if err != nil {
		return result, err
	}
	result.Journal, err = store.PublishCandidate(room, encoded)
	if err != nil {
		return result, err
	}
	return inspectRecoveryTransaction(store, room, result.Journal)
}

func mustRelative(project, file string) string { rel, _ := filepath.Rel(project, file); return rel }

// inspectRecoveryTransaction never modifies the targets or reserved names.
// A matching baseline is merely an observation and does not authorize a write.
func inspectRecoveryTransaction(store *hoststate.Store, room, path string) (recoveryTransactionView, error) {
	if store == nil {
		return recoveryTransactionView{Journal: path}, errors.New("recovery store unavailable")
	}
	return inspectRecoveryTransactionWithSync(store, room, path, store.SyncCandidateDirectory)
}

func inspectRecoveryTransactionWithSync(store *hoststate.Store, room, path string, syncDirectory func() error) (result recoveryTransactionView, err error) {
	result.Journal = path
	if err = syncDirectory(); err != nil {
		return result, err
	}
	credentials, err := store.Load(room)
	if err != nil {
		return result, err
	}
	j, err := readRecoveryTransaction(store, room, path, credentials)
	if err != nil {
		return result, err
	}
	raw, err := store.ReadCandidate(room, j.IntentPath)
	if err != nil || recoveryBundleHash(raw) != j.IntentHash {
		return result, errors.New("recovery intent unavailable")
	}
	intent, err := verifyRecoveryIntentBytes(raw, room, credentials)
	if err != nil {
		return result, err
	}
	result.Intent = recoveryIntentResult{IntentPath: j.IntentPath, BundlePath: intent.BundlePath, EvidencePath: intent.EvidencePath, TextPath: intent.TextPath, CommentsPath: intent.CommentsPath}
	if err = verifyIntentBundle(store, room, intent, credentials); err != nil || !bytes.Equal(j.Text, intent.NewText) {
		return result, errors.New("recovery candidate changed")
	}
	baseline, err := loadKeptInitial(credentials)
	if err != nil {
		return result, err
	}
	if intent.File != baseline.File || intent.Project != baseline.Project || intent.BaselineText != baseline.Text || intent.BaselineComments != baseline.Comments || intent.BaselineCommentsExists != baseline.CommentsExists {
		return result, errors.New("recovery baseline changed")
	}
	if !validTransactionNames(j, intent) {
		return result, errors.New("invalid recovery artifact names")
	}
	result.TextStage, result.TextRetained, result.MetadataStage, result.MetadataRetained = j.TextStage, j.TextRetained, j.MetadataStage, j.MetadataRetained
	result.State = "conflict"
	current, err := inspectRecoveryTarget(baseline)
	if err != nil || current != intent.Target {
		return result, errors.New("recovery target changed")
	}
	verifiedView, metadata, metadataErr := recoveryMetadata(store, room, j.IntentPath)
	if metadataErr != nil || !bytes.Equal(metadata, j.Metadata) || !bytes.Equal(verifiedView.NewText, j.Text) {
		return result, errors.New("recovery metadata changed")
	}
	if err = checkTransactionNamesAvailable(j); err != nil {
		return result, err
	}
	latest, err := store.Load(room)
	if err != nil || !reflect.DeepEqual(latest, credentials) {
		return result, errors.New("recovery credentials changed")
	}
	result.State = "baseline-observed"
	return result, nil
}

func readRecoveryTransaction(store *hoststate.Store, room, path string, credentials hoststate.Credentials) (j recoveryTransaction, err error) {
	encoded, err := store.ReadCandidate(room, path)
	if err != nil {
		return j, err
	}
	if json.Unmarshal(encoded, &j) != nil {
		return j, errors.New("invalid recovery transaction")
	}
	canonical, err := json.Marshal(j)
	if err != nil || !bytes.Equal(canonical, encoded) || j.Kind != "recovery-transaction" || j.Version != 1 || j.Room != room {
		return j, errors.New("invalid recovery transaction")
	}
	keys, _, err := credentials.Keys()
	if err != nil {
		return j, err
	}
	message, err := recoveryTransactionMessage(j)
	if err != nil || len(j.Signature) != ed25519.SignatureSize || !ed25519.Verify(keys.HostKey, message, j.Signature) {
		return j, errors.New("invalid recovery transaction signature")
	}
	return j, nil
}

func checkTransactionNamesAvailable(j recoveryTransaction) error {
	for _, p := range []string{j.TextStage, j.TextRetained, j.MetadataStage, j.MetadataRetained} {
		if _, err := os.Lstat(p); err == nil || !errors.Is(err, os.ErrNotExist) {
			return errors.New("reserved recovery name unavailable")
		}
	}
	return nil
}

func validTransactionNames(j recoveryTransaction, intent recoveryIntent) bool {
	textDir := filepath.Dir(intent.File)
	metadataDir := filepath.Join(intent.Project, metaDir, filepath.Dir(mustRelative(intent.Project, intent.File)))
	base := filepath.Base(j.TextStage)
	const prefix = ".pedit-stage-"
	if len(base) != len(prefix)+32 || base[:len(prefix)] != prefix {
		return false
	}
	suffix := base[len(prefix):]
	raw, err := hex.DecodeString(suffix)
	if err != nil || len(raw) != 16 || hex.EncodeToString(raw) != suffix {
		return false
	}
	return j.TextStage == filepath.Join(textDir, prefix+suffix) && j.TextRetained == filepath.Join(textDir, ".pedit-retained-"+suffix) && j.MetadataStage == filepath.Join(metadataDir, prefix+suffix) && j.MetadataRetained == filepath.Join(metadataDir, ".pedit-retained-"+suffix)
}
