package merge

import "testing"

// Text typed just before a deleted region is not part of it.
func TestExternalEditKeepsTextInsertedAtTheStartOfADeletion(t *testing.T) {
	doc, text := textOf("abc")
	remote(doc, text, 1, "X")
	ExternalEdit(doc, text, "abc", "ac", nil)
	if got := text.ToString(); got != "aXc" {
		t.Fatalf("got %q, want aXc", got)
	}
}
