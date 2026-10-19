package protocol_test

import (
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/piconic-ai/pedit/internal/protocol"
	"github.com/piconic-ai/pedit/internal/protocol/prototest"
	"github.com/reearth/ygo/crdt"
)

// fileText is a text file's doc, as a room that shares several keeps it.
type fileText struct {
	doc  *crdt.Doc
	text *crdt.YText
}

func newFileText(init string) *fileText {
	doc := crdt.New()
	f := &fileText{doc: doc, text: doc.GetText("content")}
	if init != "" {
		f.insert(0, init)
	}
	return f
}

func (f *fileText) String() string { return f.text.ToString() }

func (f *fileText) insert(index int, s string) {
	f.doc.Transact(func(txn *crdt.Transaction) { f.text.Insert(txn, index, s, nil) })
}

func addFile(t *testing.T, p *peer, id uint64, f *fileText) {
	t.Helper()
	if err := p.AddFile(id, f.doc); err != nil {
		t.Fatal(err)
	}
}

// manifestLog records the manifests a peer hears.
type manifestLog struct {
	mu   sync.Mutex
	seen [][]protocol.FileEntry
}

func (l *manifestLog) add(files []protocol.FileEntry) {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.seen = append(l.seen, files)
}

func (l *manifestLog) last() []protocol.FileEntry {
	l.mu.Lock()
	defer l.mu.Unlock()
	if len(l.seen) == 0 {
		return nil
	}
	return l.seen[len(l.seen)-1]
}

func TestSyncsEachFileInADocOfItsOwn(t *testing.T) {
	relay := prototest.NewRelay(true)
	key := protocol.GenerateKey()
	host := join(t, relay, key, joinOpts{header: hostHeader()})
	agenda, notes := newFileText("# agenda\n"), newFileText("# notes\n")
	addFile(t, host, 1, agenda)
	addFile(t, host, 2, notes)
	if err := host.SetManifest(manifest[:2]); err != nil {
		t.Fatal(err)
	}
	prototest.WaitFor(t, wait, func() bool { return host.Status() == protocol.StatusConnected }, "host connected")

	var heard manifestLog
	guest := join(t, relay, key, joinOpts{onManifest: heard.add})
	prototest.WaitFor(t, wait, func() bool { return reflect.DeepEqual(heard.last(), manifest[:2]) }, "the manifest")
	gAgenda, gNotes := newFileText(""), newFileText("")
	addFile(t, guest, 1, gAgenda)
	addFile(t, guest, 2, gNotes)
	prototest.WaitFor(t, wait, func() bool {
		return gAgenda.String() == "# agenda\n" && gNotes.String() == "# notes\n"
	}, "the guest to get both files")

	gNotes.insert(len("# notes\n"), "- decided\n")
	agenda.insert(0, "!")
	prototest.WaitFor(t, wait, func() bool {
		return notes.String() == "# notes\n- decided\n" && gAgenda.String() == "!# agenda\n"
	}, "edits both ways")
	// The room's own doc stays empty: a peer that knows nothing of files has
	// nothing to save.
	if host.String() != "" || guest.String() != "" {
		t.Fatalf("room doc: host %q, guest %q", host.String(), guest.String())
	}
}

func TestFollowsOnlyTheFilesItAdded(t *testing.T) {
	relay := prototest.NewRelay(false)
	key := protocol.GenerateKey()
	var mu sync.Mutex
	var errs []error
	host := join(t, relay, key, joinOpts{})
	agenda, notes := newFileText("a"), newFileText("n")
	addFile(t, host, 1, agenda)
	addFile(t, host, 2, notes)
	synced := make(chan uint64, 4)
	guest := join(t, relay, key, joinOpts{
		onFileSynced: func(id uint64) { synced <- id },
		onError: func(err error) {
			mu.Lock()
			defer mu.Unlock()
			errs = append(errs, err)
		},
	})
	gNotes := newFileText("")
	addFile(t, guest, 2, gNotes)
	prototest.WaitFor(t, wait, func() bool { return gNotes.String() == "n" }, "notes")
	agenda.insert(1, "genda") // about a file the guest did not add
	notes.insert(1, "otes")
	prototest.WaitFor(t, wait, func() bool { return gNotes.String() == "notes" }, "later edits")
	if id := <-synced; id != 2 {
		t.Fatalf("synced file %d", id)
	}
	time.Sleep(50 * time.Millisecond)
	if len(synced) != 0 {
		t.Fatalf("synced reported again: %d", <-synced)
	}
	mu.Lock()
	defer mu.Unlock()
	if len(errs) > 0 {
		t.Fatalf("errors: %v", errs)
	}
}

func TestAddingAFileWhileConnectedSyncsIt(t *testing.T) {
	relay := prototest.NewRelay(false)
	key := protocol.GenerateKey()
	host := join(t, relay, key, joinOpts{})
	guest := join(t, relay, key, joinOpts{})
	prototest.WaitFor(t, wait, func() bool {
		return host.Status() == protocol.StatusConnected && guest.Status() == protocol.StatusConnected
	}, "both connected")
	gSpec := newFileText("")
	addFile(t, guest, 3, gSpec) // the guest asks first: the host has nothing yet
	addFile(t, host, 3, newFileText("spec"))
	prototest.WaitFor(t, wait, func() bool { return gSpec.String() == "spec" }, "the new file")
	if err := host.AddFile(3, crdt.New()); err == nil {
		t.Fatal("a file added twice")
	}
	if err := host.AddFile(protocol.MaxFileID+1, crdt.New()); err == nil {
		t.Fatal("an id over MaxFileID")
	}
}

func TestSendsTheManifestToWhoeverJoinsLater(t *testing.T) {
	relay := prototest.NewRelay(false)
	key := protocol.GenerateKey()
	host := join(t, relay, key, joinOpts{})
	if err := host.SetManifest(manifest); err != nil {
		t.Fatal(err)
	}
	prototest.WaitFor(t, wait, func() bool { return host.Status() == protocol.StatusConnected }, "host connected")
	for range 2 {
		var heard manifestLog
		join(t, relay, key, joinOpts{onManifest: heard.add})
		prototest.WaitFor(t, wait, func() bool { return reflect.DeepEqual(heard.last(), manifest) }, "the manifest")
	}
	// A new list replaces the old one, for everyone.
	var heard manifestLog
	join(t, relay, key, joinOpts{onManifest: heard.add})
	prototest.WaitFor(t, wait, func() bool { return heard.last() != nil }, "the first manifest")
	if err := host.SetManifest(manifest[:1]); err != nil {
		t.Fatal(err)
	}
	prototest.WaitFor(t, wait, func() bool { return reflect.DeepEqual(heard.last(), manifest[:1]) }, "the new manifest")
}

func TestRoutesAttachmentsAndCanvasMessagesByFile(t *testing.T) {
	relay := prototest.NewRelay(false)
	key := protocol.GenerateKey()
	var mu sync.Mutex
	var got []string
	record := func(s string) {
		mu.Lock()
		defer mu.Unlock()
		got = append(got, s)
	}
	a := join(t, relay, key, joinOpts{})
	b := join(t, relay, key, joinOpts{
		onFileAttachment: func(id uint64, at protocol.Attachment) { record(at.Hash[:4] + "@" + string(rune('0'+id))) },
		onFileCanvas:     func(id uint64, m protocol.CanvasMessage) { record(m.ID + "@" + string(rune('0'+id))) },
		onAttachment:     func(protocol.Attachment) { record("room attachment") },
		onCanvas:         func(protocol.CanvasMessage) { record("room canvas") },
	})
	prototest.WaitFor(t, wait, func() bool {
		return a.Status() == protocol.StatusConnected && b.Status() == protocol.StatusConnected
	}, "both connected")
	if err := a.SendFileAttachment(1, protocol.Attachment{Kind: protocol.AttachmentAnnounce, Hash: hashA, Mime: "image/png"}); err != nil {
		t.Fatal(err)
	}
	if err := a.SendFileCanvas(2, protocol.CanvasMessage{Kind: protocol.CanvasApplied, ID: "edit"}); err != nil {
		t.Fatal(err)
	}
	want := []string{hashA[:4] + "@1", "edit@2"}
	prototest.WaitFor(t, wait, func() bool { mu.Lock(); defer mu.Unlock(); return len(got) == len(want) }, "both messages")
	mu.Lock()
	defer mu.Unlock()
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got %q, want %q", got, want)
	}
	if err := a.SendFileAttachment(1, protocol.Attachment{Kind: protocol.AttachmentWant}); err == nil {
		t.Fatal("an invalid attachment should not be sent")
	}
}

func TestResyncsFilesAfterAReconnect(t *testing.T) {
	relay := prototest.NewRelay(false)
	key := protocol.GenerateKey()
	host := join(t, relay, key, joinOpts{})
	guest := join(t, relay, key, joinOpts{})
	notes, gNotes := newFileText("n"), newFileText("")
	addFile(t, host, 1, notes)
	addFile(t, guest, 1, gNotes)
	prototest.WaitFor(t, wait, func() bool { return gNotes.String() == "n" }, "notes")
	relay.SetRefuse(protocol.RelayBusy)
	relay.DropAll()
	prototest.WaitFor(t, wait, func() bool { return host.Status() != protocol.StatusConnected }, "dropped")
	notes.insert(1, " offline") // dropped while disconnected
	relay.SetRefuse(0)
	prototest.WaitFor(t, wait, func() bool { return gNotes.String() == "n offline" }, "the offline edit, after reconnecting")
}

func TestFileStateFrameBytesIsWhatIsSent(t *testing.T) {
	relay := prototest.NewRelay(false)
	p := join(t, relay, protocol.GenerateKey(), joinOpts{})
	prototest.WaitFor(t, wait, func() bool { return p.Status() == protocol.StatusConnected }, "connected")
	before := len(relay.Frames())
	f := newFileText(strings.Repeat("z", 5000))
	addFile(t, p, 300, f)
	prototest.WaitFor(t, wait, func() bool { return len(relay.Frames()) >= before+2 }, "the file's handshake")
	// The frames are the file's SyncStep1, then its whole state.
	if got, want := len(relay.Frames()[before+1]), protocol.FileStateFrameBytes(300, f.doc); got != want {
		t.Fatalf("the state went as a frame of %d bytes, FileStateFrameBytes says %d", got, want)
	}
}

func TestStopsForGoodWhenAFileDoesNotFit(t *testing.T) {
	relay := prototest.NewRelay(false)
	p := join(t, relay, protocol.GenerateKey(), joinOpts{})
	prototest.WaitFor(t, wait, func() bool { return p.Status() == protocol.StatusConnected }, "connected")
	addFile(t, p, 1, newFileText(strings.Repeat("x", protocol.MaxFrameBytes)))
	prototest.WaitFor(t, wait, func() bool { return p.Status() == protocol.StatusTooLarge }, "too large")
}

func TestAddFileFailsOnceDestroyed(t *testing.T) {
	p := join(t, prototest.NewRelay(false), protocol.GenerateKey(), joinOpts{})
	p.Destroy()
	if err := p.AddFile(1, crdt.New()); err == nil {
		t.Fatal("added a file to a destroyed client")
	}
}
