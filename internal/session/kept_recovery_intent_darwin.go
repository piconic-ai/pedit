//go:build darwin

package session

import (
	"bytes"
	"crypto/ed25519"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"strings"

	"github.com/piconic-ai/pedit/internal/filewriter"
	"github.com/piconic-ai/pedit/internal/hoststate"
	"github.com/piconic-ai/pedit/internal/protocol"
	"golang.org/x/sys/unix"
)

const recoveryIntentDomain = "pedit/v6/recovery-intent\x00"

type recoveryObjectID struct {
	Device uint64 `json:"device"`
	Inode  uint64 `json:"inode"`
}
type recoveryTarget struct {
	Project           recoveryObjectID `json:"project"`
	Directory         recoveryObjectID `json:"directory"`
	Text              recoveryObjectID `json:"text"`
	MetadataExists    bool             `json:"metadataExists"`
	MetadataDirectory recoveryObjectID `json:"metadataDirectory"`
	Metadata          recoveryObjectID `json:"metadata"`
}
type recoveryIntent struct {
	Kind                   string         `json:"kind"`
	Version                int            `json:"version"`
	Room                   string         `json:"room"`
	Generation             uint64         `json:"generation"`
	Epoch                  [32]byte       `json:"epoch"`
	Tail                   uint64         `json:"tail"`
	BundlePath             string         `json:"bundlePath"`
	BundleHash             string         `json:"bundleHash"`
	EvidenceHash           string         `json:"evidenceHash"`
	EvidencePath           string         `json:"evidencePath"`
	TextPath               string         `json:"textPath"`
	CommentsPath           string         `json:"commentsPath"`
	File                   string         `json:"file"`
	Project                string         `json:"project"`
	Target                 recoveryTarget `json:"target"`
	BaselineText           string         `json:"baselineText"`
	BaselineCommentsExists bool           `json:"baselineCommentsExists"`
	BaselineComments       string         `json:"baselineComments"`
	NewText                []byte         `json:"newText"`
	CommentsYjs            []byte         `json:"commentsYjs"`
	State                  string         `json:"state"`
	Signature              []byte         `json:"signature"`
}
type recoveryIntentResult struct {
	IntentPath, BundlePath, EvidencePath, TextPath, CommentsPath string
}
type recoveryIntentView struct {
	Paths                                        recoveryIntentResult
	BaselineText                                 string
	NewText, CommentsYjs                         []byte
	MetadataStatus, TailStatus, AttachmentStatus string
}

func intentMessage(intent recoveryIntent) ([]byte, error) {
	intent.Signature = nil
	raw, err := json.Marshal(intent)
	if err != nil {
		return nil, err
	}
	return append([]byte(recoveryIntentDomain), raw...), nil
}
func objectID(f *os.File) (recoveryObjectID, error) {
	var st unix.Stat_t
	if err := unix.Fstat(int(f.Fd()), &st); err != nil {
		return recoveryObjectID{}, err
	}
	return recoveryObjectID{Device: uint64(st.Dev), Inode: st.Ino}, nil
}
func rootObjectID(root *os.Root) (recoveryObjectID, error) {
	f, err := root.Open(".")
	if err != nil {
		return recoveryObjectID{}, err
	}
	defer f.Close()
	return objectID(f)
}
func inspectRecoveryBound(bound *filewriter.BoundFile, name, absolute, expected string) (recoveryObjectID, error) {
	var none recoveryObjectID
	before, err := bound.Dir().Lstat(name)
	if err != nil || !before.Mode().IsRegular() {
		return none, errors.New("recovery target unavailable")
	}
	absoluteInfo, err := os.Lstat(absolute)
	if err != nil || !os.SameFile(before, absoluteInfo) {
		return none, errors.New("recovery target changed")
	}
	f, err := bound.Dir().Open(name)
	if err != nil {
		return none, err
	}
	defer f.Close()
	opened, err := f.Stat()
	if err != nil || !os.SameFile(before, opened) {
		return none, errors.New("recovery target changed")
	}
	id, err := objectID(f)
	if err != nil {
		return none, err
	}
	value, ok := bound.ReadLimited(protocol.MaxFrameBytes)
	if !ok || value != expected {
		return none, errors.New("recovery target conflict")
	}
	after, err := bound.Dir().Lstat(name)
	if err != nil || !os.SameFile(before, after) {
		return none, errors.New("recovery target changed")
	}
	absoluteInfo, err = os.Lstat(absolute)
	if err != nil || !os.SameFile(before, absoluteInfo) {
		return none, errors.New("recovery target changed")
	}
	return id, nil
}

func openRecoveryTargetDirectory(root *os.Root, rel string) (*os.Root, error) {
	current := root
	for _, part := range strings.Split(filepath.ToSlash(filepath.Dir(rel)), "/") {
		if part == "." {
			continue
		}
		next, err := openRealDir(current, part, false)
		if current != root {
			current.Close()
		}
		if err != nil {
			return nil, err
		}
		current = next
	}
	if current == root {
		return root.OpenRoot(".")
	}
	return current, nil
}

func inspectRecoveryTarget(baseline keptInitialRecord) (recoveryTarget, error) {
	var target recoveryTarget
	root, err := os.OpenRoot(baseline.Project)
	if err != nil {
		return target, err
	}
	defer root.Close()
	current, err := os.Lstat(baseline.Project)
	if err != nil || !current.IsDir() {
		return target, errors.New("recovery project unavailable")
	}
	opened, err := root.Stat(".")
	if err != nil || !os.SameFile(current, opened) {
		return target, errors.New("recovery project changed")
	}
	if target.Project, err = rootObjectID(root); err != nil {
		return target, err
	}
	rel, err := filepath.Rel(baseline.Project, baseline.File)
	if err != nil || !filepath.IsLocal(rel) {
		return target, errors.New("invalid recovery path")
	}
	dir, err := openRecoveryTargetDirectory(root, rel)
	if err != nil {
		return target, err
	}
	defer dir.Close()
	current, err = os.Lstat(filepath.Dir(baseline.File))
	if err != nil || !current.IsDir() {
		return target, errors.New("recovery directory unavailable")
	}
	opened, err = dir.Stat(".")
	if err != nil || !os.SameFile(current, opened) {
		return target, errors.New("recovery directory changed")
	}
	if target.Directory, err = rootObjectID(dir); err != nil {
		return target, err
	}
	bound, err := filewriter.OpenBoundIn(dir, filepath.Base(rel))
	if err != nil {
		return target, err
	}
	defer bound.Close()
	if target.Text, err = inspectRecoveryBound(bound, filepath.Base(rel), baseline.File, baseline.Text); err != nil {
		return target, err
	}
	return inspectRecoveryMetadata(root, rel, baseline, target)
}

func inspectRecoveryMetadata(root *os.Root, rel string, baseline keptInitialRecord, target recoveryTarget) (recoveryTarget, error) {
	var err error
	metadataName := filepath.Join(metaDir, rel+".json")
	metadataPath := filepath.Join(baseline.Project, metadataName)
	if !baseline.CommentsExists {
		absent := &keptInitial{project: root, metadata: metadataPath, metaName: metadataName}
		if err = absent.verifyMetadataAbsent(); err != nil {
			return target, err
		}
		return target, nil
	}
	metadata, err := openMetaFile(root, metadataName, false)
	if err != nil {
		return target, err
	}
	defer metadata.Close()
	target.MetadataExists = true
	if target.MetadataDirectory, err = rootObjectID(metadata.Dir()); err != nil {
		return target, err
	}
	if target.Metadata, err = inspectRecoveryBound(metadata, filepath.Base(metadataName), metadataPath, baseline.Comments); err != nil {
		return target, err
	}
	return target, nil
}

// prepareRecoveryIntent only records a proposal. It never modifies the
// destination, writes metadata, acknowledges records, or cuts the relay log.
// On error every nonempty returned path may name a retained artifact.
func prepareRecoveryIntent(store *hoststate.Store, room, bundlePath string) (recoveryIntentResult, error) {
	return prepareRecoveryIntentWithHook(store, room, bundlePath, nil)
}

func prepareRecoveryIntentWithHook(store *hoststate.Store, room, bundlePath string, hook func(string)) (result recoveryIntentResult, err error) {
	result.BundlePath = bundlePath
	if store == nil {
		return result, errors.New("recovery store unavailable")
	}
	verified, err := verifyRecoveryBundle(store, room, bundlePath)
	if err != nil {
		return result, err
	}
	result.EvidencePath = verified.view.EvidencePath
	result.TextPath = verified.view.TextPath
	result.CommentsPath = verified.view.CommentsPath
	baseline, err := loadKeptInitial(verified.credentials)
	if err != nil {
		return result, err
	}
	target, err := inspectRecoveryTarget(baseline)
	if err != nil {
		return result, err
	}
	manifestBytes, err := json.Marshal(verified.manifest)
	if err != nil {
		return result, err
	}
	intent := recoveryIntent{Kind: "recovery-intent", Version: 1, Room: room, Generation: verified.evidence.Generation, Epoch: verified.evidence.Epoch, Tail: verified.evidence.Tail, BundlePath: bundlePath, BundleHash: recoveryBundleHash(manifestBytes), EvidenceHash: verified.manifest.EvidenceHash, EvidencePath: verified.view.EvidencePath, TextPath: verified.view.TextPath, CommentsPath: verified.view.CommentsPath, File: baseline.File, Project: baseline.Project, Target: target, BaselineText: baseline.Text, BaselineCommentsExists: baseline.CommentsExists, BaselineComments: baseline.Comments, NewText: bytes.Clone(verified.view.Text), CommentsYjs: bytes.Clone(verified.evidence.Comments), State: "prepared-not-applied"}
	latest, err := store.Load(room)
	if err != nil || !reflect.DeepEqual(verified.credentials, latest) {
		return result, errors.New("recovery credentials changed")
	}
	_, signer, err := verified.credentials.Keys()
	if err != nil {
		return result, err
	}
	message, err := intentMessage(intent)
	if err != nil {
		return result, err
	}
	intent.Signature = ed25519.Sign(signer, message)
	raw, err := json.Marshal(intent)
	if err != nil {
		return result, err
	}
	if hook != nil {
		hook("before-publish")
	}
	result.IntentPath, err = store.PublishCandidate(room, raw)
	if err != nil {
		return result, err
	}
	if hook != nil {
		hook("published")
	}
	if _, err = openRecoveryIntent(store, room, result.IntentPath); err != nil {
		return result, err
	}
	return result, nil
}

func verifyRecoveryIntentBytes(raw []byte, room string, credentials hoststate.Credentials) (recoveryIntent, error) {
	var intent recoveryIntent
	if json.Unmarshal(raw, &intent) != nil {
		return intent, errors.New("invalid recovery intent")
	}
	canonical, err := json.Marshal(intent)
	if err != nil || !bytes.Equal(canonical, raw) || intent.Kind != "recovery-intent" || intent.Version != 1 || intent.Room != room || intent.Generation != credentials.Generation || intent.State != "prepared-not-applied" {
		return intent, errors.New("invalid recovery intent")
	}
	keys, _, err := credentials.Keys()
	if err != nil {
		return intent, err
	}
	message, err := intentMessage(intent)
	if err != nil || len(intent.Signature) != ed25519.SignatureSize || !ed25519.Verify(keys.HostKey, message, intent.Signature) {
		return intent, errors.New("invalid recovery intent signature")
	}
	return intent, nil
}

func verifyIntentBundle(store *hoststate.Store, room string, intent recoveryIntent, credentials hoststate.Credentials) error {
	m, err := readRecoveryBundleManifest(store, credentials, room, intent.BundlePath)
	if err != nil {
		return err
	}
	manifestBytes, err := json.Marshal(m)
	if err != nil || recoveryBundleHash(manifestBytes) != intent.BundleHash {
		return errors.New("recovery bundle changed")
	}
	if m.EvidencePath != intent.EvidencePath || m.TextPath != intent.TextPath || m.CommentsPath != intent.CommentsPath {
		return errors.New("recovery bundle paths changed")
	}
	verified, err := verifyRecoveryBundle(store, room, intent.BundlePath)
	if err != nil {
		return err
	}
	currentManifest, err := json.Marshal(verified.manifest)
	if err != nil || recoveryBundleHash(currentManifest) != intent.BundleHash || !reflect.DeepEqual(credentials, verified.credentials) {
		return errors.New("recovery bundle changed")
	}
	if verified.manifest.EvidenceHash != intent.EvidenceHash || verified.evidence.Generation != intent.Generation || verified.evidence.Epoch != intent.Epoch || verified.evidence.Tail != intent.Tail || !bytes.Equal(verified.view.Text, intent.NewText) || !bytes.Equal(verified.evidence.Comments, intent.CommentsYjs) {
		return errors.New("recovery intent content mismatch")
	}
	return nil
}

// openRecoveryIntent resynchronizes the directory and revalidates every bound
// byte and target identity. A successful inspection is not permission to save.
func openRecoveryIntent(store *hoststate.Store, room, path string) (result recoveryIntentView, err error) {
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
	raw, err := store.ReadCandidate(room, path)
	if err != nil {
		return result, err
	}
	intent, err := verifyRecoveryIntentBytes(raw, room, credentials)
	if err != nil {
		return result, err
	}
	result.Paths = recoveryIntentResult{IntentPath: path, BundlePath: intent.BundlePath, EvidencePath: intent.EvidencePath, TextPath: intent.TextPath, CommentsPath: intent.CommentsPath}
	if err = verifyIntentBundle(store, room, intent, credentials); err != nil {
		return result, err
	}
	baseline, err := loadKeptInitial(credentials)
	if err != nil {
		return result, err
	}
	if intent.File != baseline.File || intent.Project != baseline.Project || intent.BaselineText != baseline.Text || intent.BaselineCommentsExists != baseline.CommentsExists || intent.BaselineComments != baseline.Comments {
		return result, errors.New("recovery baseline changed")
	}
	result.BaselineText = intent.BaselineText
	result.NewText = bytes.Clone(intent.NewText)
	result.CommentsYjs = bytes.Clone(intent.CommentsYjs)
	result.MetadataStatus = "not-generated"
	result.TailStatus = "unverified"
	result.AttachmentStatus = "unverified"
	target, err := inspectRecoveryTarget(baseline)
	if err != nil || target != intent.Target {
		return result, errors.New("recovery target changed")
	}
	latest, err := store.Load(room)
	if err != nil || !reflect.DeepEqual(credentials, latest) {
		return result, errors.New("recovery credentials changed")
	}
	return result, nil
}
