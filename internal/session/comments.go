package session

import (
	"errors"
	"fmt"
	"time"

	"github.com/piconic-ai/pedit/internal/meta"
	"github.com/reearth/ygo/crdt"
)

// localWrite is the origin of the comments a session writes itself, from the
// command line (docs/design/comments-cli.md). Of non-zero size, so that no
// other origin compares equal to it.
var localWrite = &struct{ byte }{}

// ErrNoComments means no file of the room offers comments.
var ErrNoComments = errors.New("no file of the room offers comments")

// ErrNoFile means the room shares no file at that path, or it offers no
// comments.
var ErrNoFile = errors.New("no file of the room at that path offers comments")

// ErrAmbiguousThread means threads of several files have the id asked for.
var ErrAmbiguousThread = errors.New("threads of several files have that id: name the file")

// FileThreads are the threads on one of the room's files, as the room shows
// its path.
type FileThreads struct {
	File    string
	Threads []meta.Shown
}

// WriteResult says how far a write from the command line got. Delivered is
// set once the host has it: at once for the host itself.
type WriteResult struct {
	Delivered bool
}

// commentDoc is the comments doc of one of the room's files.
type commentDoc struct {
	file string
	doc  *crdt.Doc
}

// commentDocs are the comments docs of the room's files, in the order the
// files were shared.
func (s *Session) commentDocs() []commentDoc {
	s.filesMu.Lock()
	defer s.filesMu.Unlock()
	var out []commentDoc
	for _, f := range s.files() {
		if f.meta != nil {
			out = append(out, commentDoc{file: f.path, doc: f.meta.doc})
		}
	}
	return out
}

// Comments lists the threads of every file that offers comments, as the
// browser lists them.
func (s *Session) Comments() []FileThreads {
	var out []FileThreads
	for _, c := range s.commentDocs() {
		var threads []meta.Shown
		s.Client.Do(func() { threads = meta.ShownThreads(c.doc) })
		out = append(out, FileThreads{File: c.file, Threads: threads})
	}
	return out
}

// Reply adds a comment to a thread, under id, signed with the session's
// name. file names the thread's file, or is empty to look in every file. A
// reply the thread holds already is not written again.
func (s *Session) Reply(file, thread, id, body string) (WriteResult, error) {
	now := time.Now().UTC().Format("2006-01-02T15:04:05.000Z")
	return s.writeComments(file, thread, func(doc *crdt.Doc) ([]byte, error) {
		return meta.ReplyUpdate(doc, thread, id, s.opts.Name, now, body)
	})
}

// Resolve resolves a thread, or reopens it.
func (s *Session) Resolve(file, thread string, resolved bool) (WriteResult, error) {
	return s.writeComments(file, thread, func(doc *crdt.Doc) ([]byte, error) {
		return meta.ResolveUpdate(doc, thread, resolved)
	})
}

// writeComments makes the update of the thread's doc and applies it, while
// no remote update is applied, so that it is checked against the doc it
// applies to. The room gets it as it gets any change of the doc.
func (s *Session) writeComments(file, thread string, make func(*crdt.Doc) ([]byte, error)) (WriteResult, error) {
	c, err := s.threadDoc(file, thread)
	if err != nil {
		return WriteResult{}, err
	}
	s.Client.Do(func() {
		var update []byte
		if update, err = make(c.doc); err == nil && update != nil {
			err = crdt.ApplyUpdateV1(c.doc, update, localWrite)
		}
	})
	if err != nil {
		return WriteResult{}, fmt.Errorf("%s: %w", c.file, err)
	}
	return WriteResult{Delivered: true}, nil
}

// threadDoc is the comments doc that holds thread: of file, or when file is
// empty, of the only file that has a thread of that id.
func (s *Session) threadDoc(file, thread string) (commentDoc, error) {
	docs := s.commentDocs()
	if len(docs) == 0 {
		return commentDoc{}, ErrNoComments
	}
	var found []commentDoc
	for _, c := range docs {
		if file != "" {
			if c.file == file {
				return c, nil
			}
			continue
		}
		var has bool
		s.Client.Do(func() {
			for _, t := range meta.ShownThreads(c.doc) {
				has = has || t.ID == thread
			}
		})
		if has {
			found = append(found, c)
		}
	}
	switch {
	case file != "":
		return commentDoc{}, ErrNoFile
	case len(found) == 0:
		return commentDoc{}, meta.ErrNoThread
	case len(found) > 1:
		return commentDoc{}, ErrAmbiguousThread
	}
	return found[0], nil
}
