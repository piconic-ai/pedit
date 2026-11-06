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

// checkSource refuses what a Source cannot do yet.
func checkSource(opts Options) error {
	switch {
	case isCanvas(opts.File):
		return errors.New("only text files can be shared from a source, not a canvas")
	case opts.Keep > 0 || opts.Resume != "":
		return errors.New("a room shared from a source cannot be kept or resumed")
	case len(opts.More) > 0:
		return errors.New("a room shared from a source shares one file")
	}
	return nil
}

// newSourceContent builds the session's doc from the source's state. The file
// is read once, only for its line ending, so render stays right for whoever
// renders it; the session never writes the file.
func newSourceContent(doc *crdt.Doc, file string, state []byte) (*textContent, error) {
	if err := crdt.ApplyUpdateV1(doc, state, nil); err != nil {
		return nil, err
	}
	onDisk, _ := filewriter.ReadFile(file)
	return &textContent{doc: doc, text: doc.GetText("content"), crlf: lineend.IsCRLF(onDisk)}, nil
}

// FromSource applies an update the source made to the room's doc. It reaches
// the room and is not handed back to the source.
func (s *Session) FromSource(update []byte) error {
	var err error
	s.Client.Do(func() { err = crdt.ApplyUpdateV1(s.Doc, update, sourceOrigin) })
	return err
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
		c, err := newSourceContent(doc, opts.File, opts.Source.State())
		if err != nil {
			return nil, "", nil, err
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
