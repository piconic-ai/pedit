package protocol_test

import (
	"errors"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/piconic-ai/pedit/internal/protocol"
	"github.com/piconic-ai/pedit/internal/protocol/prototest"
	"github.com/reearth/ygo/awareness"
	"github.com/reearth/ygo/crdt"
	"github.com/reearth/ygo/encoding"
	ysync "github.com/reearth/ygo/sync"
)

// lowerLink is the link with this access below the edit link of key, in the
// room join puts peers in.
func lowerLink(t *testing.T, key string, access protocol.Access) *protocol.LinkSecrets {
	t.Helper()
	keys := editKeys(t, key)
	link, err := protocol.ParseFragment(keys.Fragments[access])
	if err != nil {
		t.Fatal(err)
	}
	return &link
}

func editKeys(t *testing.T, key string) *protocol.RoomKeys {
	t.Helper()
	raw, err := protocol.DecodeKey(key)
	if err != nil {
		t.Fatal(err)
	}
	keys, err := protocol.EditKeys(raw, "")
	if err != nil {
		t.Fatal(err)
	}
	return keys
}

func lowerKeys(t *testing.T, key string, access protocol.Access) *protocol.RoomKeys {
	t.Helper()
	keys, err := protocol.DeriveRoomKeys(*lowerLink(t, key, access), "")
	if err != nil {
		t.Fatal(err)
	}
	return keys
}

// errorLog records the errors a peer reports.
type errorLog struct {
	mu   sync.Mutex
	errs []error
}

func (l *errorLog) add(err error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.errs = append(l.errs, err)
}

func (l *errorLog) count(target error) int {
	l.mu.Lock()
	defer l.mu.Unlock()
	n := 0
	for _, err := range l.errs {
		if errors.Is(err, target) {
			n++
		}
	}
	return n
}

// insertUpdate is an update that inserts s at the start of a doc's content,
// made by a client of its own.
func insertUpdate(s string) []byte {
	doc := crdt.New()
	text := doc.GetText("content")
	doc.Transact(func(txn *crdt.Transaction) { text.Insert(txn, 0, s, nil) })
	return doc.EncodeStateAsUpdate()
}

// awarenessUpdate is an awareness message with one client's state.
func awarenessUpdate(t *testing.T, state map[string]any) []byte {
	t.Helper()
	aw := awareness.New(uint64(crdt.New().ClientID()))
	aw.SetLocalState(state)
	enc := encoding.NewEncoder()
	enc.WriteVarBytes(aw.EncodeUpdate([]uint64{aw.ClientID()}))
	return enc.Bytes()
}

func syncStep2Of(update []byte) []byte {
	enc := encoding.NewEncoder()
	enc.WriteVarUint(ysync.MsgSyncStep2)
	enc.WriteVarBytes(update)
	return enc.Bytes()
}

func TestLowerLinksReadButDoNotWrite(t *testing.T) {
	relay := prototest.NewRelay(false)
	key := protocol.GenerateKey()
	host := join(t, relay, key, joinOpts{init: "hello"})
	prototest.WaitFor(t, wait, func() bool { return host.Status() == protocol.StatusConnected }, "host connected")
	commenter := join(t, relay, key, joinOpts{link: lowerLink(t, key, protocol.AccessComment)})
	reader := join(t, relay, key, joinOpts{link: lowerLink(t, key, protocol.AccessRead)})
	prototest.WaitFor(t, wait, func() bool {
		return commenter.String() == "hello" && reader.String() == "hello"
	}, "lower links to get the doc")

	// What a lower link writes stays with it.
	commenter.insert(0, "C")
	reader.insert(0, "R")
	editor := join(t, relay, key, joinOpts{})
	prototest.WaitFor(t, wait, func() bool { return editor.String() == "hello" }, "an editor to get the doc")
	editor.insert(5, "!")
	prototest.WaitFor(t, wait, func() bool {
		return host.String() == "hello!" && commenter.String() == "Chello!" && reader.String() == "Rhello!"
	}, "the editor's edit everywhere, nothing else at the host")
}

// A peer with a lower link may run any client: whatever it sends, signed
// with its key, unsigned, or with a signature it forged, changes nothing but
// what its access allows.
func TestFramesFromLowerLinksChangeNothing(t *testing.T) {
	relay := prototest.NewRelay(false)
	key := protocol.GenerateKey()
	var mu sync.Mutex
	var canvas, manifests int
	var attachments []protocol.AttachmentKind
	var errs errorLog
	host := join(t, relay, key, joinOpts{
		init:    "hello",
		state:   map[string]any{"role": "host", "file": "notes.md"},
		onError: errs.add,
		onCanvas: func(protocol.CanvasMessage) {
			mu.Lock()
			defer mu.Unlock()
			canvas++
		},
		onAttachment: func(a protocol.Attachment) {
			mu.Lock()
			defer mu.Unlock()
			attachments = append(attachments, a.Kind)
		},
		onManifest: func([]protocol.FileEntry) {
			mu.Lock()
			defer mu.Unlock()
			manifests++
		},
	})
	prototest.WaitFor(t, wait, func() bool { return host.Status() == protocol.StatusConnected }, "host connected")
	conn, err := relay.Dial(t.Context(), "ws://test", nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = conn.Close() })

	canvasEdit, _ := protocol.EncodeCanvas(protocol.CanvasMessage{Kind: protocol.CanvasEdit, ID: "e1", Base: "{}", Next: "{}"})
	announce, _ := protocol.EncodeAttachment(protocol.Attachment{Kind: protocol.AttachmentAnnounce, Hash: protocol.ContentHash([]byte("x")), Mime: "image/png"})
	stored, _ := protocol.EncodeAttachment(protocol.Attachment{Kind: protocol.AttachmentStored, Hash: protocol.ContentHash([]byte("x")), Path: "assets/x.png"})
	want, _ := protocol.EncodeAttachment(protocol.Attachment{Kind: protocol.AttachmentWant, Hashes: []string{protocol.ContentHash([]byte("x"))}})
	manifest, _ := protocol.EncodeManifest([]protocol.FileEntry{{ID: 1, Path: "evil.md", Format: "text"}})
	update := insertUpdate("FORGED ")
	forbidden := [][]byte{
		protocol.EncodeMessage(protocol.MessageSync, ysync.EncodeUpdate(update)),
		protocol.EncodeMessage(protocol.MessageSync, syncStep2Of(update)),
		protocol.EncodeMessage(protocol.MessageCanvas, canvasEdit),
		protocol.EncodeMessage(protocol.MessageAttachment, announce),
		protocol.EncodeMessage(protocol.MessageAttachment, stored),
		protocol.EncodeMessage(protocol.MessageFiles, manifest),
		protocol.EncodeMessage(protocol.MessageAwareness, awarenessUpdate(t, map[string]any{"role": "host", "file": "evil.md"})),
	}
	counter := uint64(0)
	for _, access := range []protocol.Access{protocol.AccessComment, protocol.AccessRead} {
		keys := lowerKeys(t, key, access)
		for _, m := range forbidden {
			counter++
			if err := conn.Write(t.Context(), protocol.SealFrame(keys, protocol.Sender{byte(access) + 1}, counter, m)); err != nil {
				t.Fatal(err)
			}
		}
		counter++
		if err := conn.Write(t.Context(), protocol.SealFrame(keys, protocol.Sender{byte(access) + 1}, counter, protocol.EncodeMessage(protocol.MessageAttachment, want))); err != nil {
			t.Fatal(err)
		}
	}
	// A commenter's signature that claims to be an editor's.
	forged := protocol.SealFrame(lowerKeys(t, key, protocol.AccessComment), protocol.Sender{5}, 1, protocol.EncodeMessage(protocol.MessageCanvas, canvasEdit))
	if err := conn.Write(t.Context(), flipTier(t, key, forged)); err != nil {
		t.Fatal(err)
	}

	prototest.WaitFor(t, wait, func() bool {
		return errs.count(protocol.ErrNotAllowed) == 2*len(forbidden) && errs.count(protocol.ErrBadSignature) == 1
	}, "every forbidden frame refused")
	time.Sleep(50 * time.Millisecond)
	mu.Lock()
	defer mu.Unlock()
	if host.String() != "hello" || canvas != 0 || manifests != 0 {
		t.Fatalf("host: text %q, %d canvas edits, %d manifests", host.String(), canvas, manifests)
	}
	if len(attachments) != 2 || attachments[0] != protocol.AttachmentWant || attachments[1] != protocol.AttachmentWant {
		t.Fatalf("attachments = %v, want the two wants", attachments)
	}
	if len(host.aw.GetStates()) != 1 {
		t.Fatalf("host took awareness from lower links: %v", host.aw.GetStates())
	}
}

// flipTier makes a frame a commenter signed claim the editors' tier, as a
// hostile commenter could: it holds the frame key.
func flipTier(t *testing.T, key string, frame []byte) []byte {
	t.Helper()
	keys := editKeys(t, key)
	c, err := protocol.NewCipher(keys.FrameKey)
	if err != nil {
		t.Fatal(err)
	}
	plain, err := c.Decrypt(frame)
	if err != nil {
		t.Fatal(err)
	}
	plain[protocol.SenderBytes+8+1] = 0
	return c.Encrypt(plain)
}

// A commenter that names an editor's sender, with a counter far ahead,
// cannot have the editor's frames dropped.
func TestLowerLinksCannotSilenceEditors(t *testing.T) {
	relay := prototest.NewRelay(false)
	key := protocol.GenerateKey()
	var mu sync.Mutex
	var edits []string
	host := join(t, relay, key, joinOpts{onCanvas: func(m protocol.CanvasMessage) {
		mu.Lock()
		defer mu.Unlock()
		edits = append(edits, m.ID)
	}})
	prototest.WaitFor(t, wait, func() bool { return host.Status() == protocol.StatusConnected }, "host connected")
	conn, err := relay.Dial(t.Context(), "ws://test", nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = conn.Close() })
	edit := func(id string) []byte {
		payload, _ := protocol.EncodeCanvas(protocol.CanvasMessage{Kind: protocol.CanvasEdit, ID: id, Base: "{}", Next: "{}"})
		return protocol.EncodeMessage(protocol.MessageCanvas, payload)
	}
	editor := protocol.Sender{7}
	for _, frame := range [][]byte{
		protocol.SealFrame(lowerKeys(t, key, protocol.AccessComment), editor, 1<<62, edit("commenter")),
		protocol.SealFrame(lowerKeys(t, key, protocol.AccessRead), editor, 1<<62, edit("reader")),
		protocol.SealFrame(editKeys(t, key), editor, 1, edit("editor")),
	} {
		if err := conn.Write(t.Context(), frame); err != nil {
			t.Fatal(err)
		}
	}
	prototest.WaitFor(t, wait, func() bool { mu.Lock(); defer mu.Unlock(); return len(edits) == 1 }, "the editor's edit")
	if edits[0] != "editor" {
		t.Fatalf("edits = %v", edits)
	}
}

// Commenters write a file's comments, readers do not, and nobody below an
// editor writes the file.
func TestCommentersWriteCommentsOnly(t *testing.T) {
	relay := prototest.NewRelay(false)
	key := protocol.GenerateKey()
	var errs errorLog
	host := join(t, relay, key, joinOpts{onError: errs.add})
	hostNotes, hostComments := newFileText(""), newFileText("")
	addFile(t, host, 1, hostNotes)
	if err := host.AddCommentsFile(2, hostComments.doc, nil); err != nil {
		t.Fatal(err)
	}
	join := func(access protocol.Access) (*fileText, *fileText) {
		p := join(t, relay, key, joinOpts{link: lowerLink(t, key, access)})
		notes, comments := newFileText(""), newFileText("")
		addFile(t, p, 1, notes)
		if err := p.AddCommentsFile(2, comments.doc, nil); err != nil {
			t.Fatal(err)
		}
		return notes, comments
	}
	cNotes, cComments := join(protocol.AccessComment)
	rNotes, rComments := join(protocol.AccessRead)
	cNotes.insert(0, "c")
	rNotes.insert(0, "r")
	rComments.insert(0, "from the reader")
	cComments.insert(0, "from the commenter")
	prototest.WaitFor(t, wait, func() bool {
		return hostComments.String() == "from the commenter" && strings.Contains(rComments.String(), "from the commenter")
	}, "the commenter's comment everywhere")

	// A hostile reader's client sends its comment anyway, and a hostile
	// commenter's its edit of the file.
	conn, err := relay.Dial(t.Context(), "ws://test", nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = conn.Close() })
	update := func(file uint64) []byte {
		payload, err := protocol.EncodeFileDoc(file, protocol.MessageSync, ysync.EncodeUpdate(insertUpdate("FORGED")))
		if err != nil {
			t.Fatal(err)
		}
		return protocol.EncodeMessage(protocol.MessageFiles, payload)
	}
	for i, frame := range [][]byte{
		protocol.SealFrame(lowerKeys(t, key, protocol.AccessRead), protocol.Sender{1}, 1, update(2)),
		protocol.SealFrame(lowerKeys(t, key, protocol.AccessComment), protocol.Sender{2}, 1, update(1)),
	} {
		if err := conn.Write(t.Context(), frame); err != nil {
			t.Fatalf("frame %d: %v", i, err)
		}
	}
	prototest.WaitFor(t, wait, func() bool { return errs.count(protocol.ErrNotAllowed) == 2 }, "both refused")
	if hostNotes.String() != "" || hostComments.String() != "from the commenter" {
		t.Fatalf("host: notes %q, comments %q", hostNotes.String(), hostComments.String())
	}
}
