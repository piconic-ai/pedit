package session

import (
	"context"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/piconic-ai/pedit/internal/attach"
	"github.com/piconic-ai/pedit/internal/protocol"
	"github.com/piconic-ai/pedit/internal/protocol/prototest"
	"github.com/reearth/ygo/crdt"
)

// testSource stands in for serve's document: it owns a doc, takes what the
// room sends, and tells the session what changed on its side.
type testSource struct {
	doc  *crdt.Doc
	text *crdt.YText

	mu      sync.Mutex
	applied int
	session *Session
}

func newTestSource(initial string) *testSource {
	src := &testSource{doc: crdt.New()}
	src.text = src.doc.GetText("content")
	src.doc.Transact(func(txn *crdt.Transaction) { src.text.Insert(txn, 0, initial, nil) })
	src.doc.OnUpdate(func(update []byte, origin any) {
		if origin == "room" {
			return
		}
		src.mu.Lock()
		s := src.session
		src.mu.Unlock()
		if s != nil {
			_ = s.FromSource(update)
		}
	})
	return src
}

func (src *testSource) State() []byte { return crdt.EncodeStateAsUpdateV1(src.doc, nil) }

func (src *testSource) Apply(update []byte) error {
	src.mu.Lock()
	src.applied++
	src.mu.Unlock()
	return crdt.ApplyUpdateV1(src.doc, update, "room")
}

func (src *testSource) appliedCount() int {
	src.mu.Lock()
	defer src.mu.Unlock()
	return src.applied
}

func (src *testSource) String() string { return src.text.ToString() }

func (src *testSource) insert(index int, s string) {
	src.doc.Transact(func(txn *crdt.Transaction) { src.text.Insert(txn, index, s, nil) })
}

// shareSource starts a session sharing a source with the text on disk.
func shareSource(t *testing.T, text string, o setupOpts) (*fixture, *testSource) {
	t.Helper()
	src := newTestSource(text)
	o.source = src
	f := setup(t, text, o)
	src.mu.Lock()
	src.session = f.session
	src.mu.Unlock()
	return f, src
}

func TestASourceSharesItsTextAndTakesTheRoomsEdits(t *testing.T) {
	f, src := shareSource(t, "hello\n", setupOpts{})
	g := joinAsGuest(t, f.relay, f.session.URL)
	prototest.WaitFor(t, wait, func() bool { return g.String() == "hello\n" }, "the source's text")

	g.insert(0, "oh, ")
	prototest.WaitFor(t, wait, func() bool { return src.String() == "oh, hello\n" }, "the edit at the source")
	// The session never writes the file: the source does.
	time.Sleep(100 * time.Millisecond)
	if got := readFile(t, f.file); got != "hello\n" {
		t.Fatalf("file = %q", got)
	}
	if f.session.Writer != nil {
		t.Fatal("the session made a writer for a file it does not own")
	}
}

func TestUpdatesFromTheSourceReachTheRoomAndAreNotEchoed(t *testing.T) {
	f, src := shareSource(t, "hello\n", setupOpts{})
	g := joinAsGuest(t, f.relay, f.session.URL)
	prototest.WaitFor(t, wait, func() bool { return g.String() == "hello\n" }, "the source's text")

	src.insert(5, " world")
	prototest.WaitFor(t, wait, func() bool { return g.String() == "hello world\n" }, "the update at the guest")
	time.Sleep(100 * time.Millisecond)
	if n := src.appliedCount(); n != 0 {
		t.Fatalf("the source got %d updates back", n)
	}
}

func TestSourceAndRoomConvergeAfterConcurrentEdits(t *testing.T) {
	f, src := shareSource(t, "middle\n", setupOpts{})
	g := joinAsGuest(t, f.relay, f.session.URL)
	prototest.WaitFor(t, wait, func() bool { return g.String() == "middle\n" }, "the source's text")

	for range 5 {
		g.insert(0, "g")
		src.insert(len(src.String())-1, "s")
	}
	want := func() bool {
		return src.String() == g.String() && strings.Count(g.String(), "g") == 5 && strings.Count(g.String(), "s") == 5
	}
	prototest.WaitFor(t, wait, want, "both sides to converge")
	if got := f.session.content.render(); got != src.String() {
		t.Fatalf("session %q, source %q", got, src.String())
	}
	if strings.Count(src.String(), "middle") != 1 {
		t.Fatalf("text duplicated: %q", src.String())
	}
}

func TestASourceTakesTheFilesLineEnding(t *testing.T) {
	f, _ := shareSource(t, "a\r\nb\r\n", setupOpts{})
	if got := f.session.content.render(); got != "a\r\nb\r\n" {
		t.Fatalf("render = %q", got)
	}
}

func TestASourceRefusesWhatItCannotDoYet(t *testing.T) {
	src := newTestSource("x\n")
	dir := t.TempDir()
	for name, o := range map[string]Options{
		"canvas": {File: filepath.Join(dir, "a.canvas")},
		"keep":   {File: filepath.Join(dir, "a.md"), Keep: time.Hour},
		"resume": {File: filepath.Join(dir, "a.md"), Resume: "AAAAAAAAAAAAAAAAAAAAAA"},
		"more":   {File: filepath.Join(dir, "a.md"), More: []string{filepath.Join(dir, "b.md")}},
	} {
		o.Source = src
		o.Server = "http://127.0.0.1:1"
		if s, err := Start(context.Background(), o); err == nil {
			_ = s.Stop()
			t.Errorf("%s: started", name)
		}
	}
}

func TestOriginsAreSentOnEveryHostConnection(t *testing.T) {
	origins := []string{"https://cms.example.com", "http://localhost:3000"}
	f, _ := shareSource(t, "x\n", setupOpts{origins: origins})
	want := strings.Join(origins, ",")
	if got := f.relay.Headers()[0].Get(protocol.OriginsHeader); got != want {
		t.Fatalf("header = %q, want %q", got, want)
	}
	f.relay.DropAll()
	prototest.WaitFor(t, wait, func() bool { return len(f.relay.Headers()) >= 2 }, "the host to reconnect")
	if got := f.relay.Headers()[1].Get(protocol.OriginsHeader); got != want {
		t.Fatalf("header after reconnect = %q, want %q", got, want)
	}
}

func TestFragmentsAreThePartsOfTheLinks(t *testing.T) {
	f, _ := shareSource(t, "x\n", setupOpts{project: true})
	room, edit, comment, read := f.session.Fragments()
	u, err := url.Parse(f.session.URL)
	if err != nil {
		t.Fatal(err)
	}
	if room != strings.TrimPrefix(u.Path, "/r/") || edit != u.Fragment {
		t.Fatalf("room %q edit %q, URL %s", room, edit, f.session.URL)
	}
	links := map[protocol.Access]string{}
	for _, l := range f.session.Links() {
		links[l.Access] = l.URL[strings.Index(l.URL, "#")+1:]
	}
	if comment == "" || comment != links[protocol.AccessComment] || read != links[protocol.AccessRead] {
		t.Fatalf("comment %q read %q, links %v", comment, read, links)
	}
	// Without a project no file offers comments.
	g, _ := shareSource(t, "x\n", setupOpts{})
	if _, _, comment, _ := g.session.Fragments(); comment != "" {
		t.Fatalf("comment fragment %q without comments", comment)
	}
}

func TestASourceKeepsCommentsInTheProject(t *testing.T) {
	f, _ := shareSource(t, "hello world!\n", setupOpts{project: true})
	g := joinFiles(t, f.relay, f.session.URL)
	metaDoc := g.open(t, 1)
	prototest.WaitFor(t, wait, func() bool { return g.String() == "hello world!\n" }, "the text")
	comment(t, metaDoc, g.doc, "c1", 6, 11, "Which world?")
	path := metaPathOf(f, "notes.md")
	prototest.WaitFor(t, wait, func() bool {
		data, err := os.ReadFile(path)
		return err == nil && strings.Contains(string(data), "Which world?")
	}, "the comment in the project's meta file")
	if got := readFile(t, f.file); got != "hello world!\n" {
		t.Fatalf("file = %q", got)
	}
}

func TestASourceSavesPastedImagesBesideTheFile(t *testing.T) {
	f, _ := shareSource(t, "x\n", setupOpts{})
	replies := make(chan protocol.Attachment, 4)
	g := joinAsGuestHearing(t, f.relay, f.session.URL, func(m protocol.Attachment) { replies <- m })
	prototest.WaitFor(t, wait, func() bool { return g.String() == "x\n" }, "the text")

	u, _ := url.Parse(f.session.URL)
	raw, err := protocol.DecodeKey(u.Fragment)
	if err != nil {
		t.Fatal(err)
	}
	room, err := protocol.EditKeys(raw, strings.TrimPrefix(u.Path, "/r/"))
	if err != nil {
		t.Fatal(err)
	}
	keys, err := protocol.DeriveBlobKeys(room.FrameKey)
	if err != nil {
		t.Fatal(err)
	}
	image := []byte("\x89PNG\r\n\x1a\n pasted")
	hash := protocol.ContentHash(image)
	id, err := keys.BlobID(hash)
	if err != nil {
		t.Fatal(err)
	}
	f.blobs.Store("/api/rooms/AAAAAAAAAAAAAAAAAAAAAA/blobs/"+id, keys.Encrypt(image))
	if err := g.SendAttachment(protocol.Attachment{Kind: protocol.AttachmentAnnounce, Hash: hash, Mime: "image/png"}); err != nil {
		t.Fatal(err)
	}
	select {
	case m := <-replies:
		if m.Kind != protocol.AttachmentStored {
			t.Fatalf("reply = %+v", m)
		}
	case <-time.After(wait):
		t.Fatal("the host did not answer")
	}
	saved, err := os.ReadFile(filepath.Join(filepath.Dir(f.file), attach.Dir, hash+".png"))
	if err != nil || string(saved) != string(image) {
		t.Fatalf("saved image: %v", err)
	}
}

func TestStoppingWithASourceWritesNothingToTheFile(t *testing.T) {
	f, src := shareSource(t, "hello\n", setupOpts{watch: true})
	g := joinAsGuest(t, f.relay, f.session.URL)
	prototest.WaitFor(t, wait, func() bool { return g.String() == "hello\n" }, "the text")
	g.insert(0, "oh, ")
	prototest.WaitFor(t, wait, func() bool { return src.String() == "oh, hello\n" }, "the edit at the source")
	// Someone else saves the file; the session does not take it in either.
	if err := os.WriteFile(f.file, []byte("saved elsewhere\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := f.session.Stop(); err != nil {
		t.Fatal(err)
	}
	if got := readFile(t, f.file); got != "saved elsewhere\n" {
		t.Fatalf("file = %q", got)
	}
	if got := src.String(); got != "oh, hello\n" {
		t.Fatalf("source = %q", got)
	}
}
