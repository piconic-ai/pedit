//go:build darwin

package session

import (
	"bytes"
	"crypto/ed25519"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
	"reflect"

	"github.com/piconic-ai/pedit/internal/hoststate"
	"github.com/piconic-ai/pedit/internal/protocol"
	"golang.org/x/sys/unix"
)

const recoveryStageDomain = "pedit/v6/recovery-stage\x00"

type recoveryStageReceipt struct {
	Kind          string           `json:"kind"`
	Version       int              `json:"version"`
	Room          string           `json:"room"`
	Journal       string           `json:"journal"`
	JournalHash   string           `json:"journalHash"`
	TextStage     recoveryObjectID `json:"textStage"`
	MetadataStage recoveryObjectID `json:"metadataStage"`
	Signature     []byte           `json:"signature"`
}

type recoveryStageResult struct {
	Recovery recoveryTransactionView
	Receipt  string
	State    string
}

func recoveryStageMessage(r recoveryStageReceipt) ([]byte, error) {
	r.Signature = nil
	b, err := json.Marshal(r)
	if err != nil {
		return nil, err
	}
	return append([]byte(recoveryStageDomain), b...), nil
}

// prepareRecoveryStages creates retained names and private candidate files but
// never exchanges, removes, or writes to an original destination.
func prepareRecoveryStages(store *hoststate.Store, room, journal string, hook func(string)) (result recoveryStageResult, err error) {
	journalOriginal, err := readStageJournal(store, room, journal)
	if err != nil {
		return result, err
	}
	result.Recovery, err = inspectRecoveryTransaction(store, room, journal)
	if err != nil {
		return result, err
	}
	result.State = "uncertain"
	journalAfter, err := store.ReadCandidate(room, journal)
	if err != nil || !bytes.Equal(journalOriginal, journalAfter) {
		return result, errors.New("journal changed")
	}
	credentials, err := store.Load(room)
	if err != nil {
		return result, err
	}
	j, err := readRecoveryTransaction(store, room, journal, credentials)
	if err != nil {
		return result, err
	}
	journalChecked, err := json.Marshal(j)
	if err != nil || !bytes.Equal(journalOriginal, journalChecked) {
		return result, errors.New("journal changed")
	}
	rawIntent, err := store.ReadCandidate(room, j.IntentPath)
	if err != nil {
		return result, err
	}
	intent, err := verifyRecoveryIntentBytes(rawIntent, room, credentials)
	if err != nil {
		return result, err
	}
	if recoveryBundleHash(rawIntent) != j.IntentHash {
		return result, errors.New("intent changed")
	}
	textID, metaID, err := prepareStageFiles(j, intent, hook)
	if err != nil {
		return result, err
	}
	if _, err = openRecoveryIntent(store, room, j.IntentPath); err != nil {
		return result, err
	}
	latest, err := store.Load(room)
	if err != nil || !reflect.DeepEqual(latest, credentials) {
		return result, errors.New("credentials changed")
	}
	journalRaw, err := store.ReadCandidate(room, journal)
	if err != nil || !bytes.Equal(journalRaw, journalOriginal) {
		return result, errors.New("journal changed")
	}
	result.Receipt, err = publishRecoveryStageReceipt(store, room, journal, journalRaw, credentials, textID, metaID)
	if err != nil {
		return result, err
	}
	if hook != nil {
		hook("receipt")
	}
	inspected, err := inspectRecoveryStages(store, room, result.Receipt)
	if err != nil {
		return result, err
	}
	return inspected, nil
}

func readStageJournal(store *hoststate.Store, room, journal string) ([]byte, error) {
	if store == nil {
		return nil, errors.New("recovery store unavailable")
	}
	return store.ReadCandidate(room, journal)
}

func publishRecoveryStageReceipt(store *hoststate.Store, room, journal string, journalRaw []byte, credentials hoststate.Credentials, textID, metaID recoveryObjectID) (string, error) {
	r := recoveryStageReceipt{Kind: "recovery-stage", Version: 1, Room: room, Journal: journal, JournalHash: recoveryBundleHash(journalRaw), TextStage: textID, MetadataStage: metaID}
	_, signer, err := credentials.Keys()
	if err != nil {
		return "", err
	}
	message, err := recoveryStageMessage(r)
	if err != nil {
		return "", err
	}
	r.Signature = ed25519.Sign(signer, message)
	encoded, err := json.Marshal(r)
	if err != nil {
		return "", err
	}
	path, err := store.PublishCandidate(room, encoded)
	return path, err
}

func prepareStageFiles(j recoveryTransaction, intent recoveryIntent, hook func(string)) (recoveryObjectID, recoveryObjectID, error) {
	textDir, err := openStageDirectory(filepath.Dir(intent.File), intent.Target.Directory)
	if err != nil {
		return recoveryObjectID{}, recoveryObjectID{}, err
	}
	defer textDir.Close()
	if !intent.BaselineCommentsExists {
		return recoveryObjectID{}, recoveryObjectID{}, errors.New("missing metadata directory unsupported")
	}
	metaDirPath := filepath.Dir(j.MetadataStage)
	metadataDir, err := openStageDirectory(metaDirPath, intent.Target.MetadataDirectory)
	if err != nil {
		return recoveryObjectID{}, recoveryObjectID{}, err
	}
	defer metadataDir.Close()
	textID, err := prepareStageFile(textDir, filepath.Base(j.TextStage), j.Text, hook)
	if err != nil {
		return recoveryObjectID{}, recoveryObjectID{}, err
	}
	metaID, err := prepareStageFile(metadataDir, filepath.Base(j.MetadataStage), j.Metadata, hook)
	if err != nil {
		return recoveryObjectID{}, recoveryObjectID{}, err
	}
	if err = retainStageOriginal(textDir, filepath.Base(intent.File), filepath.Base(j.TextRetained), intent.Target.Text, []byte(intent.BaselineText), hook); err != nil {
		return recoveryObjectID{}, recoveryObjectID{}, err
	}
	metaName := filepath.Base(mustRelative(intent.Project, intent.File)) + ".json"
	if err = retainStageOriginal(metadataDir, metaName, filepath.Base(j.MetadataRetained), intent.Target.Metadata, []byte(intent.BaselineComments), hook); err != nil {
		return recoveryObjectID{}, recoveryObjectID{}, err
	}
	return textID, metaID, nil
}

func openStageDirectory(path string, expected recoveryObjectID) (*os.File, error) {
	d, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	fail := func() (*os.File, error) { d.Close(); return nil, errors.New("recovery directory changed or unsafe") }
	if hoststate.CheckPrivateDirectory(d) != nil {
		return fail()
	}
	current, err := os.Lstat(path)
	if err != nil || !current.IsDir() {
		return fail()
	}
	opened, err := d.Stat()
	if err != nil || !os.SameFile(current, opened) {
		return fail()
	}
	id, err := objectID(d)
	if err != nil || id != expected {
		return fail()
	}
	return d, nil
}

func prepareStageFile(dir *os.File, name string, data []byte, hook func(string)) (recoveryObjectID, error) {
	var zero recoveryObjectID
	fd, err := unix.Openat(int(dir.Fd()), name, unix.O_RDWR|unix.O_CREAT|unix.O_EXCL|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0600)
	if err != nil {
		return zero, err
	}
	f := os.NewFile(uintptr(fd), name)
	defer f.Close()
	if hook != nil {
		hook("stage-created")
	}
	if err = hoststate.PreparePrivateFile(f); err != nil {
		return zero, err
	}
	if _, err = f.Write(data); err != nil {
		return zero, err
	}
	if hook != nil {
		hook("stage-written")
	}
	if err = hoststate.SyncPrivateFile(f); err != nil {
		return zero, err
	}
	if err = hoststate.SyncDirectory(dir); err != nil {
		return zero, err
	}
	return objectID(f)
}

func retainStageOriginal(dir *os.File, name, retained string, expected recoveryObjectID, baseline []byte, hook func(string)) error {
	fd, err := unix.Openat(int(dir.Fd()), name, unix.O_RDONLY|unix.O_NONBLOCK|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0)
	if err != nil {
		return err
	}
	f := os.NewFile(uintptr(fd), name)
	defer f.Close()
	if hoststate.CheckPrivateFile(f) != nil {
		return errors.New("unsafe original file")
	}
	id, err := objectID(f)
	if err != nil || id != expected {
		return errors.New("original changed")
	}
	data, err := io.ReadAll(io.LimitReader(f, protocol.MaxFrameBytes+1))
	if err != nil || !bytes.Equal(data, baseline) {
		return errors.New("original content changed")
	}
	if err = unix.Linkat(int(dir.Fd()), name, int(dir.Fd()), retained, 0); err != nil {
		return err
	}
	if hook != nil {
		hook("retained-linked")
	}
	retainedFD, err := unix.Openat(int(dir.Fd()), retained, unix.O_RDONLY|unix.O_NONBLOCK|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0)
	if err != nil {
		return err
	}
	retainedFile := os.NewFile(uintptr(retainedFD), retained)
	defer retainedFile.Close()
	retainedID, err := objectID(retainedFile)
	if err != nil || retainedID != id || hoststate.CheckPrivateRetainedFile(retainedFile) != nil {
		return errors.New("retained inode changed")
	}
	if err = hoststate.SyncDirectory(dir); err != nil {
		return err
	}
	return nil
}

func inspectRecoveryStages(store *hoststate.Store, room, receiptPath string) (result recoveryStageResult, err error) {
	result.Receipt = receiptPath
	result.State = "uncertain"
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
		return result, errors.New("journal changed")
	}
	j, err := readRecoveryTransaction(store, room, receipt.Journal, credentials)
	if err != nil {
		return result, err
	}
	intentRaw, err := store.ReadCandidate(room, j.IntentPath)
	if err != nil || recoveryBundleHash(intentRaw) != j.IntentHash {
		return result, errors.New("intent changed")
	}
	intent, err := verifyRecoveryIntentBytes(intentRaw, room, credentials)
	if err != nil || !validTransactionNames(j, intent) {
		return result, errors.New("invalid intent")
	}
	result.Recovery = recoveryTransactionView{Journal: receipt.Journal, Intent: recoveryIntentResult{IntentPath: j.IntentPath, BundlePath: intent.BundlePath, EvidencePath: intent.EvidencePath, TextPath: intent.TextPath, CommentsPath: intent.CommentsPath}, TextStage: j.TextStage, TextRetained: j.TextRetained, MetadataStage: j.MetadataStage, MetadataRetained: j.MetadataRetained, State: "conflict"}
	view, metadata, err := recoveryMetadata(store, room, j.IntentPath)
	if err != nil || !bytes.Equal(view.NewText, j.Text) || !bytes.Equal(metadata, j.Metadata) {
		return result, errors.New("candidate or target changed")
	}
	if err = inspectStageFiles(j, intent, receipt); err != nil {
		return result, err
	}
	if _, err = openRecoveryIntent(store, room, j.IntentPath); err != nil {
		return result, err
	}
	latest, err := store.Load(room)
	if err != nil || !reflect.DeepEqual(latest, credentials) {
		return result, errors.New("credentials changed")
	}
	result.State = "prepared"
	result.Recovery.State = "prepared"
	return result, nil
}

func inspectStageFiles(j recoveryTransaction, intent recoveryIntent, receipt recoveryStageReceipt) error {
	textDir, err := openStageDirectory(filepath.Dir(intent.File), intent.Target.Directory)
	if err != nil {
		return err
	}
	defer textDir.Close()
	metaDir, err := openStageDirectory(filepath.Dir(j.MetadataStage), intent.Target.MetadataDirectory)
	if err != nil {
		return err
	}
	defer metaDir.Close()
	if err = inspectPreparedStage(textDir, filepath.Base(j.TextStage), receipt.TextStage, j.Text, false); err != nil {
		return err
	}
	if err = inspectPreparedStage(metaDir, filepath.Base(j.MetadataStage), receipt.MetadataStage, j.Metadata, false); err != nil {
		return err
	}
	if err = inspectPreparedStage(textDir, filepath.Base(j.TextRetained), intent.Target.Text, []byte(intent.BaselineText), true); err != nil {
		return err
	}
	if err = inspectPreparedStage(metaDir, filepath.Base(j.MetadataRetained), intent.Target.Metadata, []byte(intent.BaselineComments), true); err != nil {
		return err
	}
	if err = hoststate.SyncDirectory(textDir); err != nil {
		return err
	}
	if err = hoststate.SyncDirectory(metaDir); err != nil {
		return err
	}
	return nil
}

func readRecoveryStageReceipt(store *hoststate.Store, room, path string, credentials hoststate.Credentials) (receipt recoveryStageReceipt, err error) {
	raw, err := store.ReadCandidate(room, path)
	if err != nil {
		return receipt, err
	}
	if json.Unmarshal(raw, &receipt) != nil {
		return receipt, errors.New("invalid stage receipt")
	}
	canonical, err := json.Marshal(receipt)
	if err != nil || !bytes.Equal(canonical, raw) || receipt.Kind != "recovery-stage" || receipt.Version != 1 || receipt.Room != room {
		return receipt, errors.New("invalid stage receipt")
	}
	keys, _, err := credentials.Keys()
	if err != nil {
		return receipt, err
	}
	msg, err := recoveryStageMessage(receipt)
	if err != nil || len(receipt.Signature) != ed25519.SignatureSize || !ed25519.Verify(keys.HostKey, msg, receipt.Signature) {
		return receipt, errors.New("invalid stage receipt signature")
	}
	return receipt, nil
}

func inspectPreparedStage(dir *os.File, name string, expected recoveryObjectID, want []byte, retained bool) error {
	fd, err := unix.Openat(int(dir.Fd()), name, unix.O_RDONLY|unix.O_NONBLOCK|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0)
	if err != nil {
		return err
	}
	f := os.NewFile(uintptr(fd), name)
	defer f.Close()
	if retained {
		err = hoststate.CheckPrivateRetainedFile(f)
	} else {
		err = hoststate.CheckPrivateFile(f)
	}
	if err != nil {
		return err
	}
	id, err := objectID(f)
	if err != nil || id != expected {
		return errors.New("prepared inode changed")
	}
	data, err := io.ReadAll(io.LimitReader(f, protocol.MaxFrameBytes+1))
	if err != nil || !bytes.Equal(data, want) {
		return errors.New("prepared bytes changed")
	}
	var named unix.Stat_t
	if unix.Fstatat(int(dir.Fd()), name, &named, unix.AT_SYMLINK_NOFOLLOW) != nil || named.Mode&unix.S_IFMT != unix.S_IFREG || uint64(named.Dev) != expected.Device || named.Ino != expected.Inode {
		return errors.New("prepared path changed")
	}
	return nil
}
