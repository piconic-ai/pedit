package protocol

import (
	"bytes"
	"crypto/ed25519"
	"encoding/base64"
	"encoding/json"
	"os"
	"testing"
)

func TestKeptRecordVector(t *testing.T) {
	raw, err := os.ReadFile("../../packages/testdata/kept-record-vectors.json")
	if err != nil {
		t.Fatal(err)
	}
	var v struct {
		RoomID, Epoch, Sender, Certificate, Message, Ciphertext string
		Generation, Sequence                                    uint64
	}
	if err := json.Unmarshal(raw, &v); err != nil {
		t.Fatal(err)
	}
	decode := func(s string) []byte {
		t.Helper()
		b, e := base64.RawURLEncoding.Strict().DecodeString(s)
		if e != nil {
			t.Fatal(e)
		}
		return b
	}
	host := ed25519.NewKeyFromSeed(bytes.Repeat([]byte{7}, 32)).Public().(ed25519.PublicKey)
	var h, secret, epoch [32]byte
	copy(h[:], host)
	copy(secret[:], bytes.Repeat([]byte{3}, 32))
	copy(epoch[:], decode(v.Epoch))
	keys, err := DeriveKeptRoomKeys(KeptLinkSecrets{Access: AccessEdit, Secret: secret, HostKey: h}, v.RoomID)
	if err != nil {
		t.Fatal(err)
	}
	c := KeptRecordContext{RoomID: v.RoomID, Epoch: epoch, Generation: v.Generation}
	sender := ed25519.NewKeyFromSeed(bytes.Repeat([]byte{11}, 32))
	cert, err := CreateKeptSenderCertificate(keys, sender.Public().(ed25519.PublicKey))
	if err != nil || !bytes.Equal(cert, decode(v.Certificate)) {
		t.Fatalf("certificate: %v", err)
	}
	got, err := OpenKeptRecord(keys, c, decode(v.Ciphertext))
	if err != nil || got.Access != AccessEdit || got.Sequence != v.Sequence || !bytes.Equal(got.Sender[:], decode(v.Sender)) || !bytes.Equal(got.Message, decode(v.Message)) {
		t.Fatalf("open vector: %+v %v", got, err)
	}
	ciphertext, err := SealKeptRecord(keys, c, sender, cert, v.Sequence, decode(v.Message))
	if err != nil {
		t.Fatal(err)
	}
	cipher, _ := NewCipher(keys.FrameKey)
	plain, err := cipher.Decrypt(ciphertext)
	if err != nil {
		t.Fatal(err)
	}
	want, err := cipher.Decrypt(decode(v.Ciphertext))
	if err != nil || !bytes.Equal(plain, want) {
		t.Fatalf("encoding mismatch: %v", err)
	}
	other := ed25519.NewKeyFromSeed(bytes.Repeat([]byte{12}, 32))
	if _, err := SealKeptRecord(keys, c, other, cert, v.Sequence, decode(v.Message)); err == nil {
		t.Fatal("accepted another sender's certificate")
	}
	for _, offset := range []int{0, len(recordDomain) + senderCertSize - 1, len(recordDomain) + senderCertSize, len(plain) - 65, len(plain) - 1} {
		forged := bytes.Clone(plain)
		forged[offset] ^= 1
		if _, err := OpenKeptRecord(keys, c, cipher.Encrypt(forged)); err == nil {
			t.Fatalf("accepted mutation at %d", offset)
		}
	}
	wrong := c
	wrong.Generation++
	if _, err := OpenKeptRecord(keys, wrong, ciphertext); err == nil {
		t.Fatal("accepted wrong generation")
	}
	bad := *keys
	bad.EditKey = other.Public().(ed25519.PublicKey)
	if _, err := OpenKeptRecord(&bad, c, ciphertext); err == nil {
		t.Fatal("accepted substituted tier key")
	}
	if _, err := SealKeptRecord(keys, c, sender, cert, 0, decode(v.Message)); err == nil {
		t.Fatal("accepted zero sequence")
	}
}

func TestKeptRecordCommentAndBoundaries(t *testing.T) {
	private := ed25519.NewKeyFromSeed(bytes.Repeat([]byte{7}, 32))
	var host, secret, epoch [32]byte
	copy(host[:], private.Public().(ed25519.PublicKey))
	copy(secret[:], bytes.Repeat([]byte{3}, 32))
	copy(epoch[:], bytes.Repeat([]byte{5}, 32))
	editor, err := DeriveKeptRoomKeys(KeptLinkSecrets{Access: AccessEdit, Secret: secret, HostKey: host}, "AAECAwQFBgcICQoLDA0ODw")
	if err != nil {
		t.Fatal(err)
	}
	link, err := ParseKeptFragment(editor.Fragments[AccessComment])
	if err != nil {
		t.Fatal(err)
	}
	commenter, err := DeriveKeptRoomKeys(link, editor.roomID)
	if err != nil {
		t.Fatal(err)
	}
	sender := ed25519.NewKeyFromSeed(bytes.Repeat([]byte{11}, 32))
	cert, err := CreateKeptSenderCertificate(commenter, sender.Public().(ed25519.PublicKey))
	if err != nil {
		t.Fatal(err)
	}
	context := KeptRecordContext{RoomID: editor.roomID, Epoch: epoch, Generation: maxKeptCounter}
	message := bytes.Repeat([]byte{1}, maxRecordPayload)
	ciphertext, err := SealKeptRecord(commenter, context, sender, cert, maxKeptCounter, message)
	if err != nil || len(ciphertext) != MaxFrameBytes {
		t.Fatalf("maximum record: %d %v", len(ciphertext), err)
	}
	record, err := OpenKeptRecord(editor, context, ciphertext)
	if err != nil || record.Access != AccessComment || record.Sequence != maxKeptCounter || !bytes.Equal(record.Message, message) {
		t.Fatalf("maximum record open: %v", err)
	}
	if _, err := SealKeptRecord(commenter, context, sender, cert, 1, append(message, 1)); err == nil {
		t.Fatal("accepted oversized message")
	}
	readLink, err := ParseKeptFragment(editor.Fragments[AccessRead])
	if err != nil {
		t.Fatal(err)
	}
	reader, err := DeriveKeptRoomKeys(readLink, editor.roomID)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := CreateKeptSenderCertificate(reader, sender.Public().(ed25519.PublicKey)); err == nil {
		t.Fatal("reader created sender certificate")
	}
}
