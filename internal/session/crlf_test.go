package session

import (
	"os"
	"testing"

	"github.com/piconic-ai/pedit/internal/protocol/prototest"
	"github.com/reearth/ygo/crdt"
)

// A CRLF file is held as LF in the doc and written back with CRLF (#382).
func TestCRLFFileIsHeldAsLFAndWrittenBackWithCRLF(t *testing.T) {
	f := setup(t, "a\r\nb\r\nc\r\n", setupOpts{})
	g := joinAsGuest(t, f.relay, f.session.URL)
	prototest.WaitFor(t, wait, func() bool { return g.String() == "a\nb\nc\n" }, "guest to sync the LF form")
	// A CodeMirror client counts "\r\n" as one character: this is its offset.
	g.insert(len("a\nb\nc"), " edited")
	prototest.WaitFor(t, wait, func() bool { return readFile(t, f.file) == "a\r\nb\r\nc edited\r\n" }, "write back with CRLF")
	if got := f.session.Text.ToString(); got != "a\nb\nc edited\n" {
		t.Fatalf("the room holds %q", got)
	}
	// A line typed in the browser ends in CRLF in the file.
	g.insert(len("a\n"), "new\n")
	prototest.WaitFor(t, wait, func() bool { return readFile(t, f.file) == "a\r\nnew\r\nb\r\nc edited\r\n" }, "new line with CRLF")
}

func TestCRLFFileKeepsBOMAndFrontmatterByteForByte(t *testing.T) {
	const file = "\xef\xbb\xbf---\r\ntitle: A\r\n---\r\n\r\nbody\r\n"
	f := setup(t, file, setupOpts{})
	g := joinAsGuest(t, f.relay, f.session.URL)
	const doc = "\xef\xbb\xbf---\ntitle: A\n---\n\nbody\n"
	prototest.WaitFor(t, wait, func() bool { return g.String() == doc }, "guest to sync")
	// Offsets are UTF-16 units: the BOM is one.
	g.insert(1+len("---\ntitle: A\n---\n\nbody"), "!")
	prototest.WaitFor(t, wait, func() bool {
		return readFile(t, f.file) == "\xef\xbb\xbf---\r\ntitle: A\r\n---\r\n\r\nbody!\r\n"
	}, "write back")
}

func TestSaveThatChangesLineEndings(t *testing.T) {
	f := setup(t, "a\r\nb\r\n", setupOpts{watch: true})
	g := joinAsGuest(t, f.relay, f.session.URL)
	prototest.WaitFor(t, wait, func() bool { return g.String() == "a\nb\n" }, "guest to sync")
	// The file is saved with LF (and a new line) elsewhere: the doc keeps its text.
	if err := os.WriteFile(f.file, []byte("a\nb\nc\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	prototest.WaitFor(t, wait, func() bool { return g.String() == "a\nb\nc\n" }, "external save")
	g.insert(len("a\nb\nc"), "!")
	prototest.WaitFor(t, wait, func() bool { return readFile(t, f.file) == "a\nb\nc!\n" }, "written back with LF")
	// And back to CRLF.
	if err := os.WriteFile(f.file, []byte("a\r\nb\r\nc!\r\nd\r\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	prototest.WaitFor(t, wait, func() bool { return g.String() == "a\nb\nc!\nd\n" }, "external save with CRLF")
	g.insert(len("a\nb\nc!\nd"), "?")
	prototest.WaitFor(t, wait, func() bool { return readFile(t, f.file) == "a\r\nb\r\nc!\r\nd?\r\n" }, "written back with CRLF")
}

func TestMixedLineEndingsAreHeldAsTheyAre(t *testing.T) {
	const mixed = "a\r\nb\nc\r\n"
	f := setup(t, mixed, setupOpts{})
	g := joinAsGuest(t, f.relay, f.session.URL)
	prototest.WaitFor(t, wait, func() bool { return g.String() == mixed }, "guest to sync the text as it is")
	g.insert(len(mixed), "d")
	prototest.WaitFor(t, wait, func() bool { return readFile(t, f.file) == mixed+"d" }, "write back")
}

func TestKeptRoomOfACRLFFileIsTakenInAgain(t *testing.T) {
	const written = "a\r\nb\r\n"
	for name, kept := range map[string]string{"LF doc": "a\nb\n", "doc kept before line endings were handled": written} {
		t.Run(name, func(t *testing.T) {
			src := crdt.New()
			defer src.Destroy()
			text := src.GetText("content")
			src.Transact(func(tx *crdt.Transaction) { text.Insert(tx, 0, kept, nil) })
			doc := crdt.New()
			defer doc.Destroy()
			c, err := newContent(doc, "notes.md", written, crdt.EncodeStateAsUpdateV1(src, nil))
			if err != nil {
				t.Fatal(err)
			}
			if got := c.render(); got != written {
				t.Fatalf("render = %q", got)
			}
		})
	}
}
