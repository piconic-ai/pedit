package session

import (
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"strings"

	"github.com/piconic-ai/pedit/internal/meta"
	"github.com/piconic-ai/pedit/internal/protocol"
	"github.com/reearth/ygo/crdt"
)

// keptMetaIDBase is the first ID of the metadata docs of a kept room: the
// doc paired with text file n has ID keptMetaIDBase+n, kept in the saved state
// so it stays stable. Text file IDs stay below it.
const keptMetaIDBase = 1024

// keptMetaState is the comments doc paired with a kept text file: a doc of its
// own with its own file ID (root map "comments"), and the metadata file the
// host writes it to under .pedit/meta/. Text and Pending journal that file as
// the text file's are: Text is what the host last wrote or read ("" while
// there is none), Pending what the next write makes it.
type keptMetaState struct {
	ID      uint32
	Name    string // slash path under the project: .pedit/meta/<path>.json
	State   []byte
	Text    string
	Pending *string `json:",omitempty"`
}

// attachKeptMeta gives file a paired comments doc, loaded from its metadata
// file if there is one, unless its comments cannot be kept: a file outside
// the project, or under .pedit/meta/ itself. A metadata file pedit cannot
// read is an error: it would be left alone, but guests would comment into the
// void.
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
			if size > meta.MaxFileBytes {
				return fmt.Errorf("%s is larger than %d bytes", name, meta.MaxFileBytes)
			}
			data, ok := bound.Read()
			if !ok {
				return fmt.Errorf("cannot read %s", name)
			}
			if loaded, err = meta.Parse([]byte(data)); err != nil {
				return fmt.Errorf("%s cannot be read, and is left as it is: %w", name, err)
			}
			loaded.Path, text = rel, data
		}
	} else if !errors.Is(err, fs.ErrNotExist) {
		return fmt.Errorf("cannot open %s: %w", name, err)
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
		return fmt.Errorf("the comments in %s are too large to share", name)
	}
	file.Meta = &keptMetaState{ID: keptMetaIDBase + file.ID, Name: name, State: crdt.EncodeStateAsUpdateV1(doc, nil), Text: text}
	return nil
}

// checkKeptMeta validates a saved comments doc of file against the project.
func checkKeptMeta(file keptTextFileState, project string) error {
	m := file.Meta
	rel, err := filepath.Rel(project, file.File)
	if m.ID != keptMetaIDBase+file.ID || err != nil || m.Name != metaDir+"/"+filepath.ToSlash(rel)+".json" || !filepath.IsLocal(m.Name) {
		return errors.New("invalid saved kept comments")
	}
	return nil
}

// metaPending works out what the metadata file of file becomes with the
// comments the doc holds now, or nil when it stays as it is: no file is made
// before the first thread, and none is ever removed. Anchors are placed on the
// text as it is now by a tracker made for the occasion; one whose text was
// deleted meanwhile keeps the place the file saved last.
func (h *keptTextHost) metaPending(file *keptTextFileState) (*string, error) {
	m := file.Meta
	prev := &meta.File{Path: strings.TrimSuffix(strings.TrimPrefix(m.Name, metaDir+"/"), ".json")}
	if m.Text != "" {
		parsed, err := meta.Parse([]byte(m.Text))
		if err != nil {
			return nil, errors.New("kept comments file is not readable")
		}
		parsed.Path = prev.Path
		prev = parsed
	}
	doc := h.files[m.ID].doc
	tracker := meta.NewTracker(h.files[file.ID].doc)
	defer tracker.Close()
	tracker.Learn(doc)
	read := meta.Read(doc, prev, tracker)
	if m.Text == "" && len(read.Comments) == 0 {
		return nil, nil
	}
	out, err := meta.Render(read)
	if err != nil {
		return nil, fmt.Errorf("the comments cannot be saved: %w", err)
	}
	if string(out) == m.Text {
		return nil, nil
	}
	text := string(out)
	return &text, nil
}

// readKeptMeta reads the metadata file, if there is one.
func (h *keptTextHost) readKeptMeta(m *keptMetaState) (string, bool) {
	bound, err := openMetaFile(h.project, filepath.FromSlash(m.Name), false)
	if err != nil {
		return "", false
	}
	defer bound.Close()
	return bound.Read()
}

// checkKeptMetaSource refuses a pending write over a file changed outside
// pedit; the original is preserved.
func (h *keptTextHost) checkKeptMetaSource(m *keptMetaState) error {
	if m.Pending == nil {
		return nil
	}
	if current, ok := h.readKeptMeta(m); (ok && current != m.Text && current != *m.Pending) || (!ok && m.Text != "") {
		return errors.New("kept comments file changed outside pedit; original preserved")
	}
	return nil
}

// finishKeptMeta writes the pending metadata file as finishKeptWrite writes a
// text file: replaying it after a crash writes nothing twice, and a file that
// appeared or changed meanwhile is never overwritten.
func (h *keptTextHost) finishKeptMeta(m *keptMetaState) error {
	if m.Pending == nil {
		return nil
	}
	bound, err := openMetaFile(h.project, filepath.FromSlash(m.Name), m.Text == "")
	if err != nil {
		return errors.New("kept comments file cannot be opened")
	}
	defer bound.Close()
	current, ok := bound.Read()
	switch {
	case ok && current == *m.Pending:
	case !ok && m.Text == "":
		bound.CreateOnly()
		err = bound.Write("", *m.Pending)
	case ok && current == m.Text:
		err = bound.Write(m.Text, *m.Pending)
	default:
		return errors.New("kept comments file changed outside pedit; original preserved")
	}
	if err == nil {
		err = bound.Sync()
	}
	if after, ok := bound.Read(); err != nil || !ok || after != *m.Pending {
		return errors.New("kept comments file could not be saved")
	}
	m.Text, m.Pending = *m.Pending, nil
	return nil
}
