package session

import (
	"errors"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"unicode/utf8"

	"github.com/piconic-ai/pedit/internal/meta"
	"github.com/piconic-ai/pedit/internal/protocol"
	"github.com/reearth/ygo/crdt"
)

// The tests build the record of a kept room from the files on disk with these;
// a running session builds its own in startAway.

func prepareKeptFiles(projectDir string, paths ...string) ([]keptTextFileState, error) {
	if len(paths) > protocol.MaxKeptFiles {
		return nil, errors.New("kept rooms support at most 64 text files")
	}
	project, e := filepath.Abs(projectDir)
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
	if e := attachKeptMetas(projectDir, files); e != nil {
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
	file.File = absolute
	if file.Path, e = keptPath(project, absolute, multi); e != nil {
		return file, nil, e
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

// attachKeptMeta gives file a paired comments doc, loaded from its metadata
// file if there is one, unless its comments cannot be kept: a file outside
// the project, or under .pedit/meta/ itself. A metadata file pedit cannot
// read or open is left as it is and that file offers no comments, as in a live
// room.
func attachKeptMeta(project string, file *keptTextFileState) error {
	root, err := os.OpenRoot(project)
	if err != nil {
		return errors.New("cannot open the kept project")
	}
	defer root.Close()
	rel, ok := projectPath(root, file.File)
	if !ok || keepsComments(root, file.File) || protocol.CheckPath(rel) != nil || protocol.CheckPath(protocol.MetaPath(file.Path)) != nil {
		return nil
	}
	name := metaDir + "/" + rel + ".json"
	loaded := &meta.File{Path: rel}
	text := ""
	if bound, err := openMetaFile(root, filepath.FromSlash(name), false); err == nil {
		defer bound.Close()
		if size, ok := bound.Size(); ok {
			data, readable := bound.Read()
			if size > meta.MaxFileBytes || !readable {
				return nil
			}
			if loaded, err = meta.Parse([]byte(data)); err != nil {
				return nil
			}
			loaded.Path, text = rel, data
		}
	} else if !errors.Is(err, fs.ErrNotExist) {
		return nil
	}
	content := crdt.New()
	defer content.Destroy()
	if err := applyKeptText(content, file.State); err != nil {
		return err
	}
	tracker := meta.NewTracker(content)
	defer tracker.Close()
	doc := crdt.New(crdt.WithGC(false))
	defer doc.Destroy()
	meta.Load(doc, loaded, tracker)
	// Every peer refuses comments larger: they could not take the state.
	if meta.DocSize(doc) > meta.MaxDocBytes {
		return nil
	}
	file.Meta = &keptMetaState{ID: keptMetaIDBase + file.ID, Name: name, State: crdt.EncodeStateAsUpdateV1(doc, nil), Text: text}
	return nil
}

// attachKeptMetas pairs each file with its comments doc, then checks that the
// whole snapshot fits.
func attachKeptMetas(project string, files []keptTextFileState) error {
	for i := range files {
		if e := attachKeptMeta(project, &files[i]); e != nil {
			return e
		}
	}
	snapshots := make([]protocol.KeptFileSnapshot, 0, 2*len(files))
	for _, entry := range (&keptTextHost{state: keptTextState{Files: files}}).entries() {
		snapshots = append(snapshots, protocol.KeptFileSnapshot{ID: entry.ID, Path: entry.Path, Update: entry.State})
	}
	return protocol.CheckKeptBundle(snapshots)
}
