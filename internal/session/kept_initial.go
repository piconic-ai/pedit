package session

import (
	"bytes"
	"crypto/rand"
	"encoding/json"
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"reflect"

	"github.com/piconic-ai/pedit/internal/filewriter"
	"github.com/piconic-ai/pedit/internal/hoststate"
	"github.com/piconic-ai/pedit/internal/meta"
	"github.com/piconic-ai/pedit/internal/protocol"
	"github.com/reearth/ygo/crdt"
)

// keptInitial owns pinned directories until publication finishes. The caller
// must establish a complete attachment inventory before using its payload.
type keptInitial struct {
	file, metadata         string
	metaName               string
	fileInfo, metadataInfo os.FileInfo
	text, comments         string
	textBound, metaBound   *filewriter.BoundFile
	project                *os.Root
	payload                []byte
}

func (s *keptInitial) Close() {
	if s.metaBound != nil {
		s.metaBound.Close()
	}
	if s.textBound != nil {
		s.textBound.Close()
	}
	if s.project != nil {
		s.project.Close()
	}
}

func captureKeptInitial(file, project string, inventory protocol.KeptAttachmentInventory) (_ *keptInitial, err error) {
	if inventory != protocol.KeptAttachmentsNone || !filepath.IsAbs(file) || filepath.Clean(file) != file || !filepath.IsAbs(project) || filepath.Clean(project) != project || isCanvas(file) {
		return nil, errors.New("unsupported initial file or attachment inventory")
	}
	rel, err := filepath.Rel(project, file)
	if err != nil || !filepath.IsLocal(rel) {
		return nil, errors.New("file outside project")
	}
	path := filepath.ToSlash(rel)
	if err = protocol.CheckPath(path); err != nil {
		return nil, err
	}
	s := &keptInitial{file: file, metadata: filepath.Join(project, metaDir, rel+".json"), metaName: filepath.Join(metaDir, rel+".json")}
	defer func() {
		if err != nil {
			s.Close()
		}
	}()
	s.project, err = os.OpenRoot(project)
	if err != nil {
		return nil, err
	}
	s.fileInfo, err = os.Lstat(file)
	if err != nil || !s.fileInfo.Mode().IsRegular() {
		return nil, errors.New("invalid initial file")
	}
	s.textBound, s.text, err = openShared(file)
	if err != nil {
		return nil, err
	}
	textDoc := crdt.New()
	defer textDoc.Destroy()
	newTextContent(textDoc, s.text)
	commentsDoc := crdt.New()
	defer commentsDoc.Destroy()
	mf, err := s.readMetadata(path)
	if err != nil {
		return nil, err
	}

	meta.Load(commentsDoc, mf, meta.NewTracker(textDoc))
	ledger, err := protocol.NewKeptLedger(protocol.MaxKeptCheckpointReceipts)
	if err != nil {
		return nil, err
	}
	s.payload, err = protocol.EncodeKeptTextPayload(protocol.KeptTextPayload{Manifest: []protocol.FileEntry{{ID: 0, Path: path, Format: protocol.FormatText}, {ID: 1, Path: protocol.MetaPath(path), Format: protocol.FormatMeta}}, Documents: map[uint64][]byte{0: crdt.EncodeStateAsUpdateV1(textDoc, nil), 1: crdt.EncodeStateAsUpdateV1(commentsDoc, nil)}, Ledger: ledger, Attachments: inventory})
	if err != nil {
		return nil, err
	}
	if err = s.verify(); err != nil {
		return nil, err
	}
	return s, nil
}

func (s *keptInitial) readMetadata(path string) (*meta.File, error) {
	bound, err := openMetaFile(s.project, s.metaName, false)
	if errors.Is(err, fs.ErrNotExist) {
		if err = s.verifyMetadataAbsent(); err != nil {
			return nil, err
		}
		return &meta.File{Path: path}, nil
	}
	if err != nil {
		return nil, err
	}
	s.metadataInfo, err = os.Lstat(s.metadata)
	if errors.Is(err, fs.ErrNotExist) {
		bound.Close()
		if err = s.verifyMetadataAbsent(); err != nil {
			return nil, err
		}
		return &meta.File{Path: path}, nil
	}
	s.metaBound = bound
	if err != nil || !s.metadataInfo.Mode().IsRegular() {
		return nil, errors.New("invalid initial metadata")
	}
	var ok bool
	s.comments, ok = s.metaBound.Read()
	if !ok {
		return nil, errors.New("cannot read initial metadata")
	}
	mf, err := meta.Parse([]byte(s.comments))
	if err != nil {
		return nil, err
	}
	if mf.Path != path {
		return nil, errors.New("metadata path differs from shared file")
	}
	return mf, nil
}

// verify rejects changes observed since capture. It is not an atomic lock on
// external editors and cannot by itself authorize a later write or cut.
func (s *keptInitial) verify() error {
	if err := s.verifyProject(); err != nil {
		return err
	}
	info, err := os.Lstat(s.file)
	if err != nil || !os.SameFile(s.fileInfo, info) {
		return errors.New("initial file changed")
	}
	text, ok := s.textBound.Read()
	if !ok || text != s.text {
		return errors.New("initial file changed")
	}
	info, err = os.Lstat(s.metadata)
	if s.metaBound == nil {
		if err := s.verifyMetadataAbsent(); err != nil {
			return err
		}
		return s.verifyProject()
	}
	if err != nil || !os.SameFile(s.metadataInfo, info) {
		return errors.New("initial metadata changed")
	}
	comments, ok := s.metaBound.Read()
	if !ok || comments != s.comments {
		return errors.New("initial metadata changed")
	}
	return s.verifyProject()
}

func (s *keptInitial) verifyMetadataAbsent() error {
	missing := func(err error) bool { return errors.Is(err, fs.ErrNotExist) }
	_, absoluteErr := os.Lstat(s.metadata)
	_, rootErr := s.project.Lstat(s.metaName)
	if !missing(absoluteErr) || !missing(rootErr) {
		return errors.New("initial metadata changed")
	}
	bound, err := openMetaFile(s.project, s.metaName, false)
	if missing(err) {
		return nil
	}
	if err != nil {
		return errors.New("initial metadata changed")
	}
	defer bound.Close()
	_, err = bound.Dir().Lstat(filepath.Base(s.metaName))
	if !missing(err) {
		return errors.New("initial metadata changed")
	}
	return nil
}

func (s *keptInitial) verifyProject() error {
	expected, err := s.project.Stat(".")
	if err != nil {
		return errors.New("initial project changed")
	}
	current, err := os.Lstat(s.project.Name())
	if err != nil || !current.IsDir() || !os.SameFile(expected, current) {
		return errors.New("initial project changed")
	}
	return nil
}

// keptInitialRecord is private until the full recovery path validates it.
// It preserves the original bytes alongside the encrypted checkpoint.
type keptInitialRecord = hoststate.InitialState

func (s *keptInitial) persist(store *hoststate.Store, credentials hoststate.Credentials) (hoststate.Credentials, error) {
	if s == nil || store == nil || credentials.Generation != 1 || credentials.Initial != nil {
		return hoststate.Credentials{}, errors.New("invalid initial state")
	}
	if err := s.verify(); err != nil {
		return hoststate.Credentials{}, err
	}
	keys, signer, err := credentials.Keys()
	if err != nil {
		return hoststate.Credentials{}, err
	}
	var epoch [32]byte
	if _, err = rand.Read(epoch[:]); err != nil {
		return hoststate.Credentials{}, err
	}
	checkpoint, err := protocol.SealKeptCheckpoint(keys, signer, protocol.KeptCheckpointContext{RoomID: credentials.RoomID, Epoch: epoch, Generation: 1}, s.payload)
	if err != nil {
		return hoststate.Credentials{}, err
	}
	record := keptInitialRecord{File: s.file, Project: s.project.Name(), Text: s.text, CommentsExists: s.metaBound != nil, Comments: s.comments, Epoch: epoch, Checkpoint: checkpoint}
	payload, err := json.Marshal(record)
	if err != nil {
		return hoststate.Credentials{}, err
	}
	saved, err := credentials.BindInitial(payload)
	if err != nil {
		return hoststate.Credentials{}, err
	}
	if err = store.Save(saved); err != nil {
		return hoststate.Credentials{}, err
	}
	if err = s.verify(); err != nil {
		return hoststate.Credentials{}, err
	}
	return saved, nil
}

func loadKeptInitial(credentials hoststate.Credentials) (keptInitialRecord, error) {
	keys, _, err := credentials.Keys()
	if err != nil {
		return keptInitialRecord{}, errors.New("initial baseline unavailable")
	}
	record, err := credentials.InitialState()
	if err != nil {
		return keptInitialRecord{}, errors.New("invalid initial baseline")
	}

	if !filepath.IsAbs(record.File) || filepath.Clean(record.File) != record.File || !filepath.IsAbs(record.Project) || filepath.Clean(record.Project) != record.Project || (!record.CommentsExists && record.Comments != "") {
		return keptInitialRecord{}, errors.New("invalid initial baseline")
	}
	rel, err := filepath.Rel(record.Project, record.File)
	if err != nil || !filepath.IsLocal(rel) {
		return keptInitialRecord{}, errors.New("invalid initial baseline")
	}
	path := filepath.ToSlash(rel)
	payload, err := protocol.OpenKeptCheckpoint(keys, protocol.KeptCheckpointContext{RoomID: credentials.RoomID, Epoch: record.Epoch, Generation: 1}, record.Checkpoint)
	if err != nil {
		return keptInitialRecord{}, errors.New("invalid initial checkpoint")
	}
	decoded, err := protocol.DecodeKeptTextPayload(payload, protocol.MaxKeptCheckpointReceipts)
	if err != nil {
		return keptInitialRecord{}, errors.New("invalid initial checkpoint")
	}
	if decoded.Manifest[0].Path != path || decoded.Manifest[0].ID != 0 {
		return keptInitialRecord{}, errors.New("initial path mismatch")
	}
	textDoc := crdt.New()
	defer textDoc.Destroy()
	if crdt.ApplyUpdateV1(textDoc, decoded.Documents[0], nil) != nil || textDoc.GetText("content").ToString() != record.Text {
		return keptInitialRecord{}, errors.New("initial text mismatch")
	}
	if err = checkInitialComments(record, path, textDoc, decoded.Documents[1]); err != nil {
		return keptInitialRecord{}, err
	}
	return record, nil
}

func checkInitialComments(record keptInitialRecord, path string, textDoc *crdt.Doc, update []byte) error {
	old := &meta.File{Path: path}
	if record.CommentsExists {
		var err error
		old, err = meta.Parse([]byte(record.Comments))
		if err != nil || old.Path != path {
			return errors.New("invalid initial metadata")
		}
	}
	expected := crdt.New()
	defer expected.Destroy()
	meta.Load(expected, old, meta.NewTracker(textDoc))
	actual := crdt.New()
	defer actual.Destroy()
	if crdt.ApplyUpdateV1(actual, update, nil) != nil {
		return errors.New("invalid initial comments")
	}
	if !sameInitialAnchors(expected, actual) {
		return errors.New("initial anchors mismatch")
	}
	left, err := meta.Render(meta.Read(expected, old, meta.NewTracker(textDoc)))
	if err != nil {
		return err
	}
	right, err := meta.Render(meta.Read(actual, old, meta.NewTracker(textDoc)))
	if err != nil || !bytes.Equal(left, right) {
		return errors.New("initial comments mismatch")
	}
	return nil
}

func sameInitialAnchors(expected, actual *crdt.Doc) bool {
	want := expected.GetMap(meta.CommentsKey)
	got := actual.GetMap(meta.CommentsKey)
	if len(want.Keys()) != len(got.Keys()) {
		return false
	}
	for _, id := range want.Keys() {
		a, _ := want.Get(id)
		b, _ := got.Get(id)
		left, ok := a.(*crdt.YMap)
		if !ok {
			return false
		}
		right, ok := b.(*crdt.YMap)
		if !ok {
			return false
		}
		x, xok := left.Get(meta.AnchorKey)
		y, yok := right.Get(meta.AnchorKey)
		if !xok || !yok || !reflect.DeepEqual(x, y) {
			return false
		}
	}
	return true
}
