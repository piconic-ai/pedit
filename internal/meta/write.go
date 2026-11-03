package meta

import (
	"errors"
	"fmt"
	"strings"

	"github.com/reearth/ygo/crdt"
)

// Errors of a write from the command line (docs/design/comments-cli.md).
var (
	ErrNoThread    = errors.New("no such thread")
	ErrThreadFull  = fmt.Errorf("the thread already holds %d comments", MaxMessages)
	ErrIDTaken     = errors.New("the thread holds another comment of that id")
	ErrInvalidID   = errors.New("not a valid comment id: 1 to 32 of A-Z, a-z, 0-9, _ and -")
	ErrEmptyBody   = errors.New("the comment is empty")
	ErrBodyTooLong = fmt.Errorf("the comment is longer than %d characters", MaxBody)
)

// ReplyUpdate is the update that adds a comment to thread, under id, as the
// browser adds one: {author, time, body} in the thread's messages. time is
// RFC 3339 in UTC, as toISOString writes it. The author is cleaned and cut
// as the browser does. It returns no update, and no error, when the thread
// holds that comment already: a reply sent again is written once. The
// update is checked as every peer checks one (CheckUpdate); doc is left as
// it was, and the caller applies the update while holding the lock remote
// updates are applied under, which it held while this ran.
func ReplyUpdate(doc *crdt.Doc, thread, id, author, time, body string) ([]byte, error) {
	if checkID(id) != nil {
		return nil, ErrInvalidID
	}
	if strings.TrimSpace(body) == "" {
		return nil, ErrEmptyBody
	}
	if units(body) > MaxBody {
		return nil, ErrBodyTooLong
	}
	author = CutUnits(Clean(author, false), MaxAuthor)
	msg := Message{Author: author, Time: time, Body: body}
	if err := msg.check(); err != nil {
		return nil, err
	}
	t, ok := shownByID(doc, thread)
	if !ok {
		return nil, ErrNoThread
	}
	if old, exists, valid := rawMessage(doc, thread, id); exists {
		// What the browser shows is cleaned; compare what was written.
		if valid && old.Author == author && old.Body == body {
			return nil, nil
		}
		return nil, ErrIDTaken
	}
	if len(t.Messages) >= MaxMessages {
		return nil, ErrThreadFull
	}
	return update(doc, func(comments *crdt.YMap) func(*crdt.Transaction) {
		th := threadIn(comments, thread)
		messages, _ := get[*crdt.YMap](th, MessagesKey)
		return func(txn *crdt.Transaction) {
			if messages == nil {
				messages = crdt.NewMapPrelim()
				th.Set(txn, MessagesKey, messages)
			}
			messages.Set(txn, id, messageIn(msg))
		}
	})
}

// ResolveUpdate is the update that resolves thread, or reopens it, as the
// browser does: it sets the thread's resolved flag. It returns no update
// when the thread is so already. As for ReplyUpdate, doc is left as it was.
func ResolveUpdate(doc *crdt.Doc, thread string, resolved bool) ([]byte, error) {
	t, ok := shownByID(doc, thread)
	if !ok {
		return nil, ErrNoThread
	}
	if t.Resolved == resolved {
		return nil, nil
	}
	return update(doc, func(comments *crdt.YMap) func(*crdt.Transaction) {
		th := threadIn(comments, thread)
		return func(txn *crdt.Transaction) { th.Set(txn, ResolvedKey, resolved) }
	})
}

// shownByID is the thread of doc with that id, as ShownThreads lists it.
func shownByID(doc *crdt.Doc, id string) (Shown, bool) {
	for tid, m := range candidates(doc) {
		if tid == id {
			return shownThread(tid, m)
		}
	}
	return Shown{}, false
}

// rawMessage is the comment of thread under id as the doc holds it: whether
// anything is there, and whether it is a comment.
func rawMessage(doc *crdt.Doc, thread, id string) (m Message, exists, valid bool) {
	th := threadIn(doc.GetMap(CommentsKey), thread)
	if th == nil {
		return Message{}, false, false
	}
	messages, ok := get[*crdt.YMap](th, MessagesKey)
	if !ok {
		return Message{}, false, false
	}
	v, exists := messages.Get(id)
	if !exists {
		return Message{}, false, false
	}
	m, valid = messageOut(v)
	return m, true, valid
}

func threadIn(comments *crdt.YMap, id string) *crdt.YMap {
	v, _ := comments.Get(id)
	m, _ := v.(*crdt.YMap)
	return m
}

// update makes a change on a copy of doc, written by doc's client, and
// returns it once it passes CheckUpdate against doc. change reads the copy's
// comments and returns what to write in a transaction: the doc's maps cannot
// be read inside one.
func update(doc *crdt.Doc, change func(comments *crdt.YMap) func(*crdt.Transaction)) ([]byte, error) {
	copied := crdt.New(crdt.WithClientID(doc.ClientID()))
	if err := crdt.ApplyUpdateV1(copied, crdt.EncodeStateAsUpdateV1(doc, nil), nil); err != nil {
		return nil, err
	}
	before := copied.StateVector()
	copied.Transact(change(copied.GetMap(CommentsKey)))
	out := crdt.EncodeStateAsUpdateV1(copied, before)
	if err := CheckUpdate(doc, out); err != nil {
		return nil, err
	}
	return out, nil
}
