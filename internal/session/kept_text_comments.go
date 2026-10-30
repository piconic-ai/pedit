package session

import (
	"errors"
	"fmt"
	"path/filepath"
	"strings"

	"github.com/piconic-ai/pedit/internal/meta"
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

// followComments makes each text file with comments follow its anchors from
// here on, before any edit can delete the character one points at.
func (h *keptTextHost) followComments() {
	for _, file := range h.state.Files {
		if file.Meta == nil {
			continue
		}
		text, comments := h.files[file.ID], h.files[file.Meta.ID]
		comments.paired, text.comments, text.tracker = text, comments, meta.NewTracker(text.doc)
		text.tracker.Learn(comments.doc)
	}
}

// syncMeta journals the file's comments doc as it is now, and the metadata
// file it makes. A file without comments has nothing to do.
func (h *keptTextHost) syncMeta(file *keptTextFileState) error {
	m := file.Meta
	if m == nil {
		return nil
	}
	pending, err := h.metaPending(file)
	if err != nil {
		return err
	}
	m.State, m.Pending = crdt.EncodeStateAsUpdateV1(h.files[m.ID].doc, nil), pending
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
	doc, content := h.files[m.ID].doc, h.files[file.ID]
	tracker := content.tracker
	if tracker == nil {
		tracker = meta.NewTracker(content.doc)
		defer tracker.Close()
	}
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
	if m == nil || m.Pending == nil {
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
	if m == nil || m.Pending == nil {
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
	return saveKeptState(h.path, h.state)
}
