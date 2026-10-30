package session

import (
	"bytes"
	"errors"
	"io"
	"os"
	"path/filepath"
	"strings"
	"unicode/utf8"

	"github.com/piconic-ai/pedit/internal/filewriter"
	"github.com/piconic-ai/pedit/internal/protocol"
	"github.com/reearth/ygo/crdt"
)

func prepareKeptFiles(opts KeptTextOptions) ([]keptTextFileState, error) {
	paths := append([]string{opts.File}, opts.More...)
	if len(paths) > protocol.MaxKeptFiles {
		return nil, errors.New("kept rooms support at most 64 text files")
	}
	project, e := filepath.Abs(opts.Project)
	if e != nil {
		return nil, e
	}
	files := make([]keptTextFileState, 0, len(paths))
	infos := []os.FileInfo{}
	names := map[string]bool{}
	root, _ := openProject(project)
	if root != nil {
		defer root.Close()
	}
	for i, path := range paths {
		if absolute, e := filepath.Abs(path); e == nil && keepsComments(root, absolute) {
			return nil, errKeepsComments
		}
		file, info, e := readKeptSource(path, project, uint32(i), len(paths) > 1)
		if e != nil {
			return nil, e
		}
		key := protocol.PathKey(file.Path)
		if names[key] {
			return nil, errors.New("duplicate kept file path")
		}
		for _, previous := range infos {
			if os.SameFile(info, previous) {
				return nil, errors.New("duplicate kept source file")
			}
		}
		names[key] = true
		infos = append(infos, info)
		files = append(files, file)
	}
	snapshots := make([]protocol.KeptFileSnapshot, 0, 2*len(files))
	for i := range files {
		if e := attachKeptMeta(opts.Project, &files[i]); e != nil {
			return nil, e
		}
	}
	for _, entry := range (&keptTextHost{state: keptTextState{Files: files}}).entries() {
		snapshots = append(snapshots, protocol.KeptFileSnapshot{ID: entry.ID, Path: entry.Path, Update: entry.State})
	}
	if e := protocol.CheckKeptBundle(snapshots); e != nil {
		return nil, e
	}
	return files, nil
}
func readKeptSource(path, project string, id uint32, multi bool) (keptTextFileState, os.FileInfo, error) {
	file := keptTextFileState{ID: id}
	absolute, e := filepath.Abs(path)
	if e != nil {
		return file, nil, e
	}
	file.File, file.Path = absolute, filepath.Base(absolute)
	if multi {
		relative, e := filepath.Rel(project, absolute)
		if e != nil || relative == ".." || strings.HasPrefix(relative, ".."+string(filepath.Separator)) {
			return file, nil, errors.New("kept files must be inside the project")
		}
		file.Path = filepath.ToSlash(relative)
	}
	if protocol.CheckPath(file.Path) != nil {
		return file, nil, errors.New("invalid kept file path")
	}
	input, e := os.Open(absolute)
	if e != nil {
		return file, nil, errors.New("cannot read kept file")
	}
	defer input.Close()
	info, e := input.Stat()
	if e != nil || !info.Mode().IsRegular() {
		return file, nil, errors.New("kept source must be a regular file")
	}
	data, e := io.ReadAll(io.LimitReader(input, protocol.MaxFrameBytes+1))
	if e != nil || isCanvas(absolute) || len(data) > protocol.MaxFrameBytes || !utf8.Valid(data) {
		return file, nil, errors.New("cannot read kept UTF-8 file")
	}
	doc := crdt.New()
	defer doc.Destroy()
	text := doc.GetText("content")
	doc.Transact(func(tx *crdt.Transaction) { text.Insert(tx, 0, string(data), nil) })
	file.State, file.Text = crdt.EncodeStateAsUpdateV1(doc, nil), string(data)
	return file, info, nil
}
func (h *keptTextHost) openFiles() error {
	h.files = map[uint32]*keptTextDocument{}
	h.snapshotNames = map[uint32]string{}
	if len(h.state.Files) == 0 || len(h.state.Files) > 64 || h.state.Files[0].ID != 0 {
		return errors.New("invalid saved kept inventory")
	}
	paths := map[string]bool{}
	infos := []os.FileInfo{}
	root, _ := openProject(h.state.Project)
	if root != nil {
		defer root.Close()
	}
	for _, file := range h.state.Files {
		if h.files[file.ID] != nil || !filepath.IsAbs(file.File) || filepath.Clean(file.File) != file.File || protocol.CheckPath(file.Path) != nil || paths[protocol.PathKey(file.Path)] {
			h.closeFiles()
			return errors.New("invalid saved kept file")
		}
		if e := checkKeptLocation(file, h.state.Project, len(h.state.Files) > 1); e != nil {
			h.closeFiles()
			return e
		}
		if keepsComments(root, file.File) {
			h.closeFiles()
			return errKeepsComments
		}
		info, e := os.Stat(file.File)
		if e != nil {
			h.closeFiles()
			return e
		}
		for _, previous := range infos {
			if os.SameFile(info, previous) {
				h.closeFiles()
				return errors.New("duplicate saved kept source")
			}
		}
		bound, e := filewriter.OpenBound(file.File)
		if e != nil {
			h.closeFiles()
			return errors.New("cannot open kept file")
		}
		h.files[file.ID] = &keptTextDocument{doc: crdt.New(crdt.WithGC(false)), bound: bound}
		paths[protocol.PathKey(file.Path)] = true
		infos = append(infos, info)
	}
	return h.openMetas()
}

// openMetas makes the comments docs paired with the files, and opens the
// project their metadata files are written in.
func (h *keptTextHost) openMetas() error {
	for _, file := range h.state.Files {
		m := file.Meta
		if m == nil {
			continue
		}
		if h.files[m.ID] != nil || checkKeptMeta(file, h.state.Project) != nil || protocol.CheckPath(protocol.MetaPath(file.Path)) != nil {
			h.closeFiles()
			return errors.New("invalid saved kept comments")
		}
		if h.project == nil {
			project, e := os.OpenRoot(h.state.Project)
			if e != nil {
				h.closeFiles()
				return errors.New("cannot open the kept project")
			}
			h.project = project
		}
		h.files[m.ID] = &keptTextDocument{doc: crdt.New(crdt.WithGC(false)), root: protocol.KeptCommentsRoot}
	}
	return nil
}

// keptEntry is a doc of the room as the snapshot lists it.
type keptEntry struct {
	ID    uint32
	Path  string
	State []byte
}

// entries lists the room's docs in snapshot order, as last saved: the text
// files, then the comments docs paired with them.
func (h *keptTextHost) entries() []keptEntry {
	list := make([]keptEntry, 0, 2*len(h.state.Files))
	for _, file := range h.state.Files {
		list = append(list, keptEntry{file.ID, file.Path, file.State})
	}
	for _, file := range h.state.Files {
		if m := file.Meta; m != nil {
			list = append(list, keptEntry{m.ID, protocol.MetaPath(file.Path), m.State})
		}
	}
	return list
}
func (h *keptTextHost) closeFiles() {
	for _, file := range h.files {
		file.doc.Destroy()
		if file.bound != nil {
			file.bound.Close()
		}
	}
	if h.project != nil {
		h.project.Close()
		h.project = nil
	}
}
func (h *keptTextHost) snapshot() ([]byte, error) {
	files := make([]protocol.KeptFileSnapshot, 0, 2*len(h.state.Files))
	for _, entry := range h.entries() {
		update := entry.State
		if live := h.files[entry.ID]; live != nil {
			update = crdt.EncodeStateAsUpdateV1(live.doc, nil)
		}
		files = append(files, protocol.KeptFileSnapshot{ID: entry.ID, Path: entry.Path, Update: update})
	}
	if len(files) == 1 {
		return protocol.SealKeptTextSnapshot(h.keys, files[0].Path, files[0].Update)
	}
	return protocol.SealKeptBundle(h.keys, files)
}
func (h *keptTextHost) unchanged() bool {
	for _, entry := range h.entries() {
		if h.snapshotNames[entry.ID] != entry.Path || !bytes.Equal(crdt.EncodeStateAsUpdateV1(h.files[entry.ID].doc, nil), entry.State) {
			return false
		}
	}
	return true
}
func (h *keptTextHost) finishWrites() error {
	// Preflight the entire batch before exchanging any source; the saved journal
	// permits recovery if a later write or sync fails after an earlier succeeds.
	for _, file := range h.state.Files {
		if e := checkKeptSource(file, h.files[file.ID].bound); e != nil {
			return e
		}
		if file.Meta != nil {
			if e := h.checkKeptMetaSource(file.Meta); e != nil {
				return e
			}
		}
	}
	for i := range h.state.Files {
		file := &h.state.Files[i]
		if e := finishKeptWrite(file, h.files[file.ID].bound); e != nil {
			return e
		}
		if e := saveKeptState(h.path, h.state); e != nil {
			return e
		}
		if file.Meta != nil {
			if e := h.finishKeptMeta(file.Meta); e != nil {
				return e
			}
			if e := saveKeptState(h.path, h.state); e != nil {
				return e
			}
		}
	}
	return nil
}
func checkKeptSource(file keptTextFileState, bound *filewriter.BoundFile) error {
	text, ok := bound.Read()
	if !ok || (text != file.Text && (file.Pending == nil || text != *file.Pending)) {
		return errors.New("kept file changed outside pedit; original preserved")
	}
	return nil
}

func checkKeptLocation(file keptTextFileState, project string, multi bool) error {
	if !multi {
		if file.Path != filepath.Base(file.File) {
			return errors.New("saved kept filename differs from source")
		}
		return nil
	}
	relative, e := filepath.Rel(project, file.File)
	if e != nil || relative == ".." || strings.HasPrefix(relative, ".."+string(filepath.Separator)) || filepath.ToSlash(relative) != file.Path {
		return errors.New("saved kept path differs from project")
	}
	return nil
}
