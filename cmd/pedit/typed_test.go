package main

import (
	"context"
	"io"
	"slices"
	"strconv"
	"strings"
	"testing"
	"time"
	"unicode/utf8"

	"github.com/piconic-ai/pedit/internal/protocol"
)

// screen is a terminal as small as what pedit draws on it needs: printable
// text that wraps at width, CR, LF, cursor up, erase below and erase line.
// Colors are dropped.
type screen struct {
	width int
	rows  [][]rune
	x, y  int
}

func (s *screen) Write(b []byte) (int, error) {
	text := string(b)
	for i := 0; i < len(text); {
		c := text[i]
		switch {
		case c == '\r':
			s.x = 0
			i++
		case c == '\n':
			s.y++
			i++
		case c == 27:
			n, _ := escapeLength([]byte(text[i:]))
			s.escape(text[i : i+n])
			i += n
		default:
			r, size := utf8.DecodeRuneInString(text[i:])
			if s.x >= s.width {
				s.x, s.y = 0, s.y+1
			}
			s.row()
			for len(s.rows[s.y]) <= s.x {
				s.rows[s.y] = append(s.rows[s.y], ' ')
			}
			s.rows[s.y][s.x] = r
			if runeWidth(r) == 2 {
				// The second column of a wide character.
				if len(s.rows[s.y]) <= s.x+1 {
					s.rows[s.y] = append(s.rows[s.y], 0)
				}
				s.rows[s.y][s.x+1] = 0
			}
			s.x += runeWidth(r)
			i += size
		}
	}
	return len(b), nil
}

func (s *screen) row() {
	for len(s.rows) <= s.y {
		s.rows = append(s.rows, nil)
	}
}

func (s *screen) escape(seq string) {
	if len(seq) < 3 || seq[1] != '[' {
		return
	}
	arg, final := seq[2:len(seq)-1], seq[len(seq)-1]
	switch final {
	case 'A':
		n, _ := strconv.Atoi(arg)
		s.y -= max(n, 1)
	case 'J':
		s.row()
		s.rows[s.y] = s.rows[s.y][:min(s.x, len(s.rows[s.y]))]
		s.rows = s.rows[:s.y+1]
	case 'K':
		s.row()
		s.rows[s.y] = nil
	}
}

// lines is what the screen shows, without trailing spaces.
func (s *screen) lines() []string {
	var out []string
	for _, r := range s.rows {
		out = append(out, strings.TrimRight(strings.ReplaceAll(string(r), "\x00", ""), " "))
	}
	return out
}

func feedAll(e *editor, chunks ...string) (events []string) {
	for _, chunk := range chunks {
		e.feed([]byte(chunk), func(ev edit, line string) {
			switch ev {
			case edited:
				events = append(events, "edited:"+string(e.line))
			case entered:
				events = append(events, "entered:"+line)
			case interrupted:
				events = append(events, "interrupted")
			}
		})
	}
	return events
}

func TestEditor(t *testing.T) {
	tests := []struct {
		name   string
		chunks []string
		want   []string
	}{
		{"typed and entered", []string{"later.md\r"}, []string{"edited:later.md", "entered:later.md"}},
		{"CRLF is one Enter", []string{"a\r\nb\n"}, []string{"edited:a", "entered:a", "edited:b", "entered:b"}},
		{"empty Enter", []string{"\r"}, []string{"entered:"}},
		{"backspace", []string{"ab\x7f", "c\x08d\r"}, []string{"edited:a", "edited:ad", "entered:ad"}},
		{"backspace on nothing", []string{"\x7f"}, nil},
		{"Ctrl+U", []string{"abc\x15x\r"}, []string{"edited:x", "entered:x"}},
		{"Ctrl+U on nothing", []string{"\x15"}, nil},
		{"CR last in a read, LF first in the next", []string{"a\r", "\n"}, []string{"edited:a", "entered:a", "entered:"}},
		{"Ctrl+C", []string{"ab\x03"}, []string{"edited:ab", "interrupted"}},
		{"arrows are ignored", []string{"a\x1b[D\x1b[Cb\x1bOA\r"}, []string{"edited:ab", "entered:ab"}},
		{"an escape sequence split across reads", []string{"a\x1b[", "1;5", "Db\r"}, []string{"edited:a", "edited:ab", "entered:ab"}},
		{"a read that ends after Esc", []string{"notes\x1b", "[D.md\r"}, []string{"edited:notes", "edited:notes.md", "entered:notes.md"}},
		{"a character split across reads", []string{"caf\xc3", "\xa9.md\r"}, []string{"edited:caf", "edited:café.md", "entered:café.md"}},
		{"other control characters are ignored", []string{"a\tb\x01\r"}, []string{"edited:ab", "entered:ab"}},
		{"invalid UTF-8 is dropped", []string{"a\xffb\r"}, []string{"edited:ab", "entered:ab"}},
		{"Alt+key", []string{"\x1bfa\r"}, []string{"edited:a", "entered:a"}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			var e editor
			if got := feedAll(&e, tt.chunks...); !slices.Equal(got, tt.want) {
				t.Fatalf("got %q, want %q", got, tt.want)
			}
		})
	}
}

func TestEditorDropsAnEndlessEscape(t *testing.T) {
	var e editor
	got := feedAll(&e, "\x1b["+strings.Repeat("1", 40)+"a\r")
	rest := strings.Repeat("1", 40-(maxEscape-1)) + "a"
	if want := []string{"edited:" + rest, "entered:" + rest}; !slices.Equal(got, want) {
		t.Fatalf("got %q, want %q", got, want)
	}
}

func TestReadTyped(t *testing.T) {
	var out strings.Builder
	u := newUI(&out, true, false)
	r, w := io.Pipe()
	var resumed, interrupted int
	var added []string
	done := make(chan struct{})
	go func() {
		readTyped(context.Background(), r, u, func() { resumed++ }, func(path string) { added = append(added, path) }, func() { interrupted++ })
		close(done)
	}()
	for _, chunk := range []string{"\r", "'a b.md'\r", "later", ".md\r", "x\x03"} {
		if _, err := w.Write([]byte(chunk)); err != nil {
			t.Fatal(err)
		}
	}
	w.Close()
	<-done
	if resumed != 1 || interrupted != 1 {
		t.Fatalf("resumed %d, interrupted %d times; want once each", resumed, interrupted)
	}
	if want := []string{"a b.md", "later.md"}; !slices.Equal(added, want) {
		t.Fatalf("added %q, want %q", added, want)
	}
	if string(u.typed) != "x" {
		t.Fatalf("typed %q, want x", string(u.typed))
	}
}

// The Esc key alone does nothing, and does not take the key after it.
func TestReadTypedEscKey(t *testing.T) {
	// Long enough that the second half of a split key arrives in time, even
	// on a loaded machine.
	defer func(d time.Duration) { escWait = d }(escWait)
	escWait = 250 * time.Millisecond
	u := newUI(io.Discard, true, false)
	r, w := io.Pipe()
	var added []string
	done := make(chan struct{})
	go func() {
		readTyped(context.Background(), r, u, func() {}, func(path string) { added = append(added, path) }, func() {})
		close(done)
	}()
	for _, step := range []struct {
		chunk string
		pause bool
	}{
		{"a\x1b", true}, // the Esc key, then b
		{"b\r", false},
		{"c\x1b", false}, // a left arrow split across reads
		{"[Dd\r", false},
	} {
		if _, err := w.Write([]byte(step.chunk)); err != nil {
			t.Fatal(err)
		}
		if step.pause {
			time.Sleep(4 * escWait)
		}
	}
	w.Close()
	<-done
	if want := []string{"ab", "cd"}; !slices.Equal(added, want) {
		t.Fatalf("added %q, want %q", added, want)
	}
}

func TestReadTypedStopsWhenDone(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	added := 0
	readTyped(ctx, strings.NewReader("later.md\r"), newUI(io.Discard, true, false), func() {}, func(string) { added++ }, func() {})
	if added != 0 {
		t.Fatal("added a file after the session ended")
	}
}

// The live line changes while the host types: what they typed stays on its
// own line, and notices go above both.
func TestUITypingKeepsItsOwnLine(t *testing.T) {
	s := &screen{width: 60}
	u := newUI(s, true, true)
	u.width = func() int { return s.width }
	u.sharing([]string{"agenda.md"}, "https://pedit.example.com/r/AAAA#key", false, false)
	u.setStatus(protocol.StatusConnected)
	before := len(s.lines()) - 1 // the rows above the live line

	u.startTyping()
	u.setTyped([]rune("lat"))
	u.setPeople([]string{"kobaken"})
	u.setTyped([]rune("later.md"))
	u.imageSaved("assets/cc5a.png")
	u.setPeople([]string{"kobaken", "mika"})
	u.added("later.md")
	u.setTyped(nil)
	u.setTyped([]rune("notes"))

	want := []string{
		"  Saved an image to assets/cc5a.png",
		"  ✓ Sharing later.md too.",
		"  ● kobaken and mika are here",
		"  Add a file: notes",
	}
	if got := s.lines()[before:]; !slices.Equal(got, want) {
		t.Fatalf("screen ends with\n%q\nwant\n%q", got, want)
	}
	if s.y != len(s.rows)-1 || s.x != len("  Add a file: notes") {
		t.Fatalf("cursor at %d,%d, want after what is typed", s.x, s.y)
	}

	// Stopping leaves the live line last, as without typing.
	u.stopTyping()
	u.stopLive()
	want = []string{"  Saved an image to assets/cc5a.png", "  ✓ Sharing later.md too.", "  ● kobaken and mika are here"}
	if got := s.lines()[before:]; !slices.Equal(got, want) {
		t.Fatalf("after stopping, screen ends with\n%q\nwant\n%q", got, want)
	}
	if s.y != len(s.rows) {
		t.Fatalf("cursor on row %d, want below the live line", s.y)
	}
}

// A live line longer than the terminal wraps; the typed line still redraws
// in place, and a long path shows its end.
func TestUITypingOnANarrowTerminal(t *testing.T) {
	s := &screen{width: 30}
	u := newUI(s, true, true)
	u.width = func() int { return s.width }
	u.sharing([]string{"agenda.md"}, "https://pedit.example.com/r/AAAA#key", false, false)
	u.setStatus(protocol.StatusConnected)
	u.startTyping()
	before := len(s.lines()) - 2
	u.setPeople([]string{"kobayashi", "nakamura", "yamamoto", "watanabe"})
	u.setTyped([]rune("docs/meetings/2026/október/agenda.md"))
	u.setPeople([]string{"kobayashi", "nakamura", "yamamoto", "watanabe", "suzuki"})
	u.setTyped([]rune("会議/議事録.md"))
	want := []string{
		"  ● kobayashi, nakamura and 3", // the space after 3 ends the row
		"others are here",
		"  Add a file: 会議/議事録.md",
	}
	if got := s.lines()[before:]; !slices.Equal(got, want) {
		t.Fatalf("screen ends with\n%q\nwant\n%q", got, want)
	}
	u.setTyped([]rune("docs/meetings/2026/agenda.md"))
	if got := s.lines()[len(s.lines())-1]; got != "  Add a file: …2026/agenda.md" {
		t.Fatalf("typed line %q", got)
	}
	if got := visualWidth("  Add a file: …2026/agenda.md"); got >= s.width {
		t.Fatalf("typed line takes %d columns of %d", got, s.width)
	}
}

func TestCRLFWriter(t *testing.T) {
	var b strings.Builder
	w := &crlfWriter{w: &b}
	io.WriteString(w, "a\nb\r\n")
	w.raw.Store(true)
	io.WriteString(w, "c\nd\r\n\n")
	if got, want := b.String(), "a\nb\r\nc\r\nd\r\n\r\n"; got != want {
		t.Fatalf("got %q, want %q", got, want)
	}
}

func TestVisualWidth(t *testing.T) {
	for s, want := range map[string]int{
		"agenda.md":                  9,
		"\x1b[32m●\x1b[0m here":      6,
		"議事録.md":                     9,
		"café":                       4,
		"\x1b[2mAdd a file: \x1b[0m": 12,
	} {
		if got := visualWidth(s); got != want {
			t.Errorf("visualWidth(%q) = %d, want %d", s, got, want)
		}
	}
}
