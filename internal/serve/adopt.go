package serve

import (
	"errors"
	"fmt"

	"github.com/piconic-ai/pedit/internal/merge"
	"github.com/reearth/ygo/crdt"
)

// errReplaced ends a stream whose document was replaced. The app's page
// reconnects, finds another generation, and reports the document as gone.
var errReplaced = &closeError{4001, "document replaced", nil}

var errAdoptPeer = errors.New("serve: the document cannot be replaced while a room is attached")

// Text is the document's text, with LF line ends as the doc holds it.
func (s *Server) Text() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.text.ToString()
}

// Edit applies the change from base to next onto the document as an ordinary
// edit, as a save made by another editor is applied: what was written
// meanwhile is kept unless the change replaced the same region. The streams
// and the file get it as for any edit. It returns the Yjs update the edit made
// and the generation it was made in, for ApplyUpdate.
func (s *Server) Edit(base, next string) (update []byte, generation string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	before := s.doc.StateVector()
	merge.ExternalEdit(s.doc, s.text, base, next, &fileOrigin{})
	return crdt.EncodeStateAsUpdateV1(s.doc, before), s.generation
}

// ApplyUpdate applies an update Edit returned. It does nothing and reports
// false unless the document still has that generation and the update then
// integrates completely: a document restarted from a state of the same
// history lacks what Edit made, and gets it back here, while what it already
// has is unchanged and edits made since are untouched.
func (s *Server) ApplyUpdate(update []byte, generation string) (ok bool) {
	defer func() {
		// ygo can panic on a malformed update; it must not end the process.
		if recover() != nil {
			ok = false
		}
	}()
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closing || s.generation != generation {
		return false
	}
	probe := crdt.New()
	if crdt.ApplyUpdateV1(probe, crdt.EncodeStateAsUpdateV1(s.doc, nil), nil) != nil || crdt.ApplyUpdateV1(probe, update, nil) != nil {
		return false
	}
	if p := probe.PendingStats(); p.Items != 0 || p.DeleteRanges != 0 {
		return false
	}
	return crdt.ApplyUpdateV1(s.doc, update, &fileOrigin{}) == nil
}

// Adopt replaces the document with the one merge makes (a v1 update holding
// its whole state) under the generation it returns, a new one if that is
// empty. merge is given the document's text and runs while the server's lock
// is held, so that no edit accepted meanwhile is lost: it must only compute.
// Every open stream is closed so that its page learns the document is gone.
// The file is written with the new text and the state saved before Adopt
// returns. No room may be attached.
func (s *Server) Adopt(merge func(appText string) (doc []byte, generation string, err error)) error {
	if err := s.replace(merge); err != nil {
		return err
	}
	return s.Flush()
}

func (s *Server) replace(merge func(string) ([]byte, string, error)) (err error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	defer func() {
		// ygo can panic on a malformed update; it must not end the process.
		if r := recover(); r != nil {
			err = fmt.Errorf("serve: malformed document: %v", r)
		}
	}()
	switch {
	case s.closing:
		return errServerClosed
	case s.peer != nil:
		return errAdoptPeer
	}
	doc, generation, err := merge(s.text.ToString())
	if err != nil {
		return err
	}
	next := crdt.New()
	if err := crdt.ApplyUpdateV1(next, doc, nil); err != nil {
		return err
	}
	if p := next.PendingStats(); p.Items != 0 || p.DeleteRanges != 0 {
		return errors.New("serve: incomplete document")
	}
	if generation == "" {
		generation = newGeneration()
	}
	s.doc, s.text, s.generation = next, next.GetText("content"), generation
	s.doc.OnUpdate(s.onUpdate)
	for c := range s.clients {
		s.retire(c, errReplaced)
	}
	s.writer.Schedule(s.fileText())
	return nil
}
