package merge

import (
	"testing"
	"unicode/utf8"
)

// With no concurrent remote edit, applying an external edit must leave the
// document equal to the file on disk, whatever the two texts are.
func FuzzExternalEdit(f *testing.F) {
	f.Add("", "")
	f.Add("hello world\n", "hello, world!\n")
	f.Add("🌏 こんにちは\n", "🌏 こんばんは\n😀\n")
	f.Add("a\r\nb\r\n", "a\nb\n")
	f.Fuzz(func(t *testing.T, base, next string) {
		// pedit only shares UTF-8 files.
		if !utf8.ValidString(base) || !utf8.ValidString(next) {
			return
		}
		doc, text := textOf(base)
		ExternalEdit(doc, text, base, next, nil)
		if got := text.ToString(); got != next {
			t.Fatalf("ExternalEdit(%q -> %q) left %q", base, next, got)
		}
	})
}
