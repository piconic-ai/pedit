package protocol

import (
	"bytes"
	"crypto/ed25519"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"os"
	"testing"
)

func ledgerVector(t *testing.T) []byte {
	t.Helper()
	data, err := os.ReadFile("../../packages/testdata/kept-ledger-encoding-vectors.json")
	if err != nil {
		t.Fatal(err)
	}
	var fixture struct{ Encoded string }
	if err = json.Unmarshal(data, &fixture); err != nil {
		t.Fatal(err)
	}
	raw, err := base64.RawURLEncoding.Strict().DecodeString(fixture.Encoded)
	if err != nil {
		t.Fatal(err)
	}
	return raw
}

func TestKeptLedgerEncodingVector(t *testing.T) {
	input := ledgerVector(t)
	ledger, err := DecodeKeptLedger(4, input)
	if err != nil {
		t.Fatal(err)
	}
	output, err := EncodeKeptLedger(ledger)
	if err != nil || !bytes.Equal(output, input) {
		t.Fatalf("encode vector: %v", err)
	}
	receipts := ledger.Snapshot()
	receipts[0], receipts[1], receipts[2] = receipts[2], receipts[0], receipts[1]
	alternate, err := RestoreKeptLedger(4, receipts)
	if err != nil {
		t.Fatal(err)
	}
	output, err = EncodeKeptLedger(alternate)
	if err != nil || !bytes.Equal(output, input) {
		t.Fatalf("encoding depends on receipt order: %v", err)
	}
	if _, err := DecodeKeptLedger(3, input); err == nil {
		t.Fatal("accepted snapshot over limit")
	}
}

func TestKeptLedgerEncodingRejectsMalformed(t *testing.T) {
	input := ledgerVector(t)
	for _, offset := range []int{0, len(ledgerDomain), ledgerHeaderSize, ledgerHeaderSize + 33 + 7, ledgerHeaderSize + 73} {
		bad := bytes.Clone(input)
		bad[offset] = 255
		if _, err := DecodeKeptLedger(4, bad); err == nil {
			t.Fatalf("accepted invalid field %d", offset)
		}
	}
	gap := bytes.Clone(input)
	gap[ledgerHeaderSize+3*ledgerReceiptSize+40] = 2
	if _, err := DecodeKeptLedger(4, gap); err == nil {
		t.Fatal("accepted gap")
	}
	for _, count := range []uint32{0xffffffff, 0x40000000, 0x80000004, uint32(maxLedgerReceipts + 1)} {
		bad := bytes.Clone(input)
		binary.BigEndian.PutUint32(bad[len(ledgerDomain):], count)
		if _, err := DecodeKeptLedger(4, bad); err == nil {
			t.Fatalf("accepted count %d", count)
		}
	}
	duplicate := bytes.Clone(input)
	copy(duplicate[ledgerHeaderSize+ledgerReceiptSize:], duplicate[ledgerHeaderSize:ledgerHeaderSize+ledgerReceiptSize])
	if _, err := DecodeKeptLedger(4, duplicate); err == nil {
		t.Fatal("accepted duplicate")
	}
	swapped := bytes.Clone(input)
	first := bytes.Clone(swapped[ledgerHeaderSize : ledgerHeaderSize+ledgerReceiptSize])
	copy(swapped[ledgerHeaderSize:], swapped[ledgerHeaderSize+ledgerReceiptSize:ledgerHeaderSize+2*ledgerReceiptSize])
	copy(swapped[ledgerHeaderSize+ledgerReceiptSize:], first)
	if _, err := DecodeKeptLedger(4, swapped); err == nil {
		t.Fatal("accepted noncanonical order")
	}
	if _, err := DecodeKeptLedger(4, input[:len(input)-1]); err == nil {
		t.Fatal("accepted truncation")
	}
	if _, err := DecodeKeptLedger(4, append(bytes.Clone(input), 0)); err == nil {
		t.Fatal("accepted trailing bytes")
	}
}

func TestKeptLedgerCheckpointIntegrity(t *testing.T) {
	host := ed25519.NewKeyFromSeed(bytes.Repeat([]byte{7}, 32))
	var hostPublic, secret, epoch [32]byte
	copy(hostPublic[:], host.Public().(ed25519.PublicKey))
	copy(secret[:], bytes.Repeat([]byte{3}, 32))
	copy(epoch[:], bytes.Repeat([]byte{5}, 32))
	keys, err := DeriveKeptRoomKeys(KeptLinkSecrets{Access: AccessEdit, Secret: secret, HostKey: hostPublic}, "AAECAwQFBgcICQoLDA0ODw")
	if err != nil {
		t.Fatal(err)
	}
	context := KeptCheckpointContext{RoomID: keys.roomID, Epoch: epoch, Generation: 1, Cutoff: 0}
	data, err := os.ReadFile("../../packages/testdata/kept-ledger-encoding-vectors.json")
	if err != nil {
		t.Fatal(err)
	}
	var fixture struct{ Checkpoint string }
	if err = json.Unmarshal(data, &fixture); err != nil {
		t.Fatal(err)
	}
	vector, err := base64.RawURLEncoding.Strict().DecodeString(fixture.Checkpoint)
	if err != nil {
		t.Fatal(err)
	}
	vectorContext := context
	vectorContext.Cutoff = 9
	plainVector, err := OpenKeptCheckpoint(keys, vectorContext, vector)
	if err != nil || !bytes.Equal(plainVector, ledgerVector(t)) {
		t.Fatalf("open checkpoint vector: %v", err)
	}
	sealed, err := SealKeptCheckpoint(keys, host, context, ledgerVector(t))
	if err != nil {
		t.Fatal(err)
	}
	opened, err := OpenKeptCheckpoint(keys, context, sealed)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = DecodeKeptLedger(4, opened); err != nil {
		t.Fatal(err)
	}
	cipher, _ := NewCipher(keys.FrameKey)
	plain, err := cipher.Decrypt(sealed)
	if err != nil {
		t.Fatal(err)
	}
	plain[keptCheckpointHeader+ledgerHeaderSize+41] ^= 1
	if _, err := OpenKeptCheckpoint(keys, context, cipher.Encrypt(plain)); err == nil {
		t.Fatal("accepted reader-forged ledger")
	}
}

func TestKeptLedgerEncodingCapacity(t *testing.T) {
	items := make([]KeptReceipt, maxLedgerReceipts+1)
	for i := range items {
		items[i] = KeptReceipt{Access: AccessEdit, Sequence: uint64(i + 1), Outcome: KeptApplied}
	}
	l, err := RestoreKeptLedger(len(items), items[:maxLedgerReceipts])
	if err != nil {
		t.Fatal(err)
	}
	data, err := EncodeKeptLedger(l)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := DecodeKeptLedger(len(items), data); err != nil {
		t.Fatal(err)
	}
	l, err = RestoreKeptLedger(len(items), items)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := EncodeKeptLedger(l); err == nil {
		t.Fatal("accepted oversized ledger")
	}
	if len(l.Snapshot()) != len(items) {
		t.Fatal("capacity failure lost receipts")
	}
}

func TestKeptLedgerEncodingEmpty(t *testing.T) {
	ledger, err := NewKeptLedger(1)
	if err != nil {
		t.Fatal(err)
	}
	data, err := EncodeKeptLedger(ledger)
	if err != nil {
		t.Fatal(err)
	}
	restored, err := DecodeKeptLedger(1, data)
	if err != nil || len(restored.Snapshot()) != 0 {
		t.Fatalf("empty ledger: %v", err)
	}
}
