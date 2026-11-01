package lineend

import "testing"

func TestIsCRLF(t *testing.T) {
	for s, want := range map[string]bool{"a\r\nb\r\n": true, "a\nb\n": false, "a\r\nb\n": false, "a\rb\r\n": false, "": false} {
		if IsCRLF(s) != want {
			t.Errorf("IsCRLF(%q) = %v", s, !want)
		}
	}
}

func TestRoundTrip(t *testing.T) {
	const file = "\ufeff---\r\na: 1\r\n---\r\nx\r\n\r\n"
	doc := ToDoc(file, IsCRLF(file))
	if doc != "\ufeff---\na: 1\n---\nx\n\n" {
		t.Fatalf("doc = %q", doc)
	}
	if got := FromDoc(doc, true); got != file {
		t.Fatalf("file = %q", got)
	}
	if got := FromDoc("a\r\nb\n", true); got != "a\r\nb\r\n" {
		t.Fatalf("a document still holding CRLF = %q", got)
	}
	if got := FromDoc("a\r\nb\n", false); got != "a\r\nb\n" {
		t.Fatalf("mixed = %q", got)
	}
}
