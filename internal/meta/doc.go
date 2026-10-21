package meta

import (
	"bytes"
	"encoding/base64"
	"maps"
	"slices"
	"unicode/utf16"

	"github.com/reearth/ygo/crdt"
)

// The shared types and keys of a metadata doc. packages/web reads the same
// names: keep them in sync.
const (
	// ContentText is the Y.Text of a text file's content, which text and
	// cells anchors point into.
	ContentText = "content"
	// CommentsKey is a Y.Map of threads, each a Y.Map keyed by the names
	// below.
	CommentsKey = "comments"
	// AnchorKey is where a thread points in this session: {"type": "text",
	// "start", "end"}, {"type": "cells", "from": {"start", "end"}, "to": {...}}
	// or {"type": "node", "id"}. start and end are base64 Yjs
	// RelativePositions on the content's Y.Text, and left out when the place
	// was not found. A text range keeps out what is typed at its edges (start
	// assoc 0, end assoc -1); a cell takes it in (start assoc -1, end assoc 0),
	// as typing into a cell does.
	AnchorKey   = "anchor"
	QuoteKey    = "quote"
	ResolvedKey = "resolved"
	// MessagesKey is a Y.Map of comments, each {"author", "time", "body"}.
	MessagesKey = "messages"
)

// The keys inside an anchor and a message of the doc.
const (
	typeKey   = "type"
	idKey     = "id"
	startKey  = "start"
	endKey    = "end"
	fromKey   = "from"
	toKey     = "to"
	authorKey = "author"
	timeKey   = "time"
	bodyKey   = "body"
)

// maxCandidates bounds the matches of a saved text that Load weighs.
const maxCandidates = 10_000

// fileText is a text file's content, as Load and Read look at it.
type fileText struct {
	*Tracker
	units []uint16 // the content in UTF-16 code units, as Yjs counts
	seen  map[string]bool
}

// textOf reads the text tr follows, or returns nil for nil, as for a canvas,
// whose anchors are node ids.
func textOf(tr *Tracker) *fileText {
	if tr == nil {
		return nil
	}
	return &fileText{Tracker: tr, units: utf16.Encode([]rune(tr.text.ToString())), seen: map[string]bool{}}
}

// Load puts the threads of f into doc, a metadata doc that has none yet,
// re-anchoring each on the text tr follows, the file they belong to: the
// place of a text or cells anchor is found again by its saved text. tr is
// nil for a canvas.
func Load(doc *crdt.Doc, f *File, tr *Tracker) {
	t := textOf(tr)
	var hay []byte
	if t != nil {
		hay = unitBytes(t.units)
	}
	comments := doc.GetMap(CommentsKey)
	doc.Transact(func(txn *crdt.Transaction) {
		for _, id := range slices.Sorted(maps.Keys(f.Comments)) {
			th := f.Comments[id]
			thread := crdt.NewMapPrelim()
			comments.Set(txn, id, thread)
			thread.Set(txn, AnchorKey, anchorIn(th.Anchor, t, hay))
			thread.Set(txn, QuoteKey, th.Quote)
			thread.Set(txn, ResolvedKey, th.Resolved)
			messages := crdt.NewMapPrelim()
			thread.Set(txn, MessagesKey, messages)
			for mid, m := range th.Messages {
				messages.Set(txn, mid, messageIn(m))
			}
		}
	})
}

func messageIn(m Message) map[string]any {
	return map[string]any{authorKey: m.Author, timeKey: m.Time, bodyKey: m.Body}
}

func messageOut(v any) (Message, bool) {
	m, ok := v.(map[string]any)
	if !ok {
		return Message{}, false
	}
	author, ok1 := m[authorKey].(string)
	time, ok2 := m[timeKey].(string)
	body, ok3 := m[bodyKey].(string)
	return Message{Author: author, Time: time, Body: body}, ok1 && ok2 && ok3
}

// anchorIn is a saved anchor as the doc holds it, with the positions of the
// place found in t, whose UTF-16 code units hay holds as bytes.
func anchorIn(a Anchor, t *fileText, hay []byte) map[string]any {
	out := map[string]any{typeKey: a.Type}
	switch a.Type {
	case AnchorNode:
		out[idKey] = a.ID
	case AnchorText:
		if r, ok := rangeIn(a.Text, 0, -1, t, hay); ok {
			maps.Copy(out, r)
		}
	case AnchorCells:
		from, okFrom := rangeIn(a.From, -1, 0, t, hay)
		to, okTo := rangeIn(a.To, -1, 0, t, hay)
		if okFrom && okTo {
			out[fromKey], out[toKey] = from, to
		}
	}
	return out
}

// rangeIn finds s in t and returns its start and end positions, with these
// assocs.
func rangeIn(s *Selector, startAssoc, endAssoc int, t *fileText, hay []byte) (map[string]any, bool) {
	if s == nil || t == nil {
		return nil, false
	}
	start, end := find(s, t.units, hay)
	if start < 0 {
		return nil, false
	}
	return map[string]any{
		startKey: t.make(start, startAssoc),
		endKey:   t.make(end, endAssoc),
	}, true
}

// make makes a position at index, and tracks it.
func (t *fileText) make(index, assoc int) string {
	key := encodePosition(crdt.CreateRelativePositionFromIndex(t.text, index, assoc))
	t.add(key, index, assoc)
	return key
}

// find returns where s is in content, in UTF-16 code units, or -1, -1; hay
// is content as bytes. Where its text appears more than once, the most
// context around it decides, then the nearest to its saved offset, among the
// first maxCandidates. A selector without text, an empty cell, is found by
// its context alone.
func find(s *Selector, content []uint16, hay []byte) (int, int) {
	exact := utf16.Encode([]rune(s.Exact))
	prefix := utf16.Encode([]rune(s.Prefix))
	suffix := utf16.Encode([]rune(s.Suffix))
	needle, skip := exact, 0
	if len(exact) == 0 {
		needle, skip = append(slices.Clone(prefix), suffix...), len(prefix)
	}
	if len(needle) == 0 {
		return -1, -1
	}
	sub := unitBytes(needle)
	best, bestScore, bestDistance := -1, -1, 0
	for from, n := 0, 0; n < maxCandidates; n++ {
		i := index(hay, sub, from)
		if i < 0 {
			break
		}
		at := i + skip
		score := commonSuffix(content[:at], prefix) + commonPrefix(content[at+len(exact):], suffix)
		distance := max(at-s.Offset, s.Offset-at)
		if score > bestScore || (score == bestScore && distance < bestDistance) {
			best, bestScore, bestDistance = at, score, distance
		}
		from = i + 1
	}
	if best < 0 {
		return -1, -1
	}
	return best, best + len(exact)
}

// index returns where sub next is in hay from the code unit from, in code
// units, or -1. bytes.Index takes linear time, where comparing at every
// offset would not; a match must start on a code unit.
func index(hay, sub []byte, from int) int {
	for off := 2 * from; off <= len(hay); {
		i := bytes.Index(hay[off:], sub)
		if i < 0 {
			return -1
		}
		if (off+i)%2 == 0 {
			return (off + i) / 2
		}
		off += i + 1
	}
	return -1
}

// unitBytes is s in big-endian bytes.
func unitBytes(s []uint16) []byte {
	b := make([]byte, 2*len(s))
	for i, u := range s {
		b[2*i], b[2*i+1] = byte(u>>8), byte(u)
	}
	return b
}

func commonPrefix(a, b []uint16) int {
	n := 0
	for n < len(a) && n < len(b) && a[n] == b[n] {
		n++
	}
	return n
}

func commonSuffix(a, b []uint16) int {
	n := 0
	for n < len(a) && n < len(b) && a[len(a)-1-n] == b[len(b)-1-n] {
		n++
	}
	return n
}

func encodePosition(p crdt.RelativePosition) string {
	return base64.StdEncoding.EncodeToString(crdt.EncodeRelativePosition(p))
}

func decodePosition(v any) (crdt.RelativePosition, bool) {
	s, ok := v.(string)
	if !ok {
		return crdt.RelativePosition{}, false
	}
	data, err := base64.StdEncoding.DecodeString(s)
	if err != nil {
		return crdt.RelativePosition{}, false
	}
	p, err := crdt.DecodeRelativePosition(data)
	return p, err == nil
}

// Read returns the metadata in doc as a file to save, changing prev, the file
// as it was read (or a new one), so its unknown keys survive. Anyone in the
// room can write anything into doc, so Read keeps only threads and messages
// that Check accepts, in order of id, up to MaxThreads and to what fits the
// file. An anchor that tr (nil for a canvas) can place gets its place as it
// is now; one it cannot keeps the place it had in prev, or else the place of
// its quote. The caller holds the lock that remote updates are applied
// under, so that the docs do not change while Read reads them.
func Read(doc *crdt.Doc, prev *File, tr *Tracker) *File {
	t := textOf(tr)
	if t != nil {
		defer func() { t.keep(t.seen) }()
	}
	threads := map[string]Thread{}
	// What threads may take in the file; the rest is for its own keys and
	// those a newer pedit wrote.
	budget := MaxFileBytes - extraBytes(prev) - 1024
	comments := doc.GetMap(CommentsKey)
	for _, id := range slices.Sorted(slices.Values(comments.Keys())) {
		if len(threads) == MaxThreads {
			break
		}
		v, _ := comments.Get(id)
		m, ok := v.(*crdt.YMap)
		if !ok || checkID(id) != nil {
			continue
		}
		var was *Anchor
		if th, ok := prev.Comments[id]; ok {
			was = &th.Anchor
		}
		th, ok := readThread(m, was, t)
		if !ok {
			continue
		}
		if size := threadBytes(id, th); size <= budget {
			budget -= size
			threads[id] = th
		}
	}
	prev.Comments = threads
	return prev
}

// threadBytes is what a thread takes in the file, as Render writes it.
func threadBytes(id string, t Thread) int {
	var b bytes.Buffer
	_ = encoder(&b, "    ").Encode(map[string]Thread{id: t})
	return b.Len()
}

func extraBytes(f *File) int {
	n := 0
	for k, v := range f.extra {
		n += len(k) + len(v) + 8
	}
	return n
}

func readThread(m *crdt.YMap, was *Anchor, t *fileText) (Thread, bool) {
	quote, _ := get[string](m, QuoteKey)
	resolved, _ := get[bool](m, ResolvedKey)
	raw, _ := get[map[string]any](m, AnchorKey)
	th := Thread{Quote: quote, Resolved: resolved, Messages: map[string]Message{}}
	anchor, ok := savedAnchor(raw, was, quote, t)
	if !ok {
		return Thread{}, false
	}
	th.Anchor = anchor
	if messages, ok := get[*crdt.YMap](m, MessagesKey); ok {
		for _, mid := range slices.Sorted(slices.Values(messages.Keys())) {
			if len(th.Messages) == MaxMessages {
				break
			}
			v, _ := messages.Get(mid)
			if msg, ok := messageOut(v); ok && checkID(mid) == nil && msg.check() == nil {
				th.Messages[mid] = msg
			}
		}
	}
	return th, th.check() == nil
}

func get[T any](m *crdt.YMap, key string) (T, bool) {
	v, _ := m.Get(key)
	t, ok := v.(T)
	return t, ok
}

// savedAnchor is the anchor to save for one in the doc.
func savedAnchor(raw map[string]any, was *Anchor, quote string, t *fileText) (Anchor, bool) {
	kind, _ := raw[typeKey].(string)
	if kind == AnchorNode {
		id, ok := raw[idKey].(string)
		return Anchor{Type: AnchorNode, ID: id}, ok
	}
	if kind != AnchorText && kind != AnchorCells {
		return Anchor{}, false
	}
	if t != nil {
		if a, ok := placeNow(kind, raw, t); ok {
			return a, true
		}
	}
	if was != nil && was.Type == kind {
		return *was, true
	}
	// Made this session, and its place gone: the next session looks for
	// what it quoted.
	if quote == "" || units(quote) > MaxQuote {
		return Anchor{}, false
	}
	return Anchor{Type: AnchorText, Text: &Selector{Exact: quote}}, true
}

// placeNow is where an anchor of the doc is in t now, if it can be told.
func placeNow(kind string, raw map[string]any, t *fileText) (Anchor, bool) {
	if kind == AnchorText {
		s, ok := selectorAt(raw, false, t)
		return Anchor{Type: AnchorText, Text: s}, ok
	}
	from, _ := raw[fromKey].(map[string]any)
	to, _ := raw[toKey].(map[string]any)
	f, okFrom := selectorAt(from, true, t)
	l, okTo := selectorAt(to, true, t)
	return Anchor{Type: AnchorCells, From: f, To: l}, okFrom && okTo
}

// selectorAt is the place between the start and end positions of r as it is
// now, or false when it cannot be told. Only a cell may be empty.
func selectorAt(r map[string]any, empty bool, t *fileText) (*Selector, bool) {
	start, ok1 := t.resolveSeen(r[startKey])
	end, ok2 := t.resolveSeen(r[endKey])
	if !ok1 || !ok2 || start > end || end > len(t.units) {
		return nil, false
	}
	exact := t.units[start:end]
	if len(exact) > MaxQuote {
		return nil, false
	}
	s := &Selector{
		Exact:  decode(exact),
		Prefix: decode(clip(t.units[:start], true)),
		Suffix: decode(clip(t.units[end:], false)),
		Offset: start,
	}
	return s, s.check() == nil && (s.Exact != "" || empty)
}

// clip keeps MaxContext code units of the end of s (or its start), without
// cutting a surrogate pair in two.
func clip(s []uint16, end bool) []uint16 {
	if len(s) <= MaxContext {
		return s
	}
	if end {
		s = s[len(s)-MaxContext:]
		if isLowSurrogate(s[0]) {
			s = s[1:]
		}
		return s
	}
	s = s[:MaxContext]
	if isHighSurrogate(s[len(s)-1]) {
		s = s[:len(s)-1]
	}
	return s
}

func isHighSurrogate(u uint16) bool { return u >= 0xd800 && u < 0xdc00 }
func isLowSurrogate(u uint16) bool  { return u >= 0xdc00 && u < 0xe000 }

func decode(s []uint16) string { return string(utf16.Decode(s)) }

// resolveSeen resolves a position of the doc, and keeps it tracked.
func (t *fileText) resolveSeen(v any) (int, bool) {
	if s, ok := v.(string); ok {
		t.seen[s] = true
	}
	return t.resolve(v)
}
