package meta

import (
	"errors"
	"fmt"
	"unicode/utf16"

	"github.com/reearth/ygo/crdt"
)

// Errors of starting a thread from the command line.
var (
	ErrBadRange     = errors.New("the range is empty or outside the text")
	ErrSplitPair    = errors.New("the range cuts a character in two")
	ErrQuoteTooLong = fmt.Errorf("the range covers more than %d characters", MaxQuote)
	ErrThreadsFull  = fmt.Errorf("the room already holds %d threads", MaxThreads)
)

// StartUpdate is the update that starts a thread, under id thread, on the
// range [from, to) of text, with its first comment, as the browser does for
// text and Markdown: the start is a RelativePosition with assoc 0 and the end
// one with assoc -1, and the quote is the text the range covers. from and to
// are in UTF-16 code units, as Yjs counts. As for ReplyUpdate, doc is left as
// it was, and the caller applies the update while holding the lock remote
// updates are applied under, which it held while this ran, so the text does
// not change meanwhile.
func StartUpdate(doc *crdt.Doc, text *crdt.YText, thread, id, author, time string, from, to int, body string) ([]byte, error) {
	if checkID(thread) != nil {
		return nil, ErrInvalidID
	}
	msg, err := newMessage(id, author, time, body)
	if err != nil {
		return nil, err
	}
	quote, err := quoteOf(text.ToString(), from, to)
	if err != nil {
		return nil, err
	}
	comments := doc.GetMap(CommentsKey)
	if _, taken := comments.Get(thread); taken {
		return nil, ErrIDTaken
	}
	if len(comments.Keys()) >= MaxThreads {
		return nil, ErrThreadsFull
	}
	anchor := map[string]any{
		typeKey:  AnchorText,
		startKey: encodePosition(crdt.CreateRelativePositionFromIndex(text, from, 0)),
		endKey:   encodePosition(crdt.CreateRelativePositionFromIndex(text, to, -1)),
	}
	return update(doc, func(comments *crdt.YMap) func(*crdt.Transaction) {
		return func(txn *crdt.Transaction) {
			th, messages := crdt.NewMapPrelim(), crdt.NewMapPrelim()
			comments.Set(txn, thread, th)
			th.Set(txn, AnchorKey, anchor)
			th.Set(txn, QuoteKey, quote)
			th.Set(txn, ResolvedKey, false)
			th.Set(txn, MessagesKey, messages)
			messages.Set(txn, id, messageIn(msg))
		}
	})
}

// quoteOf is what [from, to) of content covers, if that is a range a thread
// may take: not empty, inside the text, within a quote's limit, and cutting
// no surrogate pair.
func quoteOf(content string, from, to int) (string, error) {
	u := utf16.Encode([]rune(content))
	if from < 0 || to <= from || to > len(u) {
		return "", ErrBadRange
	}
	if to-from > MaxQuote {
		return "", ErrQuoteTooLong
	}
	if splits(u, from) || splits(u, to) {
		return "", ErrSplitPair
	}
	return decode(u[from:to]), nil
}

// splits tells whether a pair of surrogates straddles index i.
func splits(u []uint16, i int) bool {
	return i > 0 && i < len(u) && isHighSurrogate(u[i-1]) && isLowSurrogate(u[i])
}

// TextPlaces is where each thread on a text anchor is in the text tr follows
// now, as [start, end) in UTF-16 code units, by thread id. A thread whose
// place cannot be told (its text was deleted, or its characters have not
// arrived) is left out, and so is one on cells or a node. The caller holds
// the lock that remote updates are applied under.
func TextPlaces(doc *crdt.Doc, tr *Tracker) map[string][2]int {
	out := map[string][2]int{}
	if tr == nil {
		return out
	}
	for id, m := range candidates(doc) {
		raw, _ := get[map[string]any](m, AnchorKey)
		if raw[typeKey] != AnchorText {
			continue
		}
		start, ok1 := tr.lookup(raw[startKey])
		end, ok2 := tr.lookup(raw[endKey])
		if ok1 && ok2 && start < end && end <= tr.text.Len() {
			out[id] = [2]int{start, end}
		}
	}
	return out
}
