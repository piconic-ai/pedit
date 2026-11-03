package main

import (
	"encoding/json"
	"io"
	"sync"

	"github.com/piconic-ai/pedit/internal/meta"
	"github.com/piconic-ai/pedit/internal/protocol"
	"github.com/piconic-ai/pedit/internal/session"
)

// events prints what happens in the room as JSON, one object a line, for a
// script or an agent (--json, docs/design/comments-cli.md). A nil *events
// prints nothing, so a session without --json calls it all the same.
type events struct {
	mu  sync.Mutex
	enc *json.Encoder
}

func newEvents(w io.Writer) *events {
	enc := json.NewEncoder(w)
	// <, > and & only matter in HTML.
	enc.SetEscapeHTML(false)
	return &events{enc: enc}
}

func (e *events) emit(v any) {
	if e == nil {
		return
	}
	e.mu.Lock()
	defer e.mu.Unlock()
	_ = e.enc.Encode(v)
}

type readyEvent struct {
	Event  string            `json:"event"`
	Room   string            `json:"room"`
	Access string            `json:"access"`
	Files  []string          `json:"files"`
	Links  map[string]string `json:"links,omitempty"`
}

// ready tells that the session is in the room. links are the host's; a
// guest has none to give.
func (e *events) ready(room string, access protocol.Access, files []protocol.FileEntry, links map[string]string) {
	paths := []string{}
	for _, f := range files {
		paths = append(paths, f.Path)
	}
	e.emit(readyEvent{Event: "ready", Room: room, Access: access.String(), Files: paths, Links: links})
}

// hostLinks are the links the host gives people, by their access.
func hostLinks(s *session.Session) map[string]string {
	links := map[string]string{protocol.AccessEdit.String(): s.URL}
	for _, l := range s.Links() {
		links[l.Access.String()] = l.URL
	}
	return links
}

type anchorEvent struct {
	Type string `json:"type"`
	ID   string `json:"id,omitempty"`
}

type commentEvent struct {
	Event     string       `json:"event"`
	File      string       `json:"file"`
	Thread    string       `json:"thread"`
	Message   *string      `json:"message,omitempty"`
	Author    string       `json:"author,omitempty"`
	Time      string       `json:"time,omitempty"`
	Body      *string      `json:"body,omitempty"`
	Quote     *string      `json:"quote,omitempty"`
	Anchor    *anchorEvent `json:"anchor,omitempty"`
	NewThread *bool        `json:"new_thread,omitempty"`
}

// commentHook is what the session calls with each change to the comments:
// nil without --json, so the session does not read them for nobody.
func (e *events) commentHook() func(session.CommentChange) {
	if e == nil {
		return nil
	}
	return e.comment
}

// comment tells a change to the comments.
func (e *events) comment(c session.CommentChange) {
	ev := commentEvent{Event: c.Kind, File: c.File, Thread: c.Thread.ID}
	switch c.Kind {
	case meta.ChangeComment:
		quote, newThread := c.Thread.Quote, c.NewThread
		ev.Message, ev.Author, ev.Time, ev.Body = &c.Message.ID, c.Message.Author, c.Message.Time, &c.Message.Body
		ev.Quote, ev.Anchor, ev.NewThread = &quote, &anchorEvent{Type: c.Thread.Kind, ID: c.Thread.Node}, &newThread
	case meta.ChangeEdited:
		ev.Message, ev.Body = &c.Message.ID, &c.Message.Body
	case meta.ChangeDeleted:
		// An empty message: the whole thread went.
		ev.Message = &c.Message.ID
	}
	e.emit(ev)
}

type statusEvent struct {
	Event  string `json:"event"`
	Status string `json:"status"`
}

// status tells the session's status in the room.
func (e *events) status(st protocol.Status) {
	e.emit(statusEvent{Event: "status", Status: string(st)})
}

type endedEvent struct {
	Event  string `json:"event"`
	Reason string `json:"reason"`
}

// ended is the last event: the session left the room, because it was
// stopped or for the final status the room ended with.
func (e *events) ended(st protocol.Status) {
	reason := "stopped"
	if st != "" {
		reason = string(st)
	}
	e.emit(endedEvent{Event: "ended", Reason: reason})
}
