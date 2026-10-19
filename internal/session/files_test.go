package session

import (
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/piconic-ai/pedit/internal/attach"
	"github.com/piconic-ai/pedit/internal/protocol"
	"github.com/piconic-ai/pedit/internal/protocol/prototest"
	"github.com/reearth/ygo/awareness"
	"github.com/reearth/ygo/crdt"
)

// filesGuest is a guest that follows a room's files, as the editor will.
type filesGuest struct {
	*guest
	mu       sync.Mutex
	manifest []protocol.FileEntry
	docs     map[uint64]*crdt.Doc
	canvas   chan protocol.CanvasMessage
	images   chan protocol.Attachment
}

func joinFiles(t *testing.T, relay *prototest.Relay, shareURL string) *filesGuest {
	t.Helper()
	u, err := url.Parse(shareURL)
	if err != nil {
		t.Fatal(err)
	}
	key, err := protocol.DecodeKey(u.Fragment)
	if err != nil {
		t.Fatal(err)
	}
	doc := crdt.New()
	aw := awareness.New(uint64(doc.ClientID()))
	aw.SetLocalState(map[string]any{})
	g := &filesGuest{
		docs:   map[uint64]*crdt.Doc{},
		canvas: make(chan protocol.CanvasMessage, 4),
		images: make(chan protocol.Attachment, 4),
	}
	c, err := protocol.NewClient(protocol.ClientOptions{
		URL: "ws://guest", Key: key, Doc: doc, Awareness: aw, Dial: relay.Dial,
		OnManifest: func(files []protocol.FileEntry) {
			g.mu.Lock()
			defer g.mu.Unlock()
			g.manifest = files
		},
		OnFileCanvas:     func(_ uint64, m protocol.CanvasMessage) { g.canvas <- m },
		OnFileAttachment: func(_ uint64, a protocol.Attachment) { g.images <- a },
	})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(c.Destroy)
	c.Connect()
	g.guest = &guest{Client: c, doc: doc, text: doc.GetText("content"), aw: aw}
	return g
}

func (g *filesGuest) files() []protocol.FileEntry {
	g.mu.Lock()
	defer g.mu.Unlock()
	return g.manifest
}

// open follows file id, as the editor does when someone opens it.
func (g *filesGuest) open(t *testing.T, id uint64) *crdt.Doc {
	t.Helper()
	doc := crdt.New()
	if err := g.AddFile(id, doc); err != nil {
		t.Fatal(err)
	}
	g.mu.Lock()
	g.docs[id] = doc
	g.mu.Unlock()
	return doc
}

func textOf(doc *crdt.Doc) string { return doc.GetText("content").ToString() }

func insertInto(doc *crdt.Doc, index int, s string) {
	text := doc.GetText("content")
	doc.Transact(func(txn *crdt.Transaction) { text.Insert(txn, index, s, nil) })
}

// writeBeside writes a file next to the fixture's, creating directories.
func writeBeside(t *testing.T, f *fixture, name, content string) string {
	t.Helper()
	path := filepath.Join(filepath.Dir(f.file), filepath.FromSlash(name))
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
	return path
}

func TestAddFileSharesItInADocOfItsOwn(t *testing.T) {
	f := setup(t, "# agenda\n", setupOpts{watch: true})
	spec := writeBeside(t, f, "docs/spec.md", "# spec\n")
	entry, err := f.session.AddFile(spec)
	if err != nil {
		t.Fatal(err)
	}
	if want := (protocol.FileEntry{ID: 1, Path: "docs/spec.md", Format: protocol.FormatText}); entry != want {
		t.Fatalf("entry = %+v", entry)
	}
	g := joinFiles(t, f.relay, f.session.URL)
	want := []protocol.FileEntry{{ID: 0, Path: "notes.md", Format: "text"}, entry}
	prototest.WaitFor(t, wait, func() bool { return reflect.DeepEqual(g.files(), want) }, "the manifest")
	if got := f.session.Files(); !reflect.DeepEqual(got, want) {
		t.Fatalf("Files() = %+v", got)
	}
	doc := g.open(t, 1)
	prototest.WaitFor(t, wait, func() bool { return textOf(doc) == "# spec\n" && g.String() == "# agenda\n" }, "both files")

	// A guest's edit is saved to the file, and only to it.
	insertInto(doc, len("# spec\n"), "- agreed\n")
	prototest.WaitFor(t, wait, func() bool { return readFile(t, spec) == "# spec\n- agreed\n" }, "the edit on disk")
	// An edit to the file outside pedit reaches the room.
	if err := os.WriteFile(spec, []byte("# spec v2\n- agreed\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	prototest.WaitFor(t, wait, func() bool { return textOf(doc) == "# spec v2\n- agreed\n" }, "the edit from disk")
	if readFile(t, f.file) != "# agenda\n" {
		t.Fatalf("the first file changed: %q", readFile(t, f.file))
	}
}

func TestStopSavesEveryFile(t *testing.T) {
	f := setup(t, "a\n", setupOpts{writeDelay: time.Minute})
	spec := writeBeside(t, f, "spec.md", "s\n")
	if _, err := f.session.AddFile(spec); err != nil {
		t.Fatal(err)
	}
	g := joinFiles(t, f.relay, f.session.URL)
	doc := g.open(t, 1)
	prototest.WaitFor(t, wait, func() bool { return textOf(doc) == "s\n" && g.String() == "a\n" }, "both files")
	insertInto(doc, 0, "S")
	g.insert(0, "A")
	prototest.WaitFor(t, wait, func() bool {
		return f.session.Text.ToString() == "Aa\n" && f.session.Files() != nil && f.session.added[0].render() == "Ss\n"
	}, "both edits at the host")
	if err := f.session.Stop(); err != nil {
		t.Fatal(err)
	}
	if readFile(t, f.file) != "Aa\n" || readFile(t, spec) != "Ss\n" {
		t.Fatalf("files = %q, %q", readFile(t, f.file), readFile(t, spec))
	}
	if _, err := f.session.AddFile(writeBeside(t, f, "late.md", "")); err == nil {
		t.Fatal("added a file once stopped")
	}
}

func TestAddFileRefusesWhatCannotBeShared(t *testing.T) {
	f := setup(t, "a\n", setupOpts{})
	dir := filepath.Dir(f.file)
	if _, err := f.session.AddFile(writeBeside(t, f, "Spec.md", "s\n")); err != nil {
		t.Fatal(err)
	}
	hardLink := filepath.Join(dir, "alias.md")
	if err := os.Link(f.file, hardLink); err != nil {
		t.Fatal(err)
	}
	symlink := filepath.Join(dir, "link.md")
	if err := os.Symlink(f.file, symlink); err != nil {
		t.Fatal(err)
	}
	for name, file := range map[string]string{
		"the first file again":       f.file,
		"another name for it":        hardLink,
		"a symlink":                  symlink,
		"a name that folds into one": writeBeside(t, f, "spec.md", "other\n"),
		"a name Windows refuses":     writeBeside(t, f, "a:b.md", "x\n"),
		"not UTF-8":                  writeBeside(t, f, "latin1.md", "caf\xe9\n"),
		"missing":                    filepath.Join(dir, "missing.md"),
		"a directory":                dir,
		"too large":                  writeBeside(t, f, "big.md", strings.Repeat("x", protocol.MaxFrameBytes)),
		"not a canvas":               writeBeside(t, f, "board.canvas", "{"),
	} {
		if _, err := f.session.AddFile(file); err == nil {
			t.Errorf("%s: added", name)
		}
	}
	if got := len(f.session.Files()); got != 2 {
		t.Fatalf("%d files shared", got)
	}
	for i := len(f.session.Files()); i < MaxFiles; i++ {
		if _, err := f.session.AddFile(writeBeside(t, f, fmt.Sprintf("more/%d.md", i), "")); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := f.session.AddFile(writeBeside(t, f, "one-too-many.md", "")); err == nil {
		t.Fatalf("shared more than %d files", MaxFiles)
	}
}

func TestSharedPathIsRelativeToTheRoot(t *testing.T) {
	root := t.TempDir()
	for file, want := range map[string]string{
		filepath.Join(root, "a.md"):                  "a.md",
		filepath.Join(root, "docs", "b.md"):          "docs/b.md",
		filepath.Join(filepath.Dir(root), "out.md"):  "out.md",
		filepath.Join(root, "..", "elsewhere", "c"):  "c",
		filepath.Join(root, "docs", "..", "back.md"): "back.md",
	} {
		if got := sharedPath(root, file); got != want {
			t.Errorf("sharedPath(%q) = %q, want %q", file, got, want)
		}
	}
}

func TestAddedCanvasTakesEditsByFile(t *testing.T) {
	f := setup(t, "a\n", setupOpts{})
	board := writeBeside(t, f, "board.canvas", `{"nodes":[],"edges":[]}`)
	entry, err := f.session.AddFile(board)
	if err != nil || entry.Format != protocol.FormatCanvas {
		t.Fatalf("entry = %+v, %v", entry, err)
	}
	g := joinFiles(t, f.relay, f.session.URL)
	g.open(t, entry.ID)
	prototest.WaitFor(t, wait, func() bool { return g.files() != nil }, "the manifest")
	next := `{"nodes":[{"id":"n1","type":"text","text":"hi","x":0,"y":0,"width":10,"height":10}],"edges":[]}`
	if err := g.SendFileCanvas(entry.ID, protocol.CanvasMessage{Kind: protocol.CanvasEdit, ID: "e1", Base: `{"nodes":[],"edges":[]}`, Next: next}); err != nil {
		t.Fatal(err)
	}
	select {
	case m := <-g.canvas:
		if m.Kind != protocol.CanvasApplied || m.ID != "e1" {
			t.Fatalf("reply = %+v", m)
		}
	case <-time.After(wait):
		t.Fatal("no reply")
	}
	prototest.WaitFor(t, wait, func() bool { return strings.Contains(readFile(t, board), `"n1"`) }, "the edit on disk")
	// The same edit sent about the first file, a text, is not applied there.
	if err := g.SendCanvas(protocol.CanvasMessage{Kind: protocol.CanvasEdit, ID: "e2", Base: "{}", Next: next}); err != nil {
		t.Fatal(err)
	}
	time.Sleep(100 * time.Millisecond)
	if readFile(t, f.file) != "a\n" {
		t.Fatalf("first file = %q", readFile(t, f.file))
	}
}

// Each file sends only the images it refers to (SEC-005), from its own
// directory.
func TestAddedFileServesOnlyItsOwnImages(t *testing.T) {
	f := setup(t, "first\n", setupOpts{})
	image := []byte("\x89PNG\r\n\x1a\n in docs")
	hash := protocol.ContentHash(image)
	writeBeside(t, f, "docs/"+attach.Dir+"/"+hash+".png", string(image))
	spec := writeBeside(t, f, "docs/spec.md", "![](assets/"+hash+".png)\n")
	entry, err := f.session.AddFile(spec)
	if err != nil {
		t.Fatal(err)
	}
	g := joinFiles(t, f.relay, f.session.URL)
	prototest.WaitFor(t, wait, func() bool { return g.files() != nil }, "the manifest")
	// Wanted for the first file, which does not refer to it: not sent.
	if err := g.SendAttachment(protocol.Attachment{Kind: protocol.AttachmentWant, Hashes: []string{hash}}); err != nil {
		t.Fatal(err)
	}
	time.Sleep(200 * time.Millisecond)
	if f.puts.Load() != 0 {
		t.Fatal("uploaded an image the first file does not refer to")
	}
	if err := g.SendFileAttachment(entry.ID, protocol.Attachment{Kind: protocol.AttachmentWant, Hashes: []string{hash}}); err != nil {
		t.Fatal(err)
	}
	prototest.WaitFor(t, wait, func() bool { return f.puts.Load() == 1 }, "the image uploaded for the file that refers to it")
}

func TestNoticesNameTheAddedFile(t *testing.T) {
	n := newNoticeLog(t)
	f := setup(t, "a\n", setupOpts{watch: true, onNotice: n.add})
	spec := writeBeside(t, f, "spec.md", "s\n")
	if _, err := f.session.AddFile(spec); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(spec, []byte("caf\xe9\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if told := n.waitFor(ChangeHeld); told.File != spec {
		t.Fatalf("notice = %+v", told)
	}
}
