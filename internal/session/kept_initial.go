package session

import (
	"errors"
	"io/fs"
	"os"
	"path/filepath"

	"github.com/piconic-ai/pedit/internal/filewriter"
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
		return &meta.File{Path: path}, nil
	}
	if err != nil {
		return nil, err
	}
	s.metaBound = bound
	s.metadataInfo, err = os.Lstat(s.metadata)
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
		check, openErr := openMetaFile(s.project, s.metaName, false)
		if check != nil {
			check.Close()
		}
		if errors.Is(err, fs.ErrNotExist) && errors.Is(openErr, fs.ErrNotExist) {
			return nil
		}
		return errors.New("initial metadata changed")
	}
	if err != nil || !os.SameFile(s.metadataInfo, info) {
		return errors.New("initial metadata changed")
	}
	comments, ok := s.metaBound.Read()
	if !ok || comments != s.comments {
		return errors.New("initial metadata changed")
	}
	return nil
}
