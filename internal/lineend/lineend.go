// Package lineend holds a file whose lines all end in CRLF as LF in a
// document, and writes it back with CRLF.
//
// A CodeMirror client counts "\r\n" as one character while Y.Text counts two,
// so with CRs in the shared text every browser edit lands one position
// further per preceding line (#372, #382). A file with mixed endings is held
// as it is, and browser editing of it is unsupported: edits may be misplaced.
package lineend

import "strings"

// IsCRLF reports whether every line of s ends in CRLF (and s has a line end).
func IsCRLF(s string) bool {
	crlf := strings.Count(s, "\r\n")
	return crlf > 0 && crlf == strings.Count(s, "\n") && crlf == strings.Count(s, "\r")
}

// ToDoc is the document's form of file text: LF when crlf is set.
func ToDoc(s string, crlf bool) string {
	if crlf {
		return strings.ReplaceAll(s, "\r\n", "\n")
	}
	return s
}

// FromDoc is the file's form of document text. When crlf is set every line
// ends in CRLF, also in a document that still holds CRLF (one kept before
// line endings were handled).
func FromDoc(s string, crlf bool) string {
	if crlf {
		return strings.ReplaceAll(strings.ReplaceAll(s, "\r\n", "\n"), "\n", "\r\n")
	}
	return s
}

// Doc is the document's form of file text, detecting the endings itself.
func Doc(s string) string { return ToDoc(s, IsCRLF(s)) }
