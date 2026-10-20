package session

import (
	"fmt"
	"strings"
)

// A guest from the command line names its copies itself. The host names the
// room's files, and a name can mean something to the guest's computer: a
// directory such as .git, a file such as desktop.ini, an extension such as
// .bat or .scf. So a copy's name keeps only what tells the files apart to a
// person: the file's id, the letters and digits of the host's path, and an
// extension from a short list of text formats. Every copy goes in one
// directory, with no directory of its own.

// copyExts are the extensions a copy keeps: text formats that no common
// program runs or follows a link from when the file is opened. Any other
// becomes .txt.
var copyExts = map[string]bool{
	"md": true, "markdown": true, "txt": true,
	"csv": true, "tsv": true,
	"json": true, "yaml": true, "yml": true, "toml": true,
}

// maxSlug bounds the part of a copy's name taken from the host's path, so the
// path of a copy stays short on Windows.
const maxSlug = 40

// copyName is the name of the copy of the file id, shared as hostPath: the
// id, padded to two digits, then the letters and digits of hostPath's
// directories and name, joined by "-", then an extension. "docs/spec.md" as
// file 1 is "01-docs-spec.md", ".git/config" as file 2 "02-git-config.txt",
// and "会議.md" as file 3 "03.md". Two ids never share a name, whatever the
// file system folds together.
func copyName(id uint64, hostPath string) string {
	parts := strings.Split(hostPath, "/")
	last := parts[len(parts)-1]
	ext := ""
	if i := strings.LastIndexByte(last, '.'); i > 0 {
		last, ext = last[:i], asciiLower(last[i+1:])
	}
	if !copyExts[ext] {
		ext = "txt"
	}
	var words []string
	for _, part := range append(parts[:len(parts)-1:len(parts)-1], last) {
		words = append(words, slugWords(part)...)
	}
	slug := strings.Join(words, "-")
	if len(slug) > maxSlug {
		// The end names the file; the start, its directories. Whole words
		// only, unless one word is all there is.
		cut := slug[len(slug)-maxSlug:]
		if i := strings.IndexByte(cut, '-'); i >= 0 {
			cut = cut[i+1:]
		}
		slug = cut
	}
	name := fmt.Sprintf("%02d", id)
	if slug != "" {
		name += "-" + slug
	}
	return name + "." + ext
}

// slugWords are the runs of ASCII letters and digits in s.
func slugWords(s string) []string {
	return strings.FieldsFunc(s, func(r rune) bool {
		return !('a' <= r && r <= 'z' || 'A' <= r && r <= 'Z' || '0' <= r && r <= '9')
	})
}

// asciiLower lowers ASCII letters only: Unicode case folding would read the
// Kelvin sign as k.
func asciiLower(s string) string {
	return strings.Map(func(r rune) rune {
		if 'A' <= r && r <= 'Z' {
			return r + 'a' - 'A'
		}
		return r
	}, s)
}
