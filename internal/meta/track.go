package meta

import (
	"sync"
	"unicode/utf16"

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
	t := &Tracker{content: content, text: content.GetText(ContentText), pos: map[string]*tracked{}}
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

// resolve returns where the position key is now. One not tracked yet is
// taken from ygo, if its character is still in the text; the caller holds
// the lock remote updates are applied under, so the text does not change
// meanwhile.
func (t *Tracker) resolve(key any) (int, bool) {
	s, ok := key.(string)
	if !ok {
		return 0, false
	}
	t.mu.Lock()
	p, ok := t.pos[s]
	t.mu.Unlock()
	if ok {
		return p.index, true
	}
	index, assoc, ok := t.place(s)
	if !ok {
		return 0, false
	}
	t.add(s, index, assoc)
	return index, true
}

// place resolves a position whose character, if it has one, is still in the
// text: ygo resolves those as Yjs does.
func (t *Tracker) place(key string) (int, int, bool) {
	p, ok := decodePosition(key)
	if !ok {
		return 0, 0, false
	}
	abs, ok := crdt.ToAbsolutePosition(t.content, p)
	if !ok || abs.Name != ContentText || abs.Index < 0 || abs.Index > t.text.Len() {
		return 0, 0, false
	}
	if p.Item != nil {
		// The character the position is on: after it with assoc < 0.
		char := abs.Index
		if p.Assoc < 0 {
			char--
		}
		if char < 0 || char >= t.text.Len() {
			return 0, 0, false
		}
		again := crdt.CreateRelativePositionFromIndex(t.text, char, 0)
		if again.Item == nil || *again.Item != *p.Item {
			return 0, 0, false
		}
	}
	return abs.Index, p.Assoc, true
}

// Learn tracks the positions of the anchors in doc, a metadata doc, that it
// does not track yet, while their characters are still in the text. Call it
// on each update to doc, under the lock remote updates are applied under, so
// that a position is known before an edit deletes its character.
func (t *Tracker) Learn(doc *crdt.Doc) {
	comments := doc.GetMap(CommentsKey)
	for _, id := range comments.Keys() {
		v, _ := comments.Get(id)
		thread, ok := v.(*crdt.YMap)
		if !ok {
			continue
		}
		raw, _ := get[map[string]any](thread, AnchorKey)
		for _, r := range []any{raw, raw[fromKey], raw[toKey]} {
			if r, ok := r.(map[string]any); ok {
				t.resolve(r[startKey])
				t.resolve(r[endKey])
			}
		}
	}
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
}

// apply moves the positions through a change to the text.
func (t *Tracker) apply(delta []crdt.Delta) {
	t.mu.Lock()
	defer t.mu.Unlock()
	at := 0
	for _, d := range delta {
		switch d.Op {
		case crdt.DeltaOpRetain:
			at += d.Retain
		case crdt.DeltaOpInsert:
			n := 1 // an embed
			if s, ok := d.Insert.(string); ok {
				n = len(utf16.Encode([]rune(s)))
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
