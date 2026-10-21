package meta

import (
	"sync"
	"time"

	"github.com/reearth/ygo/crdt"
)

// Tracker follows where the anchors of a metadata doc are in a text file's
// content, as Yjs would resolve them with followUndoneDeletions off, so the
// host can save them. ygo cannot resolve a position whose character was
// deleted as Yjs does (it counts the deleted characters of its run before
// it, in v1.53.0 too), and what is left of a deleted run cannot be told from
// outside it. So the Tracker takes each position where it is known, while
// its character is still in the text, and follows it through every change to
// the text from then on.
//
// One case it cannot follow: text another peer inserted, concurrently, right
// where a deleted character was. Yjs may order it before that character, and
// the Tracker always counts it after.
type Tracker struct {
	content *crdt.Doc
	text    *crdt.YText
	stop    func()

	mu  sync.Mutex
	pos map[string]*tracked // by the position, base64, as the doc holds it
	// Positions that cannot be placed: gone for good (their character was
	// deleted, or they are not positions on the text), or naming a character
	// not received yet, as of the text's generation then. Asking ygo costs
	// time in the length of the text, so neither is asked again until it
	// could answer otherwise.
	gone    map[string]bool
	unknown map[string]uint64
	gen     uint64
	// tried counts the positions asked of ygo, for tests.
	tried int
	now   func() time.Time // time.Now; tests set it
}

// tracked is a position: its index in the text, and whether its character
// was deleted.
type tracked struct {
	index int
	assoc int
	gone  bool
}

// NewTracker follows positions in content, the doc of a text file. Close
// stops it.
func NewTracker(content *crdt.Doc) *Tracker {
	t := &Tracker{
		content: content,
		text:    content.GetText(ContentText),
		pos:     map[string]*tracked{},
		gone:    map[string]bool{},
		unknown: map[string]uint64{},
		now:     time.Now,
	}
	t.stop = t.text.Observe(func(e crdt.YTextEvent) { t.apply(e.Delta) })
	return t
}

// Close stops following the text.
func (t *Tracker) Close() { t.stop() }

// add tracks a position made at index with assoc, now.
func (t *Tracker) add(key string, index, assoc int) {
	t.mu.Lock()
	defer t.mu.Unlock()
	t.pos[key] = &tracked{index: index, assoc: assoc}
}

// lookup returns where the position key is now, if the Tracker follows it.
func (t *Tracker) lookup(key any) (int, bool) {
	s, ok := canonical(key)
	if !ok {
		return 0, false
	}
	t.mu.Lock()
	defer t.mu.Unlock()
	p, ok := t.pos[s]
	if !ok {
		return 0, false
	}
	return p.index, true
}

// learn follows the position key, canonical, from now if it is not followed
// yet and its character is still in the text. A position it cannot place is
// not asked of ygo again until that could answer otherwise. The caller holds
// the lock remote updates are applied under, so the text does not change
// meanwhile.
func (t *Tracker) learn(key string) {
	t.mu.Lock()
	_, ok := t.pos[key]
	gen, unknown := t.unknown[key]
	skip := ok || t.gone[key] || unknown && gen == t.gen
	if !skip {
		t.tried++
	}
	t.mu.Unlock()
	if skip {
		return
	}
	index, assoc, found := t.place(key)
	t.mu.Lock()
	defer t.mu.Unlock()
	switch found {
	case placed:
		t.pos[key] = &tracked{index: index, assoc: assoc}
		delete(t.unknown, key)
	case notYet:
		t.unknown[key] = t.gen
	default:
		t.gone[key] = true
		delete(t.unknown, key)
	}
}

// canonical is the position v, a base64 string, encoded as pedit encodes
// positions, so that one position has one key however a peer wrote it.
// Only the sign of assoc counts.
func canonical(v any) (string, bool) {
	p, ok := decodePosition(v)
	if !ok {
		return "", false
	}
	if p.Assoc < 0 {
		p.Assoc = -1
	} else {
		p.Assoc = 0
	}
	return encodePosition(p), true
}

// What place found.
const (
	placed = iota
	notYet // names a character not received yet
	never  // its character was deleted, or it is not a position on the text
)

// place resolves a position whose character, if it has one, is still in the
// text: ygo resolves those as Yjs does.
func (t *Tracker) place(key string) (int, int, int) {
	p, ok := decodePosition(key)
	if !ok {
		return 0, 0, never
	}
	abs, ok := crdt.ToAbsolutePosition(t.content, p)
	if !ok {
		return 0, 0, notYet
	}
	if abs.Name != ContentText || abs.Index < 0 || abs.Index > t.text.Len() {
		return 0, 0, never
	}
	if p.Item != nil {
		// The character the position is on: after it with assoc < 0.
		char := abs.Index
		if p.Assoc < 0 {
			char--
		}
		if char < 0 || char >= t.text.Len() {
			return 0, 0, never
		}
		again := crdt.CreateRelativePositionFromIndex(t.text, char, 0)
		if again.Item == nil || *again.Item != *p.Item {
			return 0, 0, never
		}
	}
	return abs.Index, p.Assoc, placed
}

// Learn follows the positions of the anchors in doc, a metadata doc, that it
// does not follow yet, while their characters are still in the text, and
// forgets those of anchors gone from it. It looks at the threads Read may
// save (candidates), and only at the positions their kind of anchor has.
// Call it on each update to doc, under the lock remote updates are applied
// under, so that a position is known before an edit deletes its character:
// Read follows no new position.
//
// Each position costs time in the length of the text, deleted characters
// included, and one update can name thousands. Learn places them for up to
// maxLearn, which is far more than any honest update of an ordinary text
// takes; past that, the update's other positions are tried again by the
// next Learn, and lost if their characters are deleted first. How often a
// peer can make the host Learn is bounded by protocol.AddCheckedFile.
func (t *Tracker) Learn(doc *crdt.Doc) {
	deadline := t.now().Add(maxLearn)
	keys := map[string]bool{}
	for _, thread := range candidates(doc) {
		raw, _ := get[map[string]any](thread, AnchorKey)
		for _, k := range positionsOf(raw) {
			s, ok := canonical(k)
			if !ok {
				continue
			}
			keys[s] = true
			if t.now().Before(deadline) {
				t.learn(s)
			}
		}
	}
	t.keep(keys)
}

// maxLearn is how long one Learn may place positions.
const maxLearn = time.Second

// positionsOf lists the positions an anchor of the doc has, by its kind.
func positionsOf(raw map[string]any) []any {
	switch raw[typeKey] {
	case AnchorText:
		return []any{raw[startKey], raw[endKey]}
	case AnchorCells:
		from, _ := raw[fromKey].(map[string]any)
		to, _ := raw[toKey].(map[string]any)
		return []any{from[startKey], from[endKey], to[startKey], to[endKey]}
	}
	return nil
}

// keep forgets every position but those in keys.
func (t *Tracker) keep(keys map[string]bool) {
	t.mu.Lock()
	defer t.mu.Unlock()
	for k := range t.pos {
		if !keys[k] {
			delete(t.pos, k)
		}
	}
	for k := range t.gone {
		if !keys[k] {
			delete(t.gone, k)
		}
	}
	for k := range t.unknown {
		if !keys[k] {
			delete(t.unknown, k)
		}
	}
}

// apply moves the positions through a change to the text.
func (t *Tracker) apply(delta []crdt.Delta) {
	t.mu.Lock()
	defer t.mu.Unlock()
	t.gen++
	at := 0
	for _, d := range delta {
		switch d.Op {
		case crdt.DeltaOpRetain:
			at += d.Retain
		case crdt.DeltaOpInsert:
			n := 1 // an embed
			if s, ok := d.Insert.(string); ok {
				n = units(s)
			}
			for _, p := range t.pos {
				p.inserted(at, n)
			}
			at += n
		case crdt.DeltaOpDelete:
			for _, p := range t.pos {
				p.deleted(at, d.Delete)
			}
		}
	}
}

// inserted moves p for n code units inserted at at. Text inserted right at a
// position goes before its character (assoc >= 0), and after the character
// before it (assoc < 0). Yjs puts text inserted where a deleted character
// was after it.
func (p *tracked) inserted(at, n int) {
	if p.index > at || p.index == at && p.assoc >= 0 && !p.gone {
		p.index += n
	}
}

// deleted moves p for n code units deleted at at, and marks it gone when its
// character was among them.
func (p *tracked) deleted(at, n int) {
	char := p.index
	if p.assoc < 0 {
		char--
	}
	if char >= at && char < at+n {
		p.gone = true
	}
	switch {
	case p.index >= at+n:
		p.index -= n
	case p.index > at:
		p.index = at
	}
}
