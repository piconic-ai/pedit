// Package merge applies edits made to the file outside pedit onto the shared text.
package merge

import (
	"unicode/utf16"
	"unicode/utf8"

	"github.com/reearth/ygo/crdt"
	"github.com/sergi/go-diff/diffmatchpatch"
)

// edit replaces [start, end) with insert. Offsets are in runes.
type edit struct {
	start, end int
	insert     string
}

func diffRunes(from, to []rune) []diffmatchpatch.Diff {
	return diffmatchpatch.New().DiffMainRunes(from, to, false)
}

// editsBetween returns the edits turning from into to, in from offsets, in ascending order.
func editsBetween(from, to []rune) []edit {
	var edits []edit
	pos := 0
	for _, d := range diffRunes(from, to) {
		n := utf8.RuneCountInString(d.Text)
		switch d.Type {
		case diffmatchpatch.DiffEqual:
			pos += n
		case diffmatchpatch.DiffDelete:
			if last := len(edits) - 1; last >= 0 && edits[last].end == pos {
				edits[last].end += n
			} else {
				edits = append(edits, edit{start: pos, end: pos + n})
			}
			pos += n
		case diffmatchpatch.DiffInsert:
			if last := len(edits) - 1; last >= 0 && edits[last].end == pos {
				edits[last].insert += d.Text
			} else {
				edits = append(edits, edit{start: pos, end: pos, insert: d.Text})
			}
		}
	}
	return edits
}

// offsetMapper returns a function mapping rune offsets in base to rune offsets
// in current. An offset on a boundary where current has inserted text maps to
// before it, or after it with after set: the start of a deletion maps after,
// so that text inserted just before the deleted region is not deleted with it.
func offsetMapper(base, current []rune) func(offset int, after bool) int {
	diffs := diffRunes(base, current)
	return func(offset int, after bool) int {
		b, c := 0, 0
		for i, d := range diffs {
			n := utf8.RuneCountInString(d.Text)
			switch d.Type {
			case diffmatchpatch.DiffEqual:
				if offset <= b+n {
					c += offset - b
					if after && offset == b+n {
						for _, next := range diffs[i+1:] {
							if next.Type != diffmatchpatch.DiffInsert {
								break
							}
							c += utf8.RuneCountInString(next.Text)
						}
					}
					return c
				}
				b += n
				c += n
			case diffmatchpatch.DiffDelete:
				if offset <= b+n {
					return c
				}
				b += n
			case diffmatchpatch.DiffInsert:
				c += n
			}
		}
		return c + (offset - b)
	}
}

// utf16Offsets maps each rune offset in rs (0..len(rs)) to a UTF-16 offset,
// the unit Y.Text indexes by.
func utf16Offsets(rs []rune) []int {
	out := make([]int, len(rs)+1)
	for i, r := range rs {
		out[i+1] = out[i] + utf16.RuneLen(r)
	}
	return out
}

// ExternalEdit applies the change from base to next (an edit made to the file
// outside pedit) onto text, which may meanwhile have diverged from base through
// remote edits. Remote edits are kept unless the external edit replaced the same
// region. The caller must keep text from changing concurrently.
func ExternalEdit(doc *crdt.Doc, text *crdt.YText, base, next string, origin any) {
	baseRunes := []rune(base)
	edits := editsBetween(baseRunes, []rune(next))
	if len(edits) == 0 {
		return
	}
	current := []rune(text.ToString())
	toCurrent := offsetMapper(baseRunes, current)
	toUTF16 := utf16Offsets(current)
	doc.Transact(func(txn *crdt.Transaction) {
		for i := len(edits) - 1; i >= 0; i-- {
			e := edits[i]
			start := toCurrent(e.start, e.end > e.start)
			end := max(start, toCurrent(e.end, false))
			if end > start {
				text.Delete(txn, toUTF16[start], toUTF16[end]-toUTF16[start])
			}
			if e.insert != "" {
				text.Insert(txn, toUTF16[start], e.insert, nil)
			}
		}
	}, origin)
}
