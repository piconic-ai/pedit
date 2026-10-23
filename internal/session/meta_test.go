package session

import (
	"context"
	"encoding/base64"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"runtime"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/piconic-ai/pedit/internal/meta"
	"github.com/piconic-ai/pedit/internal/protocol"
	"github.com/piconic-ai/pedit/internal/protocol/prototest"
	"github.com/reearth/ygo/crdt"
)

func metaPathOf(f *fixture, name string) string {
	return filepath.Join(filepath.Dir(f.file), ".pedit", "meta", filepath.FromSlash(name)+".json")
}

// comment adds a thread on text [start, end) of content, as a browser does.
func comment(t *testing.T, metaDoc, content *crdt.Doc, id string, start, end int, body string) {
	t.Helper()
	text := content.GetText("content")
	pos := func(i, assoc int) string {
		return base64.StdEncoding.EncodeToString(crdt.EncodeRelativePosition(crdt.CreateRelativePositionFromIndex(text, i, assoc)))
	}
	quote := []rune(text.ToString())[start:end]
	comments := metaDoc.GetMap(meta.CommentsKey)
	metaDoc.Transact(func(txn *crdt.Transaction) {
		thread := crdt.NewMapPrelim()
		comments.Set(txn, id, thread)
		thread.Set(txn, meta.AnchorKey, map[string]any{"type": "text", "start": pos(start, 0), "end": pos(end, -1)})
		thread.Set(txn, meta.QuoteKey, string(quote))
		thread.Set(txn, meta.ResolvedKey, false)
		messages := crdt.NewMapPrelim()
		thread.Set(txn, meta.MessagesKey, messages)
		messages.Set(txn, "m1", map[string]any{"author": "Ada", "time": "2026-10-21T00:00:00.000Z", "body": body})
	})
}

func readMetaFile(t *testing.T, path string) *meta.File {
	t.Helper()
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	file, err := meta.Parse(data)
	if err != nil {
		t.Fatalf("%s: %v\n%s", path, err, data)
	}
	return file
}

func TestACommentIsSavedUnderThePedit(t *testing.T) {
	f := setup(t, "hello world!\n", setupOpts{project: true})
	g := joinFiles(t, f.relay, f.session.URL)
	want := []protocol.FileEntry{
		{ID: 0, Path: "notes.md", Format: protocol.FormatText},
		{ID: 1, Path: ".pedit/meta/notes.md.json", Format: protocol.FormatMeta},
	}
	prototest.WaitFor(t, wait, func() bool { return reflect.DeepEqual(g.files(), want) }, "the manifest")
	if got := f.session.Files(); !reflect.DeepEqual(got, want[:1]) {
		t.Fatalf("Files() = %+v: metadata is not a file to list", got)
	}
	if pairs := protocol.MetaFiles(g.files()); pairs[0] != 1 {
		t.Fatalf("pairs %v", pairs)
	}
	path := metaPathOf(f, "notes.md")
	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Fatalf("a metadata file before any comment: %v", err)
	}

	metaDoc := g.open(t, 1)
	prototest.WaitFor(t, wait, func() bool { return g.String() == "hello world!\n" }, "the text")
	comment(t, metaDoc, g.doc, "c1", 6, 11, "Which world?")
	prototest.WaitFor(t, wait, func() bool { _, err := os.Stat(path); return err == nil }, "the metadata file")
	if info, err := os.Stat(filepath.Dir(path)); err != nil || runtime.GOOS != "windows" && info.Mode().Perm() != 0o700 {
		t.Fatalf("the directory made for it: %v, %v", info.Mode(), err)
	}
	file := readMetaFile(t, path)
	th := file.Comments["c1"]
	if file.Path != "notes.md" || th.Anchor.Text == nil || th.Anchor.Text.Exact != "world" || th.Messages["m1"].Body != "Which world?" {
		t.Fatalf("saved %+v", file)
	}

	// An edit moves the saved place; Stop saves it.
	g.insert(0, "Oh, ")
	prototest.WaitFor(t, wait, func() bool { return f.session.Text.ToString() == "Oh, hello world!\n" }, "the edit at the host")
	if err := f.session.Stop(); err != nil {
		t.Fatal(err)
	}
	if s := readMetaFile(t, path).Comments["c1"].Anchor.Text; s.Offset != 10 || s.Prefix != "Oh, hello " {
		t.Fatalf("after the edit: %+v", s)
	}
}

func TestSavedCommentsComeBackInTheNextSession(t *testing.T) {
	saved := `{"version":1,"path":"notes.md","comments":{"c1":{"anchor":{"type":"text","exact":"world","prefix":"hello ","suffix":"!","offset":6},"quote":"world","resolved":false,"messages":{"m1":{"author":"Ada","time":"2026-10-21T00:00:00Z","body":"Which world?"}}}},"suggestions":{"s1":1}}`
	f := setup(t, "A new line.\nhello world!\n", setupOpts{project: true, meta: saved})
	g := joinFiles(t, f.relay, f.session.URL)
	prototest.WaitFor(t, wait, func() bool { return len(g.files()) == 2 }, "the manifest")
	metaDoc := g.open(t, 1)
	prototest.WaitFor(t, wait, func() bool {
		v, _ := metaDoc.GetMap(meta.CommentsKey).Get("c1")
		return v != nil
	}, "the thread")
	if err := f.session.Stop(); err != nil {
		t.Fatal(err)
	}
	file := readMetaFile(t, metaPathOf(f, "notes.md"))
	if s := file.Comments["c1"].Anchor.Text; s == nil || s.Offset != 18 || s.Prefix != "A new line.\nhello " {
		t.Fatalf("re-anchored %+v", s)
	}
	out, _ := os.ReadFile(metaPathOf(f, "notes.md"))
	if !strings.Contains(string(out), `"suggestions"`) {
		t.Fatalf("lost a key a newer pedit wrote:\n%s", out)
	}
}

func TestNoProjectNoComments(t *testing.T) {
	f := setup(t, "a\n", setupOpts{})
	g := joinFiles(t, f.relay, f.session.URL)
	spec := writeBeside(t, f, "spec.md", "s\n")
	if _, err := f.session.AddFile(spec); err != nil {
		t.Fatal(err)
	}
	prototest.WaitFor(t, wait, func() bool { return len(g.files()) == 2 }, "the manifest")
	for _, e := range g.files() {
		if e.Format == protocol.FormatMeta {
			t.Fatalf("metadata without a project: %+v", g.files())
		}
	}
}

// noticesOf collects the notices of a session.
type noticesOf struct {
	mu   sync.Mutex
	list []Notice
}

func (n *noticesOf) add(x Notice) {
	n.mu.Lock()
	defer n.mu.Unlock()
	n.list = append(n.list, x)
}

func (n *noticesOf) find(kind NoticeKind) (Notice, bool) {
	n.mu.Lock()
	defer n.mu.Unlock()
	for _, x := range n.list {
		if x.Kind == kind {
			return x, true
		}
	}
	return Notice{}, false
}

func TestUnreadableMetadataIsLeftAlone(t *testing.T) {
	var n noticesOf
	bad := `{"version":1,"path":"notes.md","comments":{"bad id":{}}}`
	f := setup(t, "a\n", setupOpts{project: true, meta: bad, onNotice: n.add})
	prototest.WaitFor(t, wait, func() bool { _, ok := n.find(CommentsOff); return ok }, "CommentsOff")
	if x, _ := n.find(CommentsOff); !strings.Contains(x.Reason, "left as it is") {
		t.Fatalf("reason %q", x.Reason)
	}
	g := joinFiles(t, f.relay, f.session.URL)
	// A room that shares one file and no metadata sends no manifest.
	prototest.WaitFor(t, wait, func() bool { return g.String() == "a\n" }, "the text")
	if len(g.files()) != 0 {
		t.Fatalf("manifest %+v", g.files())
	}
	if err := f.session.Stop(); err != nil {
		t.Fatal(err)
	}
	if got := readFile(t, metaPathOf(f, "notes.md")); got != bad {
		t.Fatalf("metadata changed: %q", got)
	}
}

func TestMetadataChangedOutsidePeditIsNotSavedOver(t *testing.T) {
	var n noticesOf
	saved := `{"version":1,"path":"notes.md","comments":{}}`
	f := setup(t, "hello world!\n", setupOpts{project: true, meta: saved, onNotice: n.add})
	g := joinFiles(t, f.relay, f.session.URL)
	prototest.WaitFor(t, wait, func() bool { return len(g.files()) == 2 }, "the manifest")
	metaDoc := g.open(t, 1)
	prototest.WaitFor(t, wait, func() bool { return g.String() == "hello world!\n" }, "the text")

	theirs := `{"version":1,"path":"notes.md","comments":{},"from":"git"}`
	if err := os.WriteFile(metaPathOf(f, "notes.md"), []byte(theirs), 0o644); err != nil {
		t.Fatal(err)
	}
	comment(t, metaDoc, g.doc, "c1", 0, 5, "Hi")
	prototest.WaitFor(t, wait, func() bool { _, ok := n.find(CommentsHeld); return ok }, "CommentsHeld")
	if err := f.session.Stop(); err != nil {
		t.Fatal(err)
	}
	if got := readFile(t, metaPathOf(f, "notes.md")); got != theirs {
		t.Fatalf("saved over: %q", got)
	}
}

func TestAFileOutsideTheProjectOffersNoComments(t *testing.T) {
	var n noticesOf
	f := setup(t, "a\n", setupOpts{project: true, onNotice: n.add})
	outside := filepath.Join(t.TempDir(), "elsewhere.md")
	if err := os.WriteFile(outside, []byte("e\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := f.session.AddFile(outside); err != nil {
		t.Fatal(err)
	}
	prototest.WaitFor(t, wait, func() bool { _, ok := n.find(CommentsOff); return ok }, "CommentsOff")
	g := joinFiles(t, f.relay, f.session.URL)
	prototest.WaitFor(t, wait, func() bool { return len(g.files()) == 3 }, "the manifest")
	if pairs := protocol.MetaFiles(g.files()); len(pairs) != 1 || pairs[0] == 0 {
		t.Fatalf("pairs %v in %+v", pairs, g.files())
	}
	if _, err := f.session.AddFile(writeBeside(t, f, ".pedit/meta/x.md.json", "{}")); err == nil {
		t.Fatal("shared a file where pedit keeps comments")
	}
}

func TestCommentsHeldOnlyAtStopAreReported(t *testing.T) {
	var n noticesOf
	saved := `{"version":1,"path":"notes.md","comments":{}}`
	f := setup(t, "hello world!\n", setupOpts{project: true, meta: saved, writeDelay: time.Hour, onNotice: n.add})
	g := joinFiles(t, f.relay, f.session.URL)
	prototest.WaitFor(t, wait, func() bool { return len(g.files()) == 2 }, "the manifest")
	metaDoc := g.open(t, 1)
	prototest.WaitFor(t, wait, func() bool { return g.String() == "hello world!\n" }, "the text")
	theirs := `{"version":1,"path":"notes.md","comments":{},"from":"git"}`
	if err := os.WriteFile(metaPathOf(f, "notes.md"), []byte(theirs), 0o644); err != nil {
		t.Fatal(err)
	}
	comment(t, metaDoc, g.doc, "c1", 0, 5, "Hi")
	prototest.WaitFor(t, wait, func() bool {
		var n int
		f.session.Client.Do(func() { n = len(f.session.sharedFile.meta.doc.GetMap(meta.CommentsKey).Keys()) })
		return n == 1
	}, "the comment at the host")
	// Stop saves before it leaves the room, and tells why it cannot.
	if err := f.session.Stop(); err != nil {
		t.Fatal(err)
	}
	if _, ok := n.find(CommentsHeld); !ok {
		t.Fatal("not told the comments were not saved")
	}
	if got := readFile(t, metaPathOf(f, "notes.md")); got != theirs {
		t.Fatalf("saved over: %q", got)
	}
}

func TestAPathThatCannotNameAFileOfCommentsOffersNone(t *testing.T) {
	var n noticesOf
	// Shared from sub/, so the room calls it notes.md, but aux/ is a name
	// Windows keeps for itself.
	f := setup(t, "a\n", setupOpts{name: "sub/first.md", project: true, onNotice: n.add})
	odd := filepath.Join(filepath.Dir(filepath.Dir(f.file)), "aux", "notes.md")
	if err := os.MkdirAll(filepath.Dir(odd), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(odd, []byte("x\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := f.session.AddFile(odd); err != nil {
		t.Fatal(err)
	}
	prototest.WaitFor(t, wait, func() bool { _, ok := n.find(CommentsOff); return ok }, "CommentsOff")
	if x, _ := n.find(CommentsOff); !strings.Contains(x.Reason, "cannot name") {
		t.Fatalf("reason %q", x.Reason)
	}
}

func TestPeditDoesNotShareItsOwnFilesOfComments(t *testing.T) {
	f := setup(t, "a\n", setupOpts{project: true})
	for _, name := range []string{".pedit/meta/x.md.json", ".Pedit/Meta/y.md.json"} {
		if _, err := f.session.AddFile(writeBeside(t, f, name, "{}")); err == nil {
			t.Fatalf("shared %s", name)
		}
	}
	dir := filepath.Dir(f.file)
	_, err := Start(context.Background(), Options{File: filepath.Join(dir, ".pedit", "meta", "x.md.json"), Project: dir, Server: f.server.URL, Dial: f.relay.Dial})
	if !errors.Is(err, errKeepsComments) {
		t.Fatalf("Start = %v", err)
	}
}

func TestAProjectThatCannotBeOpenedOnlyTurnsCommentsOff(t *testing.T) {
	var n noticesOf
	f := setup(t, "a\n", setupOpts{projectDir: filepath.Join(t.TempDir(), "gone"), onNotice: n.add})
	prototest.WaitFor(t, wait, func() bool { _, ok := n.find(CommentsOff); return ok }, "CommentsOff")
	if f.session.Text.ToString() != "a\n" {
		t.Fatal("not shared")
	}
}

func TestAHugeFileOfCommentsIsNotRead(t *testing.T) {
	var n noticesOf
	f := setup(t, "a\n", setupOpts{project: true, meta: strings.Repeat(" ", meta.MaxFileBytes+1), onNotice: n.add})
	prototest.WaitFor(t, wait, func() bool { _, ok := n.find(CommentsOff); return ok }, "CommentsOff")
	if x, _ := n.find(CommentsOff); !strings.Contains(x.Reason, "larger than") {
		t.Fatalf("reason %q", x.Reason)
	}
	_ = f
}

func TestCommentsAreNotWrittenThroughASymlinkedDirectory(t *testing.T) {
	// From review: a cloned repository can hold .pedit/meta as a link to
	// elsewhere in the project.
	dir := t.TempDir()
	if err := os.Mkdir(filepath.Join(dir, ".pedit"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink("..", filepath.Join(dir, ".pedit", "meta")); err != nil {
		t.Skip("no symlinks:", err)
	}
	project, err := os.OpenRoot(dir)
	if err != nil {
		t.Fatal(err)
	}
	defer project.Close()
	for _, create := range []bool{false, true} {
		if b, err := openMetaFile(project, filepath.FromSlash(".pedit/meta/package.json"), create); err == nil {
			_ = b.Close()
			t.Fatalf("opened through the link (create %v)", create)
		}
	}
	// Real directories are made as needed.
	if err := os.Remove(filepath.Join(dir, ".pedit", "meta")); err != nil {
		t.Fatal(err)
	}
	b, err := openMetaFile(project, filepath.FromSlash(".pedit/meta/a/b.md.json"), true)
	if err != nil {
		t.Fatal(err)
	}
	_ = b.Close()
	if info, err := os.Stat(filepath.Join(dir, ".pedit", "meta", "a")); err != nil || !info.IsDir() {
		t.Fatalf("made %v, %v", info, err)
	}
}

func TestPeditDoesNotShareItsFilesOfCommentsThroughALink(t *testing.T) {
	dir := t.TempDir()
	if err := os.MkdirAll(filepath.Join(dir, ".pedit", "meta"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(filepath.Join(".pedit", "meta"), filepath.Join(dir, "alias")); err != nil {
		t.Skip("no symlinks:", err)
	}
	project, err := os.OpenRoot(dir)
	if err != nil {
		t.Fatal(err)
	}
	defer project.Close()
	if !keepsComments(project, filepath.Join(dir, "alias", "x.md.json")) {
		t.Fatal("shared a file of comments through a link")
	}
	if keepsComments(project, filepath.Join(dir, "notes.md")) {
		t.Fatal("refused an ordinary file")
	}
}

func TestStopWaitsForASaveUnderWayAndSavesLast(t *testing.T) {
	// From review: a save of older comments, under way when Stop came, must
	// not reach the writer after Stop's own.
	f := setup(t, "hello world!\n", setupOpts{project: true})
	g := joinFiles(t, f.relay, f.session.URL)
	prototest.WaitFor(t, wait, func() bool { return len(g.files()) == 2 }, "the manifest")
	metaDoc := g.open(t, 1)
	prototest.WaitFor(t, wait, func() bool { return g.String() == "hello world!\n" }, "the text")
	m := f.session.sharedFile.meta
	entered, release := make(chan struct{}, 1), make(chan struct{})
	m.beforeSchedule = func() {
		select {
		case entered <- struct{}{}:
			<-release
		default:
		}
	}
	comment(t, metaDoc, g.doc, "old", 0, 5, "first")
	<-entered // the debounced save rendered "old" alone, and waits
	comment(t, metaDoc, g.doc, "new", 6, 11, "second")
	prototest.WaitFor(t, wait, func() bool {
		var n int
		f.session.Client.Do(func() { n = len(m.doc.GetMap(meta.CommentsKey).Keys()) })
		return n == 2
	}, "both comments at the host")
	stopped := make(chan error, 1)
	go func() { stopped <- f.session.Stop() }()
	select {
	case err := <-stopped:
		t.Fatalf("Stop did not wait for the save under way: %v", err)
	case <-time.After(200 * time.Millisecond):
	}
	close(release)
	if err := <-stopped; err != nil {
		t.Fatal(err)
	}
	time.Sleep(50 * time.Millisecond) // a late write would land by now
	if got := readMetaFile(t, metaPathOf(f, "notes.md")); len(got.Comments) != 2 {
		t.Fatalf("saved %d comments", len(got.Comments))
	}
}

func TestAFirstSaveThatCannotStartIsTriedAgain(t *testing.T) {
	// From review: the comments' directory cannot be made at first; once it
	// can, they are saved without another change.
	f := setup(t, "hello world!\n", setupOpts{project: true, writeDelay: 10 * time.Millisecond})
	g := joinFiles(t, f.relay, f.session.URL)
	prototest.WaitFor(t, wait, func() bool { return len(g.files()) == 2 }, "the manifest")
	metaDoc := g.open(t, 1)
	prototest.WaitFor(t, wait, func() bool { return g.String() == "hello world!\n" }, "the text")
	blocker := filepath.Join(filepath.Dir(f.file), ".pedit", "meta")
	if err := os.MkdirAll(filepath.Dir(blocker), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(blocker, nil, 0o644); err != nil {
		t.Fatal(err)
	}
	comment(t, metaDoc, g.doc, "c1", 6, 11, "Which world?")
	time.Sleep(100 * time.Millisecond) // a few tries fail
	if err := os.Remove(blocker); err != nil {
		t.Fatal(err)
	}
	path := metaPathOf(f, "notes.md")
	prototest.WaitFor(t, wait, func() bool { _, err := os.Stat(path); return err == nil }, "the comments, saved on a later try")
}
