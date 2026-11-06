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
// and the file get it as for any edit.
func (s *Server) Edit(base, next string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	merge.ExternalEdit(s.doc, s.text, base, next, &fileOrigin{})
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
