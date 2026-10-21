// Package meta reads and writes the metadata file pedit keeps for a shared
// file under .pedit/meta/, which holds its comments (#121). The host is the
// only writer, but the file may come from someone else through Git, so Parse
// checks it as input from other people: a file that breaks a rule is refused
// as a whole, and pedit leaves it untouched. docs/design/comments.md has the
// design.
package meta

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"maps"
	"regexp"
	"slices"
	"time"
	"unicode/utf8"

	"github.com/piconic-ai/pedit/internal/protocol"
)

// Version is the version of the file this package reads and writes. A field
// added anywhere but at the top level needs a new version: Parse refuses keys
// it does not know below the top level, so an older pedit never drops them.
const Version = 1

// Limits on what a metadata file may hold, in bytes for the file and in
// characters for text.
const (
	MaxFileBytes = 1 << 20
	MaxThreads   = 500
	MaxMessages  = 200
	MaxBody      = 4000
	MaxAuthor    = 200
	MaxQuote     = 1000
	MaxContext   = 32
	MaxNodeID    = 1024
	maxOffset    = 1<<31 - 1
)

// The kinds of anchor.
const (
	AnchorText  = "text"
	AnchorCells = "cells"
	AnchorNode  = "node"
)

var idPattern = regexp.MustCompile(`^[A-Za-z0-9_-]{1,32}$`)

// ErrVersion marks a file of a version this pedit does not know.
var ErrVersion = errors.New("written by a newer pedit")

// File is a metadata file: the path of the file it belongs to, its comment
// threads keyed by id, and any top-level keys a newer pedit wrote.
type File struct {
	Path     string
	Comments map[string]Thread
	extra    map[string]json.RawMessage
}

// Thread is a comment thread on one place of the file.
type Thread struct {
	Anchor   Anchor             `json:"anchor"`
	Quote    string             `json:"quote"`
	Resolved bool               `json:"resolved"`
	Messages map[string]Message `json:"messages"`
}

// Message is one comment in a thread. Time is RFC 3339, kept as written.
type Message struct {
	Author string `json:"author"`
	Time   string `json:"time"`
	Body   string `json:"body"`
}

// Anchor is where a thread pointed at the last save. A text anchor is one
// Selector; a cells anchor is a Selector for each corner cell of a range, the
// same cell for one; a node anchor is a canvas node id.
type Anchor struct {
	Type string    `json:"type"`
	Text *Selector `json:"-"`
	From *Selector `json:"from,omitempty"`
	To   *Selector `json:"to,omitempty"`
	ID   string    `json:"id,omitempty"`
}

// Selector is where some text was: the text itself, up to MaxContext
// characters before and after it, and its offset in UTF-16 code units, as Yjs
// counts. This is a W3C TextQuoteSelector with a position as a hint.
type Selector struct {
	Exact  string `json:"exact"`
	Prefix string `json:"prefix"`
	Suffix string `json:"suffix"`
	Offset int    `json:"offset"`
}

// MarshalJSON writes a text anchor's Selector beside its type.
func (a Anchor) MarshalJSON() ([]byte, error) {
	if a.Type == AnchorText && a.Text != nil {
		return json.Marshal(struct {
			Type string `json:"type"`
			Selector
		}{a.Type, *a.Text})
	}
	type plain Anchor
	return json.Marshal(plain(a))
}

// UnmarshalJSON reads an anchor of any type, refusing keys that do not belong
// to it.
func (a *Anchor) UnmarshalJSON(data []byte) error {
	var head struct {
		Type string `json:"type"`
	}
	if err := json.Unmarshal(data, &head); err != nil {
		return err
	}
	*a = Anchor{Type: head.Type}
	switch head.Type {
	case AnchorText:
		var v struct {
			Type string `json:"type"`
			Selector
		}
		if err := strict(data, &v); err != nil {
			return err
		}
		a.Text = &v.Selector
	case AnchorCells:
		var v struct {
			Type string    `json:"type"`
			From *Selector `json:"from"`
			To   *Selector `json:"to"`
		}
		if err := strict(data, &v); err != nil {
			return err
		}
		a.From, a.To = v.From, v.To
	case AnchorNode:
		var v struct {
			Type string `json:"type"`
			ID   string `json:"id"`
		}
		if err := strict(data, &v); err != nil {
			return err
		}
		a.ID = v.ID
	default:
		return fmt.Errorf("unknown anchor type %q", head.Type)
	}
	return nil
}

// strict decodes data into v, refusing keys v does not have and anything
// after the value.
func strict(data []byte, v any) error {
	dec := json.NewDecoder(bytes.NewReader(data))
	dec.DisallowUnknownFields()
	if err := dec.Decode(v); err != nil {
		return err
	}
	if dec.More() {
		return errors.New("trailing data")
	}
	return nil
}

// Parse reads a metadata file. It refuses one that is too large, is not
// valid JSON, has an unknown version (ErrVersion), or breaks a limit or rule;
// the error says what. Top-level keys it does not know are kept for Render.
func Parse(data []byte) (*File, error) {
	if len(data) > MaxFileBytes {
		return nil, fmt.Errorf("larger than %d bytes", MaxFileBytes)
	}
	var top map[string]json.RawMessage
	if err := strict(data, &top); err != nil {
		return nil, err
	}
	if top == nil {
		return nil, errors.New("not a JSON object")
	}
	var version int
	if err := json.Unmarshal(top["version"], &version); err != nil || version < 1 {
		return nil, errors.New("no valid version")
	}
	if version != Version {
		return nil, fmt.Errorf("%w (version %d)", ErrVersion, version)
	}
	f := &File{extra: map[string]json.RawMessage{}}
	if err := json.Unmarshal(top["path"], &f.Path); err != nil {
		return nil, errors.New("no valid path")
	}
	if raw, ok := top["comments"]; ok {
		if err := strict(raw, &f.Comments); err != nil {
			return nil, fmt.Errorf("comments: %w", err)
		}
	}
	for k, v := range top {
		if k != "version" && k != "path" && k != "comments" {
			f.extra[k] = v
		}
	}
	if err := f.Check(); err != nil {
		return nil, err
	}
	return f, nil
}

// Check tells whether f keeps every limit and rule, as Parse requires.
func (f *File) Check() error {
	if err := protocol.CheckPath(f.Path); err != nil {
		return fmt.Errorf("path: %w", err)
	}
	if len(f.Comments) > MaxThreads {
		return fmt.Errorf("more than %d threads", MaxThreads)
	}
	for id, t := range f.Comments {
		if err := t.check(id); err != nil {
			return fmt.Errorf("thread %q: %w", id, err)
		}
	}
	return nil
}

func (t Thread) check(id string) error {
	if !idPattern.MatchString(id) {
		return errors.New("invalid id")
	}
	if err := t.Anchor.check(); err != nil {
		return fmt.Errorf("anchor: %w", err)
	}
	if err := text("quote", t.Quote, MaxQuote); err != nil {
		return err
	}
	if len(t.Messages) > MaxMessages {
		return fmt.Errorf("more than %d messages", MaxMessages)
	}
	for mid, m := range t.Messages {
		if err := m.check(mid); err != nil {
			return fmt.Errorf("message %q: %w", mid, err)
		}
	}
	return nil
}

func (m Message) check(id string) error {
	if !idPattern.MatchString(id) {
		return errors.New("invalid id")
	}
	if _, err := time.Parse(time.RFC3339, m.Time); err != nil {
		return errors.New("invalid time")
	}
	return errors.Join(text("author", m.Author, MaxAuthor), text("body", m.Body, MaxBody))
}

func (a Anchor) check() error {
	switch a.Type {
	case AnchorText:
		if a.Text == nil {
			return errors.New("no selector")
		}
		return a.Text.check()
	case AnchorCells:
		if a.From == nil || a.To == nil {
			return errors.New("needs from and to")
		}
		return errors.Join(a.From.check(), a.To.check())
	case AnchorNode:
		if a.ID == "" || len(a.ID) > MaxNodeID || !utf8.ValidString(a.ID) {
			return errors.New("invalid node id")
		}
		return nil
	}
	return fmt.Errorf("unknown type %q", a.Type)
}

func (s *Selector) check() error {
	if s.Offset < 0 || s.Offset > maxOffset {
		return errors.New("invalid offset")
	}
	return errors.Join(
		text("exact", s.Exact, MaxQuote),
		text("prefix", s.Prefix, MaxContext),
		text("suffix", s.Suffix, MaxContext),
	)
}

func text(name, s string, max int) error {
	if !utf8.ValidString(s) {
		return fmt.Errorf("%s: invalid UTF-8", name)
	}
	if utf8.RuneCountInString(s) > max {
		return fmt.Errorf("%s: longer than %d characters", name, max)
	}
	return nil
}

// Render writes f as pedit saves it: indented, with version, path and
// comments first, then the top-level keys a newer pedit wrote, and keys in
// sorted order below, so the same metadata always gives the same bytes.
func Render(f *File) ([]byte, error) {
	keys := []string{"version", "path", "comments"}
	values := map[string]any{"version": Version, "path": f.Path, "comments": f.Comments}
	if f.Comments == nil {
		values["comments"] = map[string]Thread{}
	}
	for _, k := range slices.Sorted(maps.Keys(f.extra)) {
		keys = append(keys, k)
		values[k] = f.extra[k]
	}

	var out bytes.Buffer
	out.WriteString("{")
	for i, k := range keys {
		if i > 0 {
			out.WriteString(",")
		}
		v, err := marshal(values[k])
		if err != nil {
			return nil, err
		}
		key, _ := marshal(k)
		out.WriteString("\n  ")
		out.Write(key)
		out.WriteString(": ")
		out.Write(v)
	}
	out.WriteString("\n}\n")
	return out.Bytes(), nil
}

// marshal writes v as indented JSON inside the top-level object, without
// escaping <, > and &, which only matter in HTML.
func marshal(v any) ([]byte, error) {
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(v); err != nil {
		return nil, err
	}
	var out bytes.Buffer
	if err := json.Indent(&out, bytes.TrimRight(buf.Bytes(), "\n"), "  ", "  "); err != nil {
		return nil, err
	}
	return out.Bytes(), nil
}
