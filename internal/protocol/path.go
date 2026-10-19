package protocol

import (
	"strings"
	"unicode"
	"unicode/utf8"

	"golang.org/x/text/cases"
	"golang.org/x/text/unicode/norm"
)

// Limits on a shared path, in bytes of UTF-8.
const (
	MaxPathBytes      = 1024
	MaxComponentBytes = 255
)

// PathProblem is why CheckPath refuses a path. packages/protocol's checkPath
// gives the same answer for every path in packages/testdata/path-vectors.json.
type PathProblem string

const (
	PathEmpty            PathProblem = "empty"
	PathTooLong          PathProblem = "too-long"
	PathEncoding         PathProblem = "encoding"
	PathBackslash        PathProblem = "backslash"
	PathControl          PathProblem = "control"
	PathBidi             PathProblem = "bidi"
	PathAbsolute         PathProblem = "absolute"
	PathComponent        PathProblem = "component"
	PathComponentTooLong PathProblem = "component-too-long"
	PathCharacter        PathProblem = "character"
	PathTrailing         PathProblem = "trailing"
	PathReserved         PathProblem = "reserved"
)

func (p PathProblem) Error() string { return "unsafe path: " + string(p) }

// CheckPath tells whether p may name a file shared in a room, whatever the
// platform of the host or of a guest that writes it: it returns nil, or the
// first problem it finds. A path is relative and "/"-separated, with no
// empty, "." or ".." component, and no name Windows or macOS would read
// differently from Linux: no "\", control or bidi characters, reserved
// device names, ":" (an NTFS stream) or <>"|?*, and no component ending in
// a dot or a space. filepath.IsLocal accepts most of these on Linux.
//
// Two paths CheckPath accepts can still name one file on macOS or Windows;
// compare their PathKey for that.
func CheckPath(p string) error {
	if p == "" {
		return PathEmpty
	}
	if len(p) > MaxPathBytes {
		return PathTooLong
	}
	if !utf8.ValidString(p) {
		return PathEncoding
	}
	for _, r := range p {
		switch {
		case r == '\\':
			return PathBackslash
		case unicode.IsControl(r):
			return PathControl
		case unicode.Is(unicode.Bidi_Control, r):
			return PathBidi
		}
	}
	if p[0] == '/' {
		return PathAbsolute
	}
	for c := range strings.SplitSeq(p, "/") {
		if err := checkComponent(c); err != nil {
			return err
		}
	}
	return nil
}

func checkComponent(c string) error {
	switch {
	case c == "" || c == "." || c == "..":
		return PathComponent
	case len(c) > MaxComponentBytes:
		return PathComponentTooLong
	case strings.ContainsAny(c, `:<>"|?*`):
		return PathCharacter
	case strings.HasSuffix(c, ".") || strings.HasSuffix(c, " "):
		return PathTrailing
	case reservedOnWindows(c):
		return PathReserved
	}
	return nil
}

// reservedOnWindows tells a device name, which Windows keeps whatever the
// case, the extension or the spaces before it: "con", "CON.md", "Com1 .txt",
// "conin$".
// It counts the superscript digits Windows takes as COM and LPT ports too.
func reservedOnWindows(c string) bool {
	stem, _, _ := strings.Cut(c, ".")
	stem = asciiUpper(strings.TrimRight(stem, " "))
	switch stem {
	case "CON", "PRN", "AUX", "NUL", "CONIN$", "CONOUT$":
		return true
	}
	if rest, ok := strings.CutPrefix(stem, "COM"); ok {
		return portDigit(rest)
	}
	if rest, ok := strings.CutPrefix(stem, "LPT"); ok {
		return portDigit(rest)
	}
	return false
}

func portDigit(s string) bool {
	switch s {
	case "0", "1", "2", "3", "4", "5", "6", "7", "8", "9", "¹", "²", "³":
		return true
	}
	return false
}

// asciiUpper upper-cases ASCII letters only, as Windows does for device
// names and as packages/protocol does, so no other letter folds into one.
func asciiUpper(s string) string {
	return strings.Map(func(r rune) rune {
		if 'a' <= r && r <= 'z' {
			return r - 'a' + 'A'
		}
		return r
	}, s)
}

// PathKey returns what p is compared by: two paths with the same key may be
// one file where names are case-insensitive or normalized, as by default on
// macOS and Windows ("Notes.md" and "notes.md", or "café.md" in NFC and in
// NFD), though Linux keeps them apart.
func PathKey(p string) string {
	return norm.NFC.String(cases.Fold().String(norm.NFC.String(p)))
}
