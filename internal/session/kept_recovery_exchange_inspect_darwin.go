//go:build darwin

package session

import (
	"bytes"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"reflect"

	"github.com/piconic-ai/pedit/internal/hoststate"
)

type recoveryExchangeView struct {
	Recovery                             recoveryTransactionView
	Receipt                              string
	TextState, MetadataState             string
	TextDestination, MetadataDestination string
}

// inspectRecoveryExchange observes destinations and retained names only. It
// never swaps, repairs, acknowledges, cuts, or authorizes a subsequent swap.
func inspectRecoveryExchange(store *hoststate.Store, room, receiptPath string) (result recoveryExchangeView, err error) {
	result.Receipt = receiptPath
	result.TextState, result.MetadataState = "uncertain", "uncertain"
	if store == nil {
		return result, errors.New("recovery store unavailable")
	}
	if err = store.SyncCandidateDirectory(); err != nil {
		return result, err
	}
	credentials, err := store.Load(room)
	if err != nil {
		return result, err
	}
	receipt, err := readRecoveryStageReceipt(store, room, receiptPath, credentials)
	if err != nil {
		return result, err
	}
	journalRaw, err := store.ReadCandidate(room, receipt.Journal)
	if err != nil || recoveryBundleHash(journalRaw) != receipt.JournalHash {
		return result, errors.New("recovery journal changed")
	}
	j, err := readRecoveryTransaction(store, room, receipt.Journal, credentials)
	if err != nil {
		return result, err
	}
	encoded, err := json.Marshal(j)
	if err != nil || !bytes.Equal(encoded, journalRaw) {
		return result, errors.New("recovery journal changed")
	}
	raw, err := store.ReadCandidate(room, j.IntentPath)
	if err != nil || recoveryBundleHash(raw) != j.IntentHash {
		return result, errors.New("recovery intent changed")
	}
	intent, err := verifyRecoveryIntentBytes(raw, room, credentials)
	if err != nil || !validTransactionNames(j, intent) {
		return result, errors.New("invalid recovery intent")
	}
	result.TextDestination = intent.File
	result.MetadataDestination = filepath.Join(intent.Project, metaDir, mustRelative(intent.Project, intent.File)+".json")
	result.Recovery = recoveryTransactionView{Journal: receipt.Journal, Intent: recoveryIntentResult{IntentPath: j.IntentPath, BundlePath: intent.BundlePath, EvidencePath: intent.EvidencePath, TextPath: intent.TextPath, CommentsPath: intent.CommentsPath}, TextStage: j.TextStage, TextRetained: j.TextRetained, MetadataStage: j.MetadataStage, MetadataRetained: j.MetadataRetained, State: "uncertain"}
	if err = verifyExchangeCandidate(store, room, j, intent, credentials); err != nil {
		return result, err
	}
	result.TextState, result.MetadataState, err = observeExchangeFiles(j, intent, receipt)
	if err != nil {
		return result, err
	}
	latest, err := store.Load(room)
	if err != nil || !reflect.DeepEqual(latest, credentials) {
		result.TextState, result.MetadataState = "uncertain", "uncertain"
		return result, errors.New("recovery credentials changed")
	}
	return result, nil
}

func verifyExchangeCandidate(store *hoststate.Store, room string, j recoveryTransaction, intent recoveryIntent, credentials hoststate.Credentials) error {
	if err := verifyIntentBundle(store, room, intent, credentials); err != nil || !bytes.Equal(j.Text, intent.NewText) {
		return errors.New("recovery candidate changed")
	}
	verified, err := verifyRecoveryBundle(store, room, intent.BundlePath)
	if err != nil || !reflect.DeepEqual(verified.credentials, credentials) || !bytes.Equal(verified.view.Text, j.Text) || !bytes.Equal(verified.evidence.Comments, intent.CommentsYjs) {
		return errors.New("recovery evidence changed")
	}
	baseline, err := loadKeptInitial(credentials)
	if err != nil || intent.File != baseline.File || intent.Project != baseline.Project || intent.BaselineText != baseline.Text || intent.BaselineComments != baseline.Comments || intent.BaselineCommentsExists != baseline.CommentsExists {
		return errors.New("recovery baseline changed")
	}
	metadata, err := renderVerifiedRecoveryMetadata(verified, j.Text)
	if err != nil || !bytes.Equal(metadata, j.Metadata) {
		return errors.New("recovery metadata changed")
	}
	return nil
}

func observeExchangeFiles(j recoveryTransaction, intent recoveryIntent, r recoveryStageReceipt) (string, string, error) {
	textDir, err := openStageDirectory(filepath.Dir(intent.File), intent.Target.Directory)
	if err != nil {
		return "uncertain", "uncertain", err
	}
	defer textDir.Close()
	metaDir, err := openStageDirectory(filepath.Dir(j.MetadataStage), intent.Target.MetadataDirectory)
	if err != nil {
		return "uncertain", "uncertain", err
	}
	defer metaDir.Close()
	text, err := observeExchangeFile(textDir, filepath.Base(intent.File), filepath.Base(j.TextStage), filepath.Base(j.TextRetained), intent.Target.Text, r.TextStage, []byte(intent.BaselineText), j.Text)
	if err != nil {
		return "conflict", "uncertain", err
	}
	name := filepath.Base(mustRelative(intent.Project, intent.File)) + ".json"
	metadata, err := observeExchangeFile(metaDir, name, filepath.Base(j.MetadataStage), filepath.Base(j.MetadataRetained), intent.Target.Metadata, r.MetadataStage, []byte(intent.BaselineComments), j.Metadata)
	if err != nil {
		return text, "conflict", err
	}
	return text, metadata, nil
}

func observeExchangeFile(dir *os.File, name, stage, retained string, oldID, newID recoveryObjectID, old, new []byte) (string, error) {
	if err := inspectPreparedStage(dir, retained, oldID, old, true); err != nil {
		return "conflict", err
	}
	state := "conflict"
	if inspectPreparedStage(dir, name, oldID, old, true) == nil && inspectPreparedStage(dir, stage, newID, new, false) == nil {
		state = "old"
	} else if inspectPreparedStage(dir, name, newID, new, false) == nil && inspectPreparedStage(dir, stage, oldID, old, true) == nil {
		state = "new"
	}
	if state == "conflict" {
		return state, errors.New("recovery file state uncertain")
	}
	if err := inspectPreparedStage(dir, retained, oldID, old, true); err != nil {
		return "conflict", err
	}
	return state, nil
}
