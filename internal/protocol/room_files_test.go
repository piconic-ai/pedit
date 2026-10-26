package protocol_test

import (
	"errors"
	"fmt"
	"reflect"
	"slices"
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
	// File 0 is the room's own doc, as in a room that shares one file.
	host := join(t, relay, key, joinOpts{header: hostHeader(), init: "# agenda\n"})
	notes, board := newFileText("# notes\n"), newFileText("{}")
	addFile(t, host, 1, notes)
	addFile(t, host, 2, board)
	if err := host.SetManifest(manifest[:3]); err != nil {
		t.Fatal(err)
	}
	prototest.WaitFor(t, wait, func() bool { return host.Status() == protocol.StatusConnected }, "host connected")

	var heard manifestLog
	guest := join(t, relay, key, joinOpts{onManifest: heard.add})
	prototest.WaitFor(t, wait, func() bool { return reflect.DeepEqual(heard.last(), manifest[:3]) }, "the manifest")
	gNotes, gBoard := newFileText(""), newFileText("")
	addFile(t, guest, 1, gNotes)
	addFile(t, guest, 2, gBoard)
	prototest.WaitFor(t, wait, func() bool {
		return guest.String() == "# agenda\n" && gNotes.String() == "# notes\n" && gBoard.String() == "{}"
	}, "the guest to get every file")

	gNotes.insert(len("# notes\n"), "- decided\n")
	host.insert(0, "!")
	prototest.WaitFor(t, wait, func() bool {
		return notes.String() == "# notes\n- decided\n" && guest.String() == "!# agenda\n"
	}, "edits both ways")

	// A peer that knows nothing of files goes on editing file 0, and only it.
	older := join(t, relay, key, joinOpts{})
	prototest.WaitFor(t, wait, func() bool { return older.String() == "!# agenda\n" }, "file 0 for an older peer")
	older.insert(0, "?")
	prototest.WaitFor(t, wait, func() bool { return host.String() == "?!# agenda\n" }, "its edit")
	if notes.String() != "# notes\n- decided\n" || board.String() != "{}" {
		t.Fatalf("other files changed: %q %q", notes.String(), board.String())
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
	if err := host.AddFile(0, crdt.New()); err == nil {
		t.Fatal("file 0, the room's own doc, added")
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

// A small allowance, so a few files go over it as forty large ones go over
// the real relay's.
var testBytes = protocol.Rate{Burst: 64 << 10, PerSecond: 256 << 10}

func TestKeepsSeveralLargeFilesWithinTheRelayAllowance(t *testing.T) {
	for _, paced := range []bool{true, false} {
		relay := prototest.NewRelay(false)
		relay.Bytes = testBytes
		key := protocol.GenerateKey()
		var mu sync.Mutex
		var statuses []protocol.Status
		hostBytes := testBytes
		if !paced {
			hostBytes = protocol.Rate{Burst: 1e12, PerSecond: 1e12}
		}
		host := join(t, relay, key, joinOpts{bytes: hostBytes, onStatus: func(s protocol.Status) {
			mu.Lock()
			defer mu.Unlock()
			statuses = append(statuses, s)
		}})
		for id := uint64(1); id <= 3; id++ {
			addFile(t, host, id, newFileText(strings.Repeat("x", 40<<10)))
		}
		dropped := func() bool {
			mu.Lock()
			defer mu.Unlock()
			return slices.Contains(statuses, protocol.StatusDisconnected)
		}
		if !paced {
			prototest.WaitFor(t, wait, dropped, "the relay to close the unpaced host")
			continue
		}
		guest := join(t, relay, key, joinOpts{bytes: testBytes})
		docs := make([]*fileText, 3)
		for i := range docs {
			docs[i] = newFileText("")
			addFile(t, guest, uint64(i+1), docs[i])
		}
		prototest.WaitFor(t, 5*time.Second, func() bool {
			for _, d := range docs {
				if len(d.String()) != 40<<10 {
					return false
				}
			}
			return true
		}, "every file, paced")
		if dropped() {
			t.Fatal("the relay closed the paced host")
		}
	}
}

// Leaving flushes what was queued, within the allowance: going over it would
// close the connection before the edit reached the room.
func TestFlushesAnEditQueuedBehindAPacedTransferOnLeaving(t *testing.T) {
	relay := prototest.NewRelay(false)
	relay.Bytes = testBytes
	key := protocol.GenerateKey()
	observer := join(t, relay, key, joinOpts{bytes: testBytes})
	prototest.WaitFor(t, wait, func() bool { return observer.Status() == protocol.StatusConnected }, "observer connected")
	guest := join(t, relay, key, joinOpts{bytes: testBytes})
	prototest.WaitFor(t, wait, func() bool { return guest.Status() == protocol.StatusConnected }, "guest connected")
	for id := uint64(1); id <= 5; id++ {
		addFile(t, guest, id, newFileText(strings.Repeat("x", 40<<10)))
	}
	time.Sleep(50 * time.Millisecond)
	guest.insert(0, "last edit")
	guest.Destroy()
	prototest.WaitFor(t, wait, func() bool { return observer.String() == "last edit" }, "the edit queued last")
	if n := relay.Limited(); n != 0 {
		t.Fatalf("%d connections went over the allowance", n)
	}
}

func TestACheckedFileAppliesOnlyWhatItsCheckPasses(t *testing.T) {
	relay := prototest.NewRelay(true)
	key := protocol.GenerateKey()
	var mu sync.Mutex
	var errs []error
	host := join(t, relay, key, joinOpts{header: hostHeader(), onError: func(err error) {
		mu.Lock()
		defer mu.Unlock()
		errs = append(errs, err)
	}})
	checked := newFileText("")
	refuse := errors.New("refused for the test")
	check := func(doc *crdt.Doc, update []byte) error {
		if strings.Contains(string(update), "refuse me") {
			return refuse
		}
		if strings.Contains(string(update), "panic") {
			panic("a hostile update")
		}
		return nil
	}
	if err := host.AddCheckedFile(1, checked.doc, check); err != nil {
		t.Fatal(err)
	}
	prototest.WaitFor(t, wait, func() bool { return host.Status() == protocol.StatusConnected }, "host connected")
	guest := join(t, relay, key, joinOpts{})
	g := newFileText("")
	addFile(t, guest, 1, g)
	g.insert(0, "kept ")
	prototest.WaitFor(t, wait, func() bool { return checked.String() == "kept " }, "an update the check passes")
	g.insert(5, "refuse me ")
	g.insert(0, "panic ")
	prototest.WaitFor(t, wait, func() bool {
		mu.Lock()
		defer mu.Unlock()
		return len(errs) >= 2
	}, "both dropped and reported")
	if checked.String() != "kept " {
		t.Fatalf("applied %q", checked.String())
	}
	mu.Lock()
	defer mu.Unlock()
	if !errors.Is(errs[0], refuse) || !strings.Contains(errs[1].Error(), "panic") {
		t.Fatalf("errors %v", errs)
	}
}

func TestACheckedFileAsksAgainForWhatItRefusedForNow(t *testing.T) {
	relay := prototest.NewRelay(true)
	key := protocol.GenerateKey()
	host := join(t, relay, key, joinOpts{header: hostHeader(), onError: func(error) {}})
	checked := newFileText("")
	var mu sync.Mutex
	refused := false
	check := func(doc *crdt.Doc, update []byte) error {
		mu.Lock()
		defer mu.Unlock()
		if strings.Contains(string(update), "later") && !refused {
			refused = true
			return fmt.Errorf("%w: for the test", protocol.ErrRetryLater)
		}
		return nil
	}
	if err := host.AddCheckedFile(1, checked.doc, check); err != nil {
		t.Fatal(err)
	}
	prototest.WaitFor(t, wait, func() bool { return host.Status() == protocol.StatusConnected }, "host connected")
	guest := join(t, relay, key, joinOpts{})
	g := newFileText("")
	addFile(t, guest, 1, g)
	prototest.WaitFor(t, wait, func() bool { return guest.Status() == protocol.StatusConnected }, "guest connected")
	g.insert(0, "later")
	// Refused once, then asked for again, and applied with the answer.
	prototest.WaitFor(t, wait, func() bool { return checked.String() == "later" }, "the refused update, asked for again")
}

func TestACheckedFileAsksAgainForWhatItRefusedWhileItWaited(t *testing.T) {
	// From review: the answer to the Client's asking again was refused too,
	// and nothing came after it to have the Client ask once more.
	protocol.ShortenResyncForTest(t, 50*time.Millisecond)
	relay := prototest.NewRelay(true)
	key := protocol.GenerateKey()
	host := join(t, relay, key, joinOpts{header: hostHeader(), onError: func(error) {}})
	checked := newFileText("")
	var mu sync.Mutex
	refusals := 0
	check := func(doc *crdt.Doc, update []byte) error {
		mu.Lock()
		defer mu.Unlock()
		if strings.Contains(string(update), "later") && refusals < 2 {
			refusals++
			return fmt.Errorf("%w: for the test", protocol.ErrRetryLater)
		}
		return nil
	}
	if err := host.AddCheckedFile(1, checked.doc, check); err != nil {
		t.Fatal(err)
	}
	prototest.WaitFor(t, wait, func() bool { return host.Status() == protocol.StatusConnected }, "host connected")
	guest := join(t, relay, key, joinOpts{})
	g := newFileText("")
	addFile(t, guest, 1, g)
	prototest.WaitFor(t, wait, func() bool { return guest.Status() == protocol.StatusConnected }, "guest connected")
	g.insert(0, "later")
	prototest.WaitFor(t, wait, func() bool { return checked.String() == "later" }, "the update, asked for a second time")
}

// A destroyed Client asks for nothing again: its timers would outlive it.
func TestDestroyStopsAskingAgain(t *testing.T) {
	protocol.ShortenResyncForTest(t, time.Hour)
	relay := prototest.NewRelay(true)
	key := protocol.GenerateKey()
	host := join(t, relay, key, joinOpts{header: hostHeader(), onError: func(error) {}})
	checked := newFileText("")
	check := func(*crdt.Doc, []byte) error {
		return fmt.Errorf("%w: for the test", protocol.ErrRetryLater)
	}
	if err := host.AddCheckedFile(1, checked.doc, check); err != nil {
		t.Fatal(err)
	}
	prototest.WaitFor(t, wait, func() bool { return host.Status() == protocol.StatusConnected }, "host connected")
	guest := join(t, relay, key, joinOpts{})
	g := newFileText("")
	addFile(t, guest, 1, g)
	prototest.WaitFor(t, wait, func() bool { return guest.Status() == protocol.StatusConnected }, "guest connected")
	g.insert(0, "refused")
	prototest.WaitFor(t, wait, func() bool { return host.PendingResyncs() == 1 }, "asking again, later")
	host.Destroy()
	if n := host.PendingResyncs(); n != 0 {
		t.Fatalf("%d files still mean to ask again", n)
	}
}
