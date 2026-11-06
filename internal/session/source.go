package session

import (
	"errors"
	"os"

	"github.com/piconic-ai/pedit/internal/filewriter"
	"github.com/piconic-ai/pedit/internal/lineend"
	"github.com/piconic-ai/pedit/internal/protocol"
	"github.com/reearth/ygo/crdt"
)

// A Source is a document the session shares without owning it, such as the
// one `pedit serve` holds. The source stays the only owner of the doc and the
// only writer of the file: the session keeps a doc of its own, started from
// the source's state so both have one history, and the two exchange Yjs
// updates, each going to the other side once and never back.
type Source interface {
	// State is the document's whole state as one v1 update.
	State() []byte
	// Apply hands the source a Yjs update made in the room. It is called
	// under the room client's lock, in order: it must not call into the
	// Session.
	Apply(update []byte) error
}

// sourceOrigin tags updates that came from the Source. They go to the room and
// are never handed back to Source.Apply.
const sourceOrigin = "source"

// checkSource refuses what a Source cannot do yet, and turns off watching the
// file, which the source owns. It does nothing without a Source.
func checkSource(opts *Options) error {
	if opts.Source == nil {
		return nil
	}
	opts.Watch = false
	switch {
	case isCanvas(opts.File):
		return errors.New("only text files can be shared from a source, not a canvas")
	case opts.Resume != "" && opts.Generation == "":
		return errors.New("a room shared from a source resumes only with the generation of its document")
	case len(opts.More) > 0:
		return errors.New("a room shared from a source shares one file")
	}
	return nil
}

// newSourceContent builds the session's doc from the source's state, and from
// the state of a kept room taken in again, if any: both are one history, so
// the doc is their merge. The file is read once, only for its line ending, so
// render stays right for whoever renders it; the session never writes the file.
func newSourceContent(doc *crdt.Doc, file string, state, kept []byte) (*textContent, error) {
	for _, u := range [][]byte{kept, state} {
		if len(u) == 0 {
			continue
		}
		if err := crdt.ApplyUpdateV1(doc, u, nil); err != nil {
			return nil, err
		}
	}
	onDisk, _ := filewriter.ReadFile(file)
	return &textContent{doc: doc, text: doc.GetText("content"), crlf: lineend.IsCRLF(onDisk)}, nil
}

// FromSource applies an update the source made to the room's doc. It reaches
// the room and is not handed back to the source. It returns with the update in
// the doc, so the last snapshot of a kept room (Stop) holds every update whose
// FromSource has returned: the caller stops feeding the session first, then
// calls Stop.
func (s *Session) FromSource(update []byte) error {
	var err error
	s.Client.Do(func() {
		before := s.Text.ToString()
		if err = crdt.ApplyUpdateV1(s.Doc, update, sourceOrigin); err == nil {
			// Only references the source introduced may be uploaded, as for
			// a local edit of an owned file.
			s.attachments.AllowLocalChanges(before, s.Text.ToString())
		}
	})
	return err
}

// hookContent saves what the room edits: to the file through a writer, or, for
// a source, to the source, which writes the file. The doc calls it under the
// client's lock, so the doc can be read there.
func (s *Session) hookContent(bound *filewriter.BoundFile, initial string) {
	opts := s.opts
	if opts.Source != nil {
		s.Doc.OnUpdate(func(update []byte, origin any) {
			if origin != s.Client {
				return
			}
			if err := opts.Source.Apply(update); err != nil {
				opts.OnError(err)
			}
		})
		return
	}
	s.Writer = filewriter.New(opts.File, initial, filewriter.Options{
		Bound:            bound,
		Delay:            opts.WriteDelay,
		OnError:          s.notices.saveError,
		OnWritten:        s.notices.written,
		OnExternalChange: s.scheduleSyncFromDisk,
	})
	s.Doc.OnUpdate(func(_ []byte, origin any) {
		if origin == s.Client || origin == editOrigin {
			s.Writer.Schedule(s.content.render())
		}
	})
}

// flushFile merges last-second external edits into f and saves it right away.
// A source's file is the source's to save.
func (s *Session) flushFile(f *sharedFile) {
	if s.opts.Source != nil {
		return
	}
	f.syncFromDisk()
	f.Writer.Schedule(f.render())
	_ = f.Writer.Flush()
}

// Fragments are the room's id and the fragments of its links, as they follow
// '#' in the links of `pedit <file>`: the edit secret, then the "c." and "r."
// parts. comment is empty when no file offers comments.
func (s *Session) Fragments() (room, edit, comment, read string) {
	f := s.Client.Keys().Fragments
	if s.offersComments() {
		comment = f[protocol.AccessComment]
	}
	return s.roomID, f[protocol.AccessEdit], comment, f[protocol.AccessRead]
}

// openContent opens what the session shares and loads it into doc: the file
// for a session that owns it, the source's state for one that does not.
func openContent(opts Options, res *resumed, doc *crdt.Doc) (*filewriter.BoundFile, string, content, error) {
	if opts.Source != nil {
		c, err := newSourceContent(doc, opts.File, opts.Source.State(), res.stateOf(opts.File))
		if err != nil {
			return nil, "", nil, err
		}
		if res != nil {
			// The source takes the merge, which for one history is harmless.
			if err := opts.Source.Apply(crdt.EncodeStateAsUpdateV1(doc, nil)); err != nil {
				return nil, "", nil, err
			}
		}
		return nil, lineend.FromDoc(c.text.ToString(), c.crlf), c, nil
	}
	bound, initial, err := openShared(opts.File)
	if err != nil {
		return nil, "", nil, err
	}
	c, err := newContent(doc, opts.File, initial, res.stateOf(opts.File))
	if err != nil {
		_ = bound.Close()
		return nil, "", nil, err
	}
	return bound, initial, c, nil
}

// boundDir is the opened directory of the shared file, or nil for a source's
// file, whose directory attachments then open themselves.
func boundDir(bound *filewriter.BoundFile) *os.Root {
	if bound == nil {
		return nil
	}
	return bound.Dir()
}
