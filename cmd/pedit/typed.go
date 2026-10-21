package main

import (
	"context"
	"io"
	"sync/atomic"
	"time"
	"unicode/utf8"

	"golang.org/x/text/width"
)

// While sharing on a terminal, the host types paths on a line of their own,
// below the live line. The terminal is raw then, so that what they type is
// drawn by pedit, out of the way of the live line, rather than echoed into it.

// edit is what a key did to the typed line.
type edit int

const (
	edited edit = iota
	entered
	interrupted
)

// maxEscape bounds an escape sequence pedit waits to see the end of.
const maxEscape = 32

// editor keeps the line being typed, from the bytes a raw terminal sends.
type editor struct {
	line []rune
	// pending is the start of a character or escape sequence whose end has
	// not arrived yet.
	pending []byte
}

// feed takes the bytes typed. on hears each Enter with the line entered, and
// Ctrl+C; it hears edited once, after the keys that changed the line.
// Arrows and other keys that send escape sequences are ignored.
func (e *editor) feed(b []byte, on func(edit, string)) {
	data := append(e.pending, b...)
	e.pending = nil
	changed := false
	for i := 0; i < len(data); {
		n, ev, ok := e.key(data[i:])
		if n == 0 {
			e.pending = append([]byte(nil), data[i:]...)
			break
		}
		i += n
		if !ok {
			continue
		}
		if ev == edited {
			changed = true
			continue
		}
		if changed {
			on(edited, "")
			changed = false
		}
		line := ""
		if ev == entered {
			line = string(e.line)
			e.line = nil
		}
		on(ev, line)
	}
	if changed {
		on(edited, "")
	}
}

// key takes the key at the start of data: how many bytes it took, or 0 when
// its end has not arrived yet, and what it did, if anything.
func (e *editor) key(data []byte) (int, edit, bool) {
	c := data[0]
	switch {
	case c == '\r' || c == '\n':
		if c == '\r' && len(data) > 1 && data[1] == '\n' {
			return 2, entered, true
		}
		return 1, entered, true
	case c == 3: // Ctrl+C
		return 1, interrupted, true
	case c == 127 || c == 8: // Backspace
		if len(e.line) == 0 {
			return 1, edited, false
		}
		e.line = e.line[:len(e.line)-1]
		return 1, edited, true
	case c == 21: // Ctrl+U
		changed := len(e.line) > 0
		e.line = nil
		return 1, edited, changed
	case c == 27:
		n, complete := escapeLength(data)
		if !complete {
			return 0, edited, false
		}
		return n, edited, false
	case c < 32:
		return 1, edited, false
	}
	if !utf8.FullRune(data) {
		return 0, edited, false
	}
	r, size := utf8.DecodeRune(data)
	if r == utf8.RuneError && size == 1 {
		return 1, edited, false
	}
	e.line = append(e.line, r)
	return size, edited, true
}

// lonelyEsc reports whether all that is pending is an Esc: the Esc key, or
// the start of a key whose sequence has yet to arrive.
func (e *editor) lonelyEsc() bool {
	return len(e.pending) == 1 && e.pending[0] == 27
}

// escapeLength is how many bytes the escape sequence at the start of b takes,
// or false when its end has not arrived yet. A sequence that runs on longer
// than any key sends is dropped whole.
func escapeLength(b []byte) (int, bool) {
	if len(b) < 2 {
		return 0, false
	}
	switch b[1] {
	case '[':
		for j := 2; j < len(b); j++ {
			if b[j] >= 0x40 && b[j] <= 0x7e {
				return j + 1, true
			}
			if j >= maxEscape {
				return j + 1, true
			}
		}
		if len(b) >= maxEscape {
			return len(b), true
		}
		return 0, false
	case 'O':
		if len(b) < 3 {
			return 0, false
		}
		return 3, true
	}
	return 2, true
}

// readTyped reads what the host types into a raw terminal, until in ends or
// ctx is done. The line goes to the ui as it changes. An empty line calls
// resume and any other is the path of a file to add, as with readLines;
// Ctrl+C calls interrupt, since a raw terminal sends no signal for it.
//
// A read may end in the middle of a key, so an Esc last in a read waits for
// the rest of its sequence; when nothing follows within escWait, it was the
// Esc key alone, which does nothing.
func readTyped(ctx context.Context, in io.Reader, out *ui, resume func(), add func(path string), interrupt func()) {
	chunks := make(chan []byte)
	go func() {
		defer close(chunks)
		buf := make([]byte, 256)
		for {
			n, err := in.Read(buf)
			if n > 0 {
				select {
				case chunks <- append([]byte(nil), buf[:n]...):
				case <-ctx.Done():
					return
				}
			}
			if err != nil {
				return
			}
		}
	}()
	var e editor
	on := func(ev edit, line string) {
		switch ev {
		case edited:
			out.setTyped(e.line)
		case entered:
			out.setTyped(nil)
			if path := typedPath(line); path == "" {
				resume()
			} else {
				add(path)
			}
		case interrupted:
			interrupt()
		}
	}
	for {
		var esc <-chan time.Time
		if e.lonelyEsc() {
			esc = time.After(escWait)
		}
		select {
		case b, ok := <-chunks:
			if !ok || ctx.Err() != nil {
				return
			}
			e.feed(b, on)
		case <-esc:
			e.pending = nil
		case <-ctx.Done():
			return
		}
	}
}

// escWait is how long an Esc waits for the rest of a key's sequence.
var escWait = 50 * time.Millisecond

// crlfWriter ends lines with CRLF while raw is set: a raw terminal moves down
// on LF without going back to the start of the line.
type crlfWriter struct {
	w   io.Writer
	raw atomic.Bool
}

func (c *crlfWriter) Write(b []byte) (int, error) {
	if !c.raw.Load() {
		return c.w.Write(b)
	}
	out := make([]byte, 0, len(b)+8)
	for i, x := range b {
		if x == '\n' && (i == 0 || b[i-1] != '\r') {
			out = append(out, '\r')
		}
		out = append(out, x)
	}
	if _, err := c.w.Write(out); err != nil {
		return 0, err
	}
	return len(b), nil
}

// visualWidth is how many columns s takes on a terminal, leaving out the
// escape sequences that color it.
func visualWidth(s string) int {
	n := 0
	for i := 0; i < len(s); {
		if s[i] == 27 {
			l, complete := escapeLength([]byte(s[i:]))
			if !complete {
				break
			}
			i += l
			continue
		}
		r, size := utf8.DecodeRuneInString(s[i:])
		n += runeWidth(r)
		i += size
	}
	return n
}

func runeWidth(r rune) int {
	switch width.LookupRune(r).Kind() {
	case width.EastAsianWide, width.EastAsianFullwidth:
		return 2
	}
	return 1
}
