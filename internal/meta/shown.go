package meta

import (
	"slices"
	"strings"
	"unicode"
	"unicode/utf16"

	"github.com/reearth/ygo/crdt"
)

// Shown is a thread as people are shown it, read from a comments doc without
// placing its anchor: what a command line peer lists and reports
// (docs/design/comments-cli.md). Text is cleaned as the browser cleans it.
type Shown struct {
	ID       string
	Kind     string // AnchorText, AnchorCells or AnchorNode
	Node     string // the node's id, for AnchorNode
	Quote    string
	Resolved bool
	Messages []ShownMessage // by time, then id
}

// ShownMessage is one comment of a Shown thread.
type ShownMessage struct {
	ID     string
	Author string
	Time   string
	Body   string
}

// ShownThreads reads the threads of doc as the browser lists them: those
// Read could save (candidates), with a quote within its limit and an anchor
// of a kind the host saves, each with its valid comments. They are in the
// order of their first comment, then by id. The caller holds the lock that
// remote updates are applied under.
func ShownThreads(doc *crdt.Doc) []Shown {
	var out []Shown
	for id, m := range candidates(doc) {
		if t, ok := shownThread(id, m); ok {
			out = append(out, t)
		}
	}
	slices.SortStableFunc(out, func(a, b Shown) int {
		if c := strings.Compare(firstTime(a), firstTime(b)); c != 0 {
			return c
		}
		return strings.Compare(a.ID, b.ID)
	})
	return out
}

func firstTime(t Shown) string {
	if len(t.Messages) == 0 {
		return ""
	}
	return t.Messages[0].Time
}

func shownThread(id string, m *crdt.YMap) (Shown, bool) {
	quote, ok := get[string](m, QuoteKey)
	if !ok || text("quote", quote, MaxQuote) != nil {
		return Shown{}, false
	}
	raw, _ := get[map[string]any](m, AnchorKey)
	kind, _ := raw[typeKey].(string)
	t := Shown{ID: id, Kind: kind, Quote: Clean(quote, true)}
	switch kind {
	case AnchorText, AnchorCells:
	case AnchorNode:
		node, _ := raw[idKey].(string)
		t.Node = Clean(node, false)
	default:
		return Shown{}, false
	}
	t.Resolved, _ = get[bool](m, ResolvedKey)
	if messages, ok := get[*crdt.YMap](m, MessagesKey); ok {
		for _, mid := range slices.Sorted(slices.Values(messages.Keys())) {
			if len(t.Messages) == MaxMessages {
				break
			}
			v, _ := messages.Get(mid)
			msg, ok := messageOut(v)
			if !ok || checkID(mid) != nil || msg.check() != nil {
				continue
			}
			author := Clean(msg.Author, false)
			if author == "" {
				author = "anonymous"
			}
			t.Messages = append(t.Messages, ShownMessage{ID: mid, Author: author, Time: msg.Time, Body: Clean(msg.Body, true)})
		}
	}
	sortShown(t.Messages)
	return t, true
}

// Clean drops what could move the cursor or reorder the text around it, as
// the browser's clean does: control characters, but line breaks and tabs when
// lines is set, and bidi controls.
func Clean(s string, lines bool) string {
	return strings.Map(func(r rune) rune {
		if lines && (r == '\n' || r == '\t') {
			return r
		}
		if unicode.IsControl(r) || unicode.Is(unicode.Bidi_Control, r) {
			return -1
		}
		return r
	}, s)
}

// CutUnits cuts s to at most max UTF-16 code units, as JavaScript's slice
// does, without cutting a character in two.
func CutUnits(s string, max int) string {
	n := 0
	for i, r := range s {
		if n += utf16.RuneLen(r); n > max {
			return s[:i]
		}
	}
	return s
}

// The kinds of Change.
const (
	ChangeComment  = "comment"
	ChangeEdited   = "edited"
	ChangeDeleted  = "deleted"
	ChangeResolved = "resolved"
	ChangeReopened = "reopened"
)

// Change is something that happened to the threads between two readings.
type Change struct {
	Kind   string
	Thread Shown
	// Message is the comment added, edited or deleted; for a thread that
	// went, its zero value.
	Message ShownMessage
	// NewThread marks the first comment of a thread new since the last
	// reading.
	NewThread bool
}

// Diff tells what changed from before to after, in the order of after's
// threads and messages, then what was deleted.
func Diff(before, after []Shown) []Change {
	was := make(map[string]Shown, len(before))
	for _, t := range before {
		was[t.ID] = t
	}
	var out []Change
	for _, t := range after {
		old, existed := was[t.ID]
		delete(was, t.ID)
		out = append(out, threadChanges(old, t, existed)...)
	}
	for _, t := range before {
		if _, gone := was[t.ID]; gone {
			out = append(out, Change{Kind: ChangeDeleted, Thread: t})
		}
	}
	return out
}

// threadChanges tells what changed in one thread: its comments added,
// edited and deleted, then its resolving or reopening.
func threadChanges(old, t Shown, existed bool) []Change {
	oldMessages := map[string]ShownMessage{}
	for _, m := range old.Messages {
		oldMessages[m.ID] = m
	}
	var out []Change
	for i, m := range t.Messages {
		o, ok := oldMessages[m.ID]
		delete(oldMessages, m.ID)
		if !ok {
			out = append(out, Change{Kind: ChangeComment, Thread: t, Message: m, NewThread: len(old.Messages) == 0 && i == 0})
		} else if o.Body != m.Body {
			out = append(out, Change{Kind: ChangeEdited, Thread: t, Message: m})
		}
	}
	for _, m := range old.Messages {
		if _, gone := oldMessages[m.ID]; gone {
			out = append(out, Change{Kind: ChangeDeleted, Thread: t, Message: m})
		}
	}
	if existed && old.Resolved != t.Resolved {
		kind := ChangeReopened
		if t.Resolved {
			kind = ChangeResolved
		}
		out = append(out, Change{Kind: kind, Thread: t})
	}
	return out
}

// ShownSaved lists the threads of a saved metadata file as ShownThreads
// lists a doc's: cleaned, in the order of their first comment, then by id.
func ShownSaved(f *File) []Shown {
	var out []Shown
	for id, t := range f.Comments {
		s := Shown{ID: id, Kind: t.Anchor.Type, Quote: Clean(t.Quote, true), Resolved: t.Resolved}
		if t.Anchor.Type == AnchorNode {
			s.Node = Clean(t.Anchor.ID, false)
		}
		for mid, m := range t.Messages {
			author := Clean(m.Author, false)
			if author == "" {
				author = "anonymous"
			}
			s.Messages = append(s.Messages, ShownMessage{ID: mid, Author: author, Time: m.Time, Body: Clean(m.Body, true)})
		}
		sortShown(s.Messages)
		out = append(out, s)
	}
	slices.SortStableFunc(out, func(a, b Shown) int {
		if c := strings.Compare(firstTime(a), firstTime(b)); c != 0 {
			return c
		}
		return strings.Compare(a.ID, b.ID)
	})
	return out
}

func sortShown(messages []ShownMessage) {
	slices.SortStableFunc(messages, func(a, b ShownMessage) int {
		if c := strings.Compare(a.Time, b.Time); c != 0 {
			return c
		}
		return strings.Compare(a.ID, b.ID)
	})
}
