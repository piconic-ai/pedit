package protocol

import (
	"bytes"
	"crypto/ed25519"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"os"
	"reflect"
	"testing"

	"github.com/reearth/ygo/crdt"
)

type inventoryFixture struct {
	Update, Wire, First, Second, Deletion, Asset string
	Additions                                    []string
}

func loadInventoryFixture(t *testing.T) inventoryFixture {
	t.Helper()
	raw, err := os.ReadFile("../../packages/testdata/kept-inventory-update-vectors.json")
	if err != nil {
		t.Fatal(err)
	}
	var v inventoryFixture
	if err = json.Unmarshal(raw, &v); err != nil {
		t.Fatal(err)
	}
	return v
}
func inventoryBytes(t *testing.T, s string) []byte {
	t.Helper()
	b, err := base64.StdEncoding.Strict().DecodeString(s)
	if err != nil {
		t.Fatal(err)
	}
	return b
}
func TestKeptInventoryWireFixture(t *testing.T) {
	f := loadInventoryFixture(t)
	update := inventoryBytes(t, f.Update)
	wire := inventoryBytes(t, f.Wire)
	encoded, err := EncodeKeptInventoryUpdate(KeptInventoryUpdate{Update: update, Additions: f.Additions})
	if err != nil || !bytes.Equal(encoded, wire) {
		t.Fatal("encode", err)
	}
	decoded, err := DecodeKeptInventoryUpdate(wire)
	if err != nil || !bytes.Equal(decoded.Update, update) || !reflect.DeepEqual(decoded.Additions, f.Additions) {
		t.Fatal("decode", err)
	}
	for _, bad := range [][]byte{wire[:len(wire)-1], append(bytes.Clone(wire), 0), {0}, make([]byte, MaxFrameBytes)} {
		if _, err := DecodeKeptInventoryUpdate(bad); err == nil {
			t.Fatal("accepted malformed")
		}
	}
	for _, bad := range [][]string{{f.Additions[1], f.Additions[0]}, {f.Additions[0], f.Additions[0]}, {"\ufeff" + f.Additions[0]}, {"assets/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.svg"}} {
		if _, err := EncodeKeptInventoryUpdate(KeptInventoryUpdate{Update: update, Additions: bad}); err == nil {
			t.Fatal("accepted path")
		}
	}
	if _, err := EncodeKeptInventoryUpdate(KeptInventoryUpdate{Update: []byte{255}}); err == nil {
		t.Fatal("accepted bad update")
	}
}
func TestKeptInventorySignatureBinding(t *testing.T) {
	f := loadInventoryFixture(t)
	raw, err := os.ReadFile("../../packages/testdata/kept-record-vectors.json")
	if err != nil {
		t.Fatal(err)
	}
	var v struct{ RoomID string }
	if err = json.Unmarshal(raw, &v); err != nil {
		t.Fatal(err)
	}
	var host, secret, epoch [32]byte
	copy(host[:], ed25519.NewKeyFromSeed(bytes.Repeat([]byte{7}, 32)).Public().(ed25519.PublicKey))
	copy(secret[:], bytes.Repeat([]byte{3}, 32))
	copy(epoch[:], bytes.Repeat([]byte{5}, 32))
	keys, err := DeriveKeptRoomKeys(KeptLinkSecrets{Access: AccessEdit, Secret: secret, HostKey: host}, v.RoomID)
	if err != nil {
		t.Fatal(err)
	}
	sender := ed25519.NewKeyFromSeed(bytes.Repeat([]byte{11}, 32))
	cert, err := CreateKeptSenderCertificate(keys, sender.Public().(ed25519.PublicKey))
	if err != nil {
		t.Fatal(err)
	}
	context := KeptRecordContext{RoomID: v.RoomID, Epoch: epoch, Generation: 1}
	wire := inventoryBytes(t, f.Wire)
	cipherText, err := SealKeptRecord(keys, context, sender, cert, 1, wire)
	if err != nil {
		t.Fatal(err)
	}
	record, err := OpenKeptRecord(keys, context, cipherText)
	if err != nil || !bytes.Equal(record.Message, wire) {
		t.Fatal("signature", err)
	}
	cipher, _ := NewCipher(keys.FrameKey)
	plain, err := cipher.Decrypt(cipherText)
	if err != nil {
		t.Fatal(err)
	}
	plain[len(plain)-65] ^= 1
	if _, err = OpenKeptRecord(keys, context, cipher.Encrypt(plain)); err == nil {
		t.Fatal("accepted signed payload alteration")
	}
}
func TestKeptInventoryReplayConcurrencyAndDeletion(t *testing.T) {
	f := loadInventoryFixture(t)
	var a, b [32]byte
	a[0] = 1
	b[0] = 2
	record := func(sender [32]byte, seq uint64, update string, additions []string) KeptRecord {
		msg, err := EncodeKeptInventoryUpdate(KeptInventoryUpdate{Update: inventoryBytes(t, update), Additions: additions})
		if err != nil {
			t.Fatal(err)
		}
		return KeptRecord{Access: AccessEdit, Sender: sender, Sequence: seq, Message: msg}
	}
	first := record(a, 1, f.First, []string{f.Additions[0]})
	second := record(b, 1, f.Second, []string{f.Additions[1]})
	deletion := record(a, 2, f.Deletion, nil)
	for _, records := range [][]KeptRecord{{first, second, first, deletion}, {second, first, deletion}} {
		ledger, _ := NewKeptLedger(10)
		result, err := ReplayKeptInventory(inventoryBytes(t, f.Update), nil, ledger, records)
		if err != nil {
			t.Fatal(err)
		}
		doc := crdt.New()
		if err = crdt.ApplyUpdateV1(doc, result.Text, nil); err != nil {
			t.Fatal(err)
		}
		if doc.GetText("content").ToString() != "Bhello" || !reflect.DeepEqual(result.Inventory, f.Additions) || len(result.Ledger.Snapshot()) != 3 {
			t.Fatal("wrong replay")
		}
		doc.Destroy()
	}
	ledger, _ := NewKeptLedger(10)
	collision := record(a, 1, f.Second, []string{f.Additions[1]})
	if _, err := ReplayKeptInventory(inventoryBytes(t, f.Update), nil, ledger, []KeptRecord{first, collision}); err == nil {
		t.Fatal("accepted conflicting sequence")
	}
	tooMany := make([]KeptRecord, 65)
	if _, err := ReplayKeptInventory(inventoryBytes(t, f.Update), nil, ledger, tooMany); err == nil {
		t.Fatal("accepted too many records")
	}
	first.Message = []byte{0, 1}
	if _, err := ReplayKeptInventory(inventoryBytes(t, f.Update), nil, ledger, []KeptRecord{first}); err == nil {
		t.Fatal("accepted legacy")
	}
}

func TestKeptInventoryReplayRequiresDeclaredReferences(t *testing.T) {
	f := loadInventoryFixture(t)
	var sender [32]byte
	sender[0] = 7
	build := func(paths []string) KeptRecord {
		message, err := EncodeKeptInventoryUpdate(KeptInventoryUpdate{Update: inventoryBytes(t, f.Asset), Additions: paths})
		if err != nil {
			t.Fatal(err)
		}
		return KeptRecord{Access: AccessEdit, Sender: sender, Sequence: 1, Message: message}
	}
	ledger, _ := NewKeptLedger(5)
	base := inventoryBytes(t, f.Update)
	if _, err := ReplayKeptInventory(base, nil, ledger, []KeptRecord{build(nil)}); err == nil {
		t.Fatal("undeclared reference accepted")
	}
	if len(ledger.Snapshot()) != 0 || !bytes.Equal(base, inventoryBytes(t, f.Update)) {
		t.Fatal("mutated input")
	}
	result, err := ReplayKeptInventory(base, nil, ledger, []KeptRecord{build([]string{f.Additions[0]})})
	if err != nil || !reflect.DeepEqual(result.Inventory, []string{f.Additions[0]}) {
		t.Fatal("declared reference rejected", err)
	}
}

func TestKeptInventoryPathBounds(t *testing.T) {
	f := loadInventoryFixture(t)
	paths := make([]string, 1024)
	for i := range paths {
		paths[i] = fmt.Sprintf("assets/%032x.png", i)
	}
	encoded, err := EncodeKeptInventoryUpdate(KeptInventoryUpdate{Update: inventoryBytes(t, f.Update), Additions: paths})
	if err != nil {
		t.Fatal(err)
	}
	decoded, err := DecodeKeptInventoryUpdate(encoded)
	if err != nil || !reflect.DeepEqual(decoded.Additions, paths) {
		t.Fatal("boundary", err)
	}
	if _, err = EncodeKeptInventoryUpdate(KeptInventoryUpdate{Update: inventoryBytes(t, f.Update), Additions: append(paths, "assets/ffffffffffffffffffffffffffffffff.png")}); err == nil {
		t.Fatal("accepted excess")
	}
	encoded[len(encoded)-1] = 255
	if _, err = DecodeKeptInventoryUpdate(encoded); err == nil {
		t.Fatal("accepted malformed utf-8")
	}
}

func TestKeptInventoryRejectsInvalidUpdateUTF8(t *testing.T) {
	f := loadInventoryFixture(t)
	update := inventoryBytes(t, f.Update)
	update[len(update)-2] = 255
	if _, err := EncodeKeptInventoryUpdate(KeptInventoryUpdate{Update: update}); err == nil {
		t.Fatal("accepted invalid UTF-8")
	}
}
