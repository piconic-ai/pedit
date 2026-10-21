package meta

import (
	"bytes"
	"encoding/base64"
	"iter"
	"maps"
	"path/filepath"
	"slices"
	"strings"
	"unicode/utf16"
	"unicode/utf8"

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
	// The delimiter of a table's cells, by the file's name as the web
	// editor tells it: ',' for .csv, '\t' for .tsv, else none.
	delimiter uint16
}

// textOf reads the text tr follows, of the file at path, or returns nil for
// nil, as for a canvas, whose anchors are node ids.
func textOf(tr *Tracker, path string) *fileText {
	if tr == nil {
		return nil
	}
	t := &fileText{Tracker: tr, units: utf16.Encode([]rune(tr.text.ToString()))}
	switch strings.ToLower(filepath.Ext(path)) {
	case ".csv":
		t.delimiter = ','
	case ".tsv":
		t.delimiter = '\t'
	}
	return t
}

// edge tells whether a code unit ends a cell: a line break, or the
// delimiter.
func (t *fileText) edge(u uint16) bool {
	return u == '\n' || u == '\r' || t.delimiter != 0 && u == t.delimiter
}

// Load puts the threads of f into doc, a metadata doc that has none yet,
// re-anchoring each on the text tr follows, the file they belong to: the
// place of a text or cells anchor is found again by its saved text. tr is
// nil for a canvas.
func Load(doc *crdt.Doc, f *File, tr *Tracker) {
	t := textOf(tr, f.Path)
	var hay *haystack
	if t != nil {
		hay = newHaystack(t.text.ToString())
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
// place found in t, which hay holds to be searched.
func anchorIn(a Anchor, t *fileText, hay *haystack) map[string]any {
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
func rangeIn(s *Selector, startAssoc, endAssoc int, t *fileText, hay *haystack) (map[string]any, bool) {
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

// haystack is a text to find selectors in: its UTF-8, which strings.Index
// searches in linear time and never matches in the middle of a character,
// and the UTF-16 offset of each of its bytes.
type haystack struct {
	s     string
	units []int32 // by byte offset, up to len(s)
}

func newHaystack(s string) *haystack {
	h := &haystack{s: s, units: make([]int32, len(s)+1)}
	n := int32(0)
	for i, r := range s {
		h.units[i] = n
		n += int32(utf16.RuneLen(r))
	}
	h.units[len(s)] = n
	return h
}

// find returns where s is in content, in UTF-16 code units, or -1, -1; hay
// is the same text, to be searched. Where its text appears more than once,
// the most context around it decides, then the nearest to its saved offset,
// among the first maxCandidates. A selector without text, an empty cell, is
// found by its context alone.
func find(s *Selector, content []uint16, hay *haystack) (int, int) {
	exact := utf16.Encode([]rune(s.Exact))
	prefix := utf16.Encode([]rune(s.Prefix))
	suffix := utf16.Encode([]rune(s.Suffix))
	needle, skip := s.Exact, 0
	if needle == "" {
		needle, skip = s.Prefix+s.Suffix, len(prefix)
	}
	if needle == "" {
		return -1, -1
	}
	best, bestScore, bestDistance := -1, -1, 0
	for from, n := 0, 0; n < maxCandidates && from <= len(hay.s); n++ {
		i := strings.Index(hay.s[from:], needle)
		if i < 0 {
			break
		}
		at := int(hay.units[from+i]) + skip
		score := commonSuffix(content[:at], prefix) + commonPrefix(content[at+len(exact):], suffix)
		distance := max(at-s.Offset, s.Offset-at)
		if score > bestScore || (score == bestScore && distance < bestDistance) {
			best, bestScore, bestDistance = at, score, distance
		}
		_, size := utf8.DecodeRuneInString(hay.s[from+i:])
		from += i + size
	}
	if best < 0 {
		return -1, -1
	}
	return best, best + len(exact)
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
	t := textOf(tr, prev.Path)
	threads := map[string]Thread{}
	// What threads may take in the file; the rest is for its own keys and
	// those a newer pedit wrote.
	budget := MaxFileBytes - extraBytes(prev) - 1024
	for id, m := range candidates(doc) {
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

// candidates are the threads of doc that Read may save and the Tracker
// follows: the first MaxThreads, by id, that are Y.Maps with a valid id.
// One that turns out invalid takes its place among them, so what a guest
// writes cannot push others out of what the Tracker follows.
func candidates(doc *crdt.Doc) iter.Seq2[string, *crdt.YMap] {
	return func(yield func(string, *crdt.YMap) bool) {
		comments := doc.GetMap(CommentsKey)
		n := 0
		for _, id := range slices.Sorted(slices.Values(comments.Keys())) {
			v, _ := comments.Get(id)
			m, ok := v.(*crdt.YMap)
			if !ok || checkID(id) != nil {
				continue
			}
			if n++; n > MaxThreads || !yield(id, m) {
				return
			}
		}
	}
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
func selectorAt(r map[string]any, cell bool, t *fileText) (*Selector, bool) {
	start, ok1 := t.lookup(r[startKey])
	end, ok2 := t.lookup(r[endKey])
	if !ok1 || !ok2 || start > end || end > len(t.units) {
		return nil, false
	}
	if cell {
		if start, end, ok1 = t.cellIn(start, end); !ok1 {
			return nil, false
		}
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
	return s, s.check() == nil && (s.Exact != "" || cell)
}

// cellIn is the cell a cell's place, [start, end), holds now, as the web
// editor finds it. The place takes in what is typed at its edges, a row or
// column inserted beside it too, so the cell starts past the delimiters and
// line breaks the place starts with, and ends at its first edge, or at the
// closing quote of a quoted cell. It looks at no more than MaxQuote code
// units for either, as no more is saved, and is false past them.
func (t *fileText) cellIn(start, end int) (int, int, bool) {
	// One code unit past the most that is read, or saved.
	past := func(i int) int { return min(end, i+MaxQuote+1) }
	limit := past(start)
	for start < limit && t.edge(t.units[start]) {
		start++
	}
	if start == limit && limit < end {
		return 0, 0, false
	}
	limit = past(start)
	i := start
	if i < limit && t.units[i] == '"' {
		i = t.closingQuote(i+1, limit)
	} else {
		for i < limit && !t.edge(t.units[i]) {
			i++
		}
	}
	return start, i, i < start+MaxQuote+1
}

// closingQuote is where a quoted cell whose text starts at i ends, past its
// closing quote, or limit: a doubled quote is one inside it.
func (t *fileText) closingQuote(i, limit int) int {
	for ; i < limit; i++ {
		if t.units[i] != '"' {
			continue
		}
		if i+1 < limit && t.units[i+1] == '"' {
			i++
			continue
		}
		return i + 1
	}
	return limit
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
