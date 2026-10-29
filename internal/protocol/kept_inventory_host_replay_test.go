package protocol

import (
	"bytes"
	"crypto/ed25519"
	"encoding/base64"
	"encoding/json"
	"os"
	"reflect"
	"strings"
	"testing"

	"github.com/reearth/ygo/crdt"
)

type inventoryReplayFixture struct {
	Update, First, Second, Deletion, Asset string
	Additions                              []string
}
type inventoryHostTest struct {
	keys         *KeptRoomKeys
	host, sender ed25519.PrivateKey
	cert         []byte
	context      KeptCheckpointContext
	payload      KeptMultiPayload
	vector       inventoryReplayFixture
}

func newInventoryHostTest(t *testing.T) inventoryHostTest {
	t.Helper()
	raw, e := os.ReadFile("../../packages/testdata/kept-inventory-update-vectors.json")
	if e != nil {
		t.Fatal(e)
	}
	var v inventoryReplayFixture
	if e = json.Unmarshal(raw, &v); e != nil {
		t.Fatal(e)
	}
	host := ed25519.NewKeyFromSeed(bytes.Repeat([]byte{7}, 32))
	sender := ed25519.NewKeyFromSeed(bytes.Repeat([]byte{11}, 32))
	var h, secret, epoch [32]byte
	copy(h[:], host.Public().(ed25519.PublicKey))
	copy(secret[:], bytes.Repeat([]byte{3}, 32))
	copy(epoch[:], bytes.Repeat([]byte{5}, 32))
	room := "AAECAwQFBgcICQoLDA0ODw"
	keys, e := DeriveKeptRoomKeys(KeptLinkSecrets{Access: AccessEdit, Secret: secret, HostKey: h}, room)
	if e != nil {
		t.Fatal(e)
	}
	cert, e := CreateKeptSenderCertificate(keys, sender.Public().(ed25519.PublicKey))
	if e != nil {
		t.Fatal(e)
	}
	old := loadTextVector(t)
	single, e := DecodeKeptTextPayload(textVectorBytes(t, old.Payload), MaxKeptCheckpointReceipts)
	if e != nil {
		t.Fatal(e)
	}
	rawText, e := base64.StdEncoding.Strict().DecodeString(v.Update)
	if e != nil {
		t.Fatal(e)
	}
	ledger, e := NewKeptLedger(32)
	if e != nil {
		t.Fatal(e)
	}
	return inventoryHostTest{keys: keys, host: host, sender: sender, cert: cert, context: KeptCheckpointContext{RoomID: room, Epoch: epoch, Generation: 1}, vector: v, payload: KeptMultiPayload{Manifest: []FileEntry{{ID: 0, Path: "draft.md", Format: FormatText}, {ID: 7, Path: MetaPath("draft.md"), Format: FormatMeta}}, Documents: map[uint64][]byte{0: rawText, 7: single.Documents[7]}, Attachments: []string{}, Ledger: ledger}}
}
func (f inventoryHostTest) sealCheckpoint(t *testing.T, plain []byte) []byte {
	t.Helper()
	out, err := SealKeptCheckpoint(f.keys, f.host, f.context, plain)
	if err != nil {
		t.Fatal(err)
	}
	return out
}
func (f inventoryHostTest) checkpoint(t *testing.T) []byte {
	t.Helper()
	plain, err := EncodeKeptInventoryCheckpoint(f.payload)
	if err != nil {
		t.Fatal(err)
	}
	return f.sealCheckpoint(t, plain)
}
func (f inventoryHostTest) frame(t *testing.T, seq uint64, update string, paths []string) []byte {
	t.Helper()
	u, e := base64.StdEncoding.Strict().DecodeString(update)
	if e != nil {
		t.Fatal(e)
	}
	msg, e := EncodeKeptInventoryUpdate(KeptInventoryUpdate{Update: u, Additions: paths})
	if e != nil {
		t.Fatal(e)
	}
	return f.rawFrame(t, seq, msg)
}
func (f inventoryHostTest) rawFrame(t *testing.T, seq uint64, msg []byte) []byte {
	t.Helper()
	c := KeptRecordContext{RoomID: f.context.RoomID, Epoch: f.context.Epoch, Generation: f.context.Generation}
	out, e := SealKeptRecord(f.keys, c, f.sender, f.cert, seq, msg)
	if e != nil {
		t.Fatal(e)
	}
	return out
}
func TestInventoryHostReplaySignedCheckpointAndRecords(t *testing.T) {
	f := newInventoryHostTest(t)
	cp := f.checkpoint(t)
	first := f.frame(t, 1, f.vector.First, []string{f.vector.Additions[0]})
	deletion := f.frame(t, 2, f.vector.Deletion, nil)
	got, err := ReplaySignedKeptInventory(f.keys, f.context, cp, [][]byte{first, first, deletion})
	if err != nil {
		t.Fatal(err)
	}
	doc := crdt.New()
	defer doc.Destroy()
	if err = crdt.ApplyUpdateV1(doc, got.Text, nil); err != nil {
		t.Fatal(err)
	}
	if doc.GetText("content").ToString() != "hello" || !reflect.DeepEqual(got.Inventory, []string{f.vector.Additions[0]}) || len(got.Ledger.Snapshot()) != 2 || got.MetadataID != 7 || !bytes.Equal(got.Comments, f.payload.Documents[7]) {
		t.Fatal("incorrect observation")
	}
}
func TestInventoryHostReplayRejectsUntrustedModesAndLegacy(t *testing.T) {
	f := newInventoryHostTest(t)
	cp := f.checkpoint(t)
	plain, err := OpenKeptCheckpoint(f.keys, f.context, cp)
	if err != nil {
		t.Fatal(err)
	}
	wrongMode := bytes.Clone(plain)
	wrongMode[len(inventoryCheckpointDomain)] = 1
	legacy, err := EncodeKeptMultiPayload(f.payload)
	if err != nil {
		t.Fatal(err)
	}
	altered := bytes.Clone(cp)
	altered[len(altered)-1] ^= 1
	for _, item := range []struct {
		name       string
		checkpoint []byte
		frames     [][]byte
	}{{"version", f.sealCheckpoint(t, wrongMode), nil}, {"legacy-checkpoint", f.sealCheckpoint(t, legacy), nil}, {"bad-signature", altered, nil}, {"legacy-record", cp, [][]byte{f.rawFrame(t, 1, []byte{0, 1})}}, {"unknown-record", cp, [][]byte{f.rawFrame(t, 1, []byte("future"))}}} {
		t.Run(item.name, func(t *testing.T) {
			copyCP := bytes.Clone(item.checkpoint)
			out, err := ReplaySignedKeptInventory(f.keys, f.context, item.checkpoint, item.frames)
			if err == nil || out.Text != nil || out.Inventory != nil || len(out.Ledger.Snapshot()) != 0 || !bytes.Equal(copyCP, item.checkpoint) {
				t.Fatal("untrusted input accepted or mutated", err)
			}
		})
	}
}
func TestInventoryHostReplayChecksNormalizedCheckpointReference(t *testing.T) {
	f := newInventoryHostTest(t)
	doc := crdt.New()
	defer doc.Destroy()
	text := doc.GetText("content")
	path := f.vector.Additions[0]
	encoded := strings.Replace(path, "/", "&#47;", 1)
	doc.Transact(func(tx *crdt.Transaction) { text.Insert(tx, 0, "![]("+encoded+")", nil) })
	f.payload.Documents[0] = crdt.EncodeStateAsUpdateV1(doc, nil)
	if _, err := ReplaySignedKeptInventory(f.keys, f.context, f.checkpoint(t), nil); err == nil {
		t.Fatal("accepted undeclared normalized reference")
	}
	f.payload.Attachments = []string{path}
	if _, err := ReplaySignedKeptInventory(f.keys, f.context, f.checkpoint(t), nil); err != nil {
		t.Fatal("rejected declared normalized reference", err)
	}
}

func TestInventoryHostReplayChecksNormalizedUpdateReference(t *testing.T) {
	f := newInventoryHostTest(t)
	doc := crdt.New()
	defer doc.Destroy()
	text := doc.GetText("content")
	path := f.vector.Additions[0]
	encoded := strings.Replace(path, "/", `\/`, 1)
	doc.Transact(func(tx *crdt.Transaction) { text.Insert(tx, 0, "![]("+encoded+")", nil) })
	update := base64.StdEncoding.EncodeToString(crdt.EncodeStateAsUpdateV1(doc, nil))
	cp := f.checkpoint(t)
	if _, err := ReplaySignedKeptInventory(f.keys, f.context, cp, [][]byte{f.frame(t, 1, update, nil)}); err == nil {
		t.Fatal("accepted undeclared normalized update reference")
	}
	if _, err := ReplaySignedKeptInventory(f.keys, f.context, cp, [][]byte{f.frame(t, 1, update, []string{path})}); err != nil {
		t.Fatal("rejected declared normalized update reference", err)
	}
}

func TestInventoryHostReplayRejectsUnsupportedReferenceSyntax(t *testing.T) {
	f := newInventoryHostTest(t)
	doc := crdt.New()
	defer doc.Destroy()
	text := doc.GetText("content")
	doc.Transact(func(tx *crdt.Transaction) { text.Insert(tx, 0, "![image][ref]\n\n[ref]: "+f.vector.Additions[0], nil) })
	f.payload.Documents[0] = crdt.EncodeStateAsUpdateV1(doc, nil)
	f.payload.Attachments = []string{f.vector.Additions[0]}
	if _, err := ReplaySignedKeptInventory(f.keys, f.context, f.checkpoint(t), nil); err == nil {
		t.Fatal("accepted unsupported reference-style image")
	}
}

func TestInventoryHostReplayRejectsUndeclaredAndSequenceConflict(t *testing.T) {
	f := newInventoryHostTest(t)
	cp := f.checkpoint(t)
	undeclared := f.frame(t, 1, f.vector.Asset, nil)
	before := bytes.Clone(cp)
	out, err := ReplaySignedKeptInventory(f.keys, f.context, cp, [][]byte{undeclared})
	if err == nil || out.Text != nil || out.Inventory != nil || !bytes.Equal(cp, before) {
		t.Fatal("undeclared accepted", err)
	}
	first := f.frame(t, 1, f.vector.First, []string{f.vector.Additions[0]})
	wrong := f.frame(t, 1, f.vector.Second, nil)
	if out, err = ReplaySignedKeptInventory(f.keys, f.context, cp, [][]byte{first, wrong}); err == nil || out.Text != nil || len(out.Ledger.Snapshot()) != 0 {
		t.Fatal("conflict accepted", err)
	}
	valid := f.frame(t, 1, f.vector.Asset, []string{f.vector.Additions[0]})
	if out, err = ReplaySignedKeptInventory(f.keys, f.context, cp, [][]byte{valid}); err != nil || !reflect.DeepEqual(out.Inventory, []string{f.vector.Additions[0]}) {
		t.Fatal("valid rejected", err)
	}
}

func TestInventoryHostReplayRejectsDuplicateLegacyEvenWithBaselineReceipt(t *testing.T) {
	f := newInventoryHostTest(t)
	legacy := f.rawFrame(t, 1, []byte{0, 1})
	record, err := OpenKeptRecord(f.keys, KeptRecordContext{RoomID: f.context.RoomID, Epoch: f.context.Epoch, Generation: f.context.Generation}, legacy)
	if err != nil {
		t.Fatal(err)
	}
	plan, err := f.payload.Ledger.Inspect(record)
	if err != nil {
		t.Fatal(err)
	}
	f.payload.Ledger, err = f.payload.Ledger.Commit(plan, KeptApplied)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = ReplaySignedKeptInventory(f.keys, f.context, f.checkpoint(t), [][]byte{legacy}); err == nil {
		t.Fatal("accepted duplicate legacy record")
	}
}
func TestInventoryHostReplayRejectsForgedRecordSignature(t *testing.T) {
	f := newInventoryHostTest(t)
	frame := f.frame(t, 1, f.vector.First, nil)
	cipher, err := NewCipher(f.keys.FrameKey)
	if err != nil {
		t.Fatal(err)
	}
	plain, err := cipher.Decrypt(frame)
	if err != nil {
		t.Fatal(err)
	}
	plain[len(plain)-65] ^= 1
	if _, err = ReplaySignedKeptInventory(f.keys, f.context, f.checkpoint(t), [][]byte{cipher.Encrypt(plain)}); err == nil {
		t.Fatal("accepted forged signed record")
	}
}
func TestInventoryHostReplayEnforcesCumulativeTextWork(t *testing.T) {
	f := newInventoryHostTest(t)
	cp := f.checkpoint(t)
	baseWork, err := KeptTextWork(f.payload.Documents[0], false)
	if err != nil {
		t.Fatal(err)
	}
	makeUpdate := func(n uint64) []byte {
		doc := crdt.New()
		defer doc.Destroy()
		text := doc.GetText("content")
		for range n {
			doc.Transact(func(tx *crdt.Transaction) { text.Insert(tx, 0, "x", nil) })
		}
		return crdt.EncodeStateAsUpdateV1(doc, nil)
	}
	makeFrame := func(update []byte) []byte {
		msg, e := EncodeKeptInventoryUpdate(KeptInventoryUpdate{Update: update})
		if e != nil {
			t.Fatal(e)
		}
		return f.rawFrame(t, 1, msg)
	}
	atLimit := makeUpdate(MaxKeptYjsWork - baseWork)
	work, err := KeptTextWork(atLimit, true)
	if err != nil || baseWork+work != MaxKeptYjsWork {
		t.Fatalf("bad boundary fixture %d %d %v", baseWork, work, err)
	}
	if _, err = ReplaySignedKeptInventory(f.keys, f.context, cp, [][]byte{makeFrame(atLimit)}); err != nil {
		t.Fatal("boundary rejected", err)
	}
	above := makeUpdate(MaxKeptYjsWork - baseWork + 1)
	work, err = KeptTextWork(above, true)
	if err != nil || baseWork+work != MaxKeptYjsWork+1 {
		t.Fatalf("bad over-limit fixture %d %v", work, err)
	}
	out, err := ReplaySignedKeptInventory(f.keys, f.context, cp, [][]byte{makeFrame(above)})
	if err == nil || out.Text != nil || out.Inventory != nil || len(out.Ledger.Snapshot()) != 0 {
		t.Fatal("work budget bypass", err)
	}
}

func TestInventoryHostReplayChargesAcrossRecords(t *testing.T) {
	f := newInventoryHostTest(t)
	checkpoint := f.checkpoint(t)
	create := func(n int) []byte {
		doc := crdt.New()
		defer doc.Destroy()
		text := doc.GetText("content")
		for range n {
			doc.Transact(func(tx *crdt.Transaction) { text.Insert(tx, 0, "x", nil) })
		}
		return crdt.EncodeStateAsUpdateV1(doc, nil)
	}
	frame := func(seq uint64, update []byte) []byte {
		message, err := EncodeKeptInventoryUpdate(KeptInventoryUpdate{Update: update})
		if err != nil {
			t.Fatal(err)
		}
		return f.rawFrame(t, seq, message)
	}
	one := frame(1, create(512))
	two := frame(2, create(511))
	over := frame(2, create(512))
	if _, err := ReplaySignedKeptInventory(f.keys, f.context, checkpoint, [][]byte{one, one, two}); err != nil {
		t.Fatal("boundary or duplicate rejected", err)
	}
	if out, err := ReplaySignedKeptInventory(f.keys, f.context, checkpoint, [][]byte{one, over}); err == nil || out.Text != nil || len(out.Ledger.Snapshot()) != 0 {
		t.Fatal("cumulative work exceeded", err)
	}
}

func TestInventoryHostReplayConcurrentSenders(t *testing.T) {
	f := newInventoryHostTest(t)
	checkpoint := f.checkpoint(t)
	first := f.frame(t, 1, f.vector.First, []string{f.vector.Additions[0]})
	other := ed25519.NewKeyFromSeed(bytes.Repeat([]byte{12}, 32))
	cert, err := CreateKeptSenderCertificate(f.keys, other.Public().(ed25519.PublicKey))
	if err != nil {
		t.Fatal(err)
	}
	update, err := base64.StdEncoding.Strict().DecodeString(f.vector.Second)
	if err != nil {
		t.Fatal(err)
	}
	message, err := EncodeKeptInventoryUpdate(KeptInventoryUpdate{Update: update, Additions: []string{f.vector.Additions[1]}})
	if err != nil {
		t.Fatal(err)
	}
	context := KeptRecordContext{RoomID: f.context.RoomID, Epoch: f.context.Epoch, Generation: f.context.Generation}
	second, err := SealKeptRecord(f.keys, context, other, cert, 1, message)
	if err != nil {
		t.Fatal(err)
	}
	for _, frames := range [][][]byte{{first, second}, {second, first}} {
		observation, err := ReplaySignedKeptInventory(f.keys, f.context, checkpoint, frames)
		if err != nil {
			t.Fatal(err)
		}
		doc := crdt.New()
		if err = crdt.ApplyUpdateV1(doc, observation.Text, nil); err != nil {
			t.Fatal(err)
		}
		if doc.GetText("content").ToString() != "BhelloA" || !reflect.DeepEqual(observation.Inventory, f.vector.Additions) || len(observation.Ledger.Snapshot()) != 2 {
			t.Fatal("concurrent observations diverged")
		}
		doc.Destroy()
	}
}

func TestInventoryHostReplayFailedTailDoesNotChangeEarlierObservation(t *testing.T) {
	f := newInventoryHostTest(t)
	cp := f.checkpoint(t)
	first := f.frame(t, 1, f.vector.First, []string{f.vector.Additions[0]})
	baseline, err := ReplaySignedKeptInventory(f.keys, f.context, cp, [][]byte{first})
	if err != nil {
		t.Fatal(err)
	}
	oldText := bytes.Clone(baseline.Text)
	oldInventory := append([]string{}, baseline.Inventory...)
	oldLedger := baseline.Ledger.Snapshot()
	bad := f.rawFrame(t, 2, []byte("unknown"))
	out, err := ReplaySignedKeptInventory(f.keys, f.context, cp, [][]byte{first, bad})
	if err == nil || out.Text != nil || out.Inventory != nil || len(out.Ledger.Snapshot()) != 0 {
		t.Fatal("failed replay returned candidate", err)
	}
	if !bytes.Equal(oldText, baseline.Text) || !reflect.DeepEqual(oldInventory, baseline.Inventory) || !reflect.DeepEqual(oldLedger, baseline.Ledger.Snapshot()) {
		t.Fatal("failed replay modified earlier observation")
	}
	again, err := ReplaySignedKeptInventory(f.keys, f.context, cp, [][]byte{first})
	if err != nil || !bytes.Equal(again.Text, oldText) || !reflect.DeepEqual(again.Inventory, oldInventory) || !reflect.DeepEqual(again.Ledger.Snapshot(), oldLedger) {
		t.Fatal("retry diverged", err)
	}
}

func TestInventoryHostReplayRejectsCheckpointContextChanges(t *testing.T) {
	f := newInventoryHostTest(t)
	checkpoint := f.checkpoint(t)
	epoch := f.context
	epoch.Epoch[0] ^= 1
	generation := f.context
	generation.Generation++
	cutoff := f.context
	cutoff.Cutoff++
	room := f.context
	room.RoomID = "AAAAAAAAAAAAAAAAAAAAAA"
	for _, context := range []KeptCheckpointContext{epoch, generation, cutoff, room} {
		if out, err := ReplaySignedKeptInventory(f.keys, context, checkpoint, nil); err == nil || out.Text != nil {
			t.Fatal("accepted changed checkpoint context", err)
		}
	}
}
