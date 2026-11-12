package session

import (
	"errors"
	"path/filepath"
	"strings"
	"time"

	"github.com/piconic-ai/pedit/internal/meta"
	"github.com/reearth/ygo/crdt"
)

// ErrNoTextAnchors means the room's first file takes no thread on a range of
// its text: a table, whose threads sit on cells, or a canvas, on nodes.
var ErrNoTextAnchors = errors.New("only a text or Markdown file takes a thread on a range of its text")

// ErrNotHost means a write only the host makes.
var ErrNotHost = errors.New("only the host starts a thread on a range")

// StartThread starts a thread, under id thread, on [from, to) of the first
// file's text, in UTF-16 code units, with its first comment under id
// message, signed with the session's name (docs/design/embedding.md,
// "Comments from the app"). The host has it at once.
func (s *Session) StartThread(thread, message string, from, to int, body string) (WriteResult, error) {
	f := s.sharedFile
	switch {
	case s.guest != nil:
		return WriteResult{}, ErrNotHost
	case f.meta == nil:
		return WriteResult{}, ErrNoComments
	case f.meta.tracker == nil || s.Text == nil || isTable(f.path):
		return WriteResult{}, ErrNoTextAnchors
	}
	now := time.Now().UTC().Format("2006-01-02T15:04:05.000Z")
	var err error
	s.Client.Do(func() {
		var update []byte
		update, err = meta.StartUpdate(f.meta.doc, s.Text, thread, message, s.authorName(), now, from, to, body)
		if err == nil {
			err = crdt.ApplyUpdateV1(f.meta.doc, update, localWrite)
		}
	})
	return WriteResult{Delivered: err == nil}, err
}

// isTable tells whether a file's threads sit on cells, by its name.
func isTable(path string) bool {
	ext := strings.ToLower(filepath.Ext(path))
	return ext == ".csv" || ext == ".tsv"
}

// PlacedThread is a thread of the first file, with where its anchor is now.
type PlacedThread struct {
	meta.Shown
	// From and To are the place in the text, in UTF-16 code units, when
	// Placed: not for a thread on cells or a node, nor one whose text is gone.
	From, To int
	Placed   bool
}

// PlacedThreads lists the threads of the first file as the browser lists
// them, each with where its anchor is in the text now.
func (s *Session) PlacedThreads() []PlacedThread {
	m := s.sharedFile.meta
	if m == nil {
		return nil
	}
	var out []PlacedThread
	s.Client.Do(func() {
		places := meta.TextPlaces(m.doc, m.tracker)
		for _, t := range meta.ShownThreads(m.doc) {
			p, placed := places[t.ID]
			out = append(out, PlacedThread{Shown: t, From: p[0], To: p[1], Placed: placed})
		}
	})
	return out
}

// PlaceSavedComments places saved threads in the current normalized text,
// using the same cleaning, ordering and anchors as a live session.
func PlaceSavedComments(saved *meta.File, text string) []PlacedThread {
	content, comments := crdt.New(), crdt.New()
	defer content.Destroy()
	defer comments.Destroy()
	current := content.GetText(meta.ContentText)
	content.Transact(func(txn *crdt.Transaction) { current.Insert(txn, 0, text, nil) })
	tracker := meta.NewTracker(content)
	defer tracker.Close()
	meta.Load(comments, saved, tracker)
	places := meta.TextPlaces(comments, tracker)
	out := make([]PlacedThread, 0, len(saved.Comments))
	for _, t := range meta.ShownThreads(comments) {
		p, placed := places[t.ID]
		out = append(out, PlacedThread{Shown: t, From: p[0], To: p[1], Placed: placed})
	}
	return out
}
