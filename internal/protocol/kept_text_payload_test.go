package protocol

import (
	"bytes"
	"crypto/ed25519"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"os"
	"testing"

	"github.com/reearth/ygo/crdt"
)

type textVector struct {
	RoomID, Epoch, Payload, Checkpoint, Main, Metadata, UpdateA, UpdateB, Merged, Start, End string
	Generation, Cutoff                                                                       uint64
}

func loadTextVector(t *testing.T) textVector {
	t.Helper()
	data, err := os.ReadFile("../../packages/testdata/kept-text-payload-vectors.json")
	if err != nil {
		t.Fatal(err)
	}
	var v textVector
	if err = json.Unmarshal(data, &v); err != nil {
		t.Fatal(err)
	}
	return v
}
func textVectorBytes(t *testing.T, s string) []byte {
	t.Helper()
	data, err := base64.RawURLEncoding.Strict().DecodeString(s)
	if err != nil {
		t.Fatal(err)
	}
	return data
}
func TestKeptTextPayloadVector(t *testing.T) {
	v := loadTextVector(t)
	input := textVectorBytes(t, v.Payload)
	value, err := DecodeKeptTextPayload(input, 4)
	if err != nil {
		t.Fatal(err)
	}
	encoded, err := EncodeKeptTextPayload(value)
	if err != nil || !bytes.Equal(encoded, input) {
		t.Fatalf("encode: %v", err)
	}
	host := ed25519.NewKeyFromSeed(bytes.Repeat([]byte{7}, 32))
	var hostKey, secret, epoch [32]byte
	copy(hostKey[:], host.Public().(ed25519.PublicKey))
	copy(secret[:], bytes.Repeat([]byte{3}, 32))
	copy(epoch[:], textVectorBytes(t, v.Epoch))
	keys, err := DeriveKeptRoomKeys(KeptLinkSecrets{Access: AccessEdit, Secret: secret, HostKey: hostKey}, v.RoomID)
	if err != nil {
		t.Fatal(err)
	}
	context := KeptCheckpointContext{RoomID: v.RoomID, Epoch: epoch, Generation: v.Generation, Cutoff: v.Cutoff}
	payload, err := OpenKeptCheckpoint(keys, context, textVectorBytes(t, v.Checkpoint))
	if err != nil || !bytes.Equal(payload, input) {
		t.Fatalf("checkpoint: %v", err)
	}
	main, metadata := crdt.New(), crdt.New()
	defer main.Destroy()
	defer metadata.Destroy()
	if err = crdt.ApplyUpdateV1(main, value.Documents[0], nil); err != nil {
		t.Fatal(err)
	}
	if err = crdt.ApplyUpdateV1(metadata, value.Documents[7], nil); err != nil {
		t.Fatal(err)
	}
	if err = crdt.ApplyUpdateV1(main, textVectorBytes(t, v.UpdateB), nil); err != nil {
		t.Fatal(err)
	}
	if err = crdt.ApplyUpdateV1(main, textVectorBytes(t, v.UpdateA), nil); err != nil {
		t.Fatal(err)
	}
	if main.GetText("content").ToString() != v.Merged {
		t.Fatal("concurrent edits did not merge")
	}
	entry, ok := metadata.GetMap("comments").Get("c1")
	if !ok {
		t.Fatal("comment missing")
	}
	thread, ok := entry.(*crdt.YMap)
	if !ok {
		t.Fatal("invalid comment map")
	}
	anchor, ok := thread.Get("anchor")
	if !ok {
		t.Fatal("anchor missing")
	}
	fields, ok := anchor.(map[string]any)
	if !ok {
		t.Fatal("invalid anchor")
	}
	var positions [2]int
	for i, key := range []string{"start", "end"} {
		raw, err := base64.StdEncoding.DecodeString(fields[key].(string))
		if err != nil {
			t.Fatal(err)
		}
		p, err := crdt.DecodeRelativePosition(raw)
		if err != nil {
			t.Fatal(err)
		}
		absolute, ok := crdt.ToAbsolutePosition(main, p)
		if !ok {
			t.Fatal("anchor did not resolve")
		}
		positions[i] = absolute.Index
	}
	if got := main.GetText("content").ToString()[positions[0]:positions[1]]; got != "hello" {
		t.Fatalf("anchor resolves to %q", got)
	}
	cipher, _ := NewCipher(keys.FrameKey)
	plain, err := cipher.Decrypt(textVectorBytes(t, v.Checkpoint))
	if err != nil {
		t.Fatal(err)
	}
	plain[keptCheckpointHeader] ^= 1
	if _, err := OpenKeptCheckpoint(keys, context, cipher.Encrypt(plain)); err == nil {
		t.Fatal("accepted modified checkpoint")
	}
}
func TestKeptTextPayloadRejectsUnsupported(t *testing.T) {
	v := loadTextVector(t)
	raw := textVectorBytes(t, v.Payload)
	p, err := DecodeKeptTextPayload(raw, 4)
	if err != nil {
		t.Fatal(err)
	}
	for _, state := range []KeptAttachmentInventory{KeptAttachmentsUnverified, KeptAttachmentsPresent} {
		p.Attachments = state
		if _, err := EncodeKeptTextPayload(p); err == nil {
			t.Fatal("accepted attachments or unverified inventory")
		}
	}
	p.Attachments = KeptAttachmentsNone
	validMain := p.Documents[0]
	for _, badState := range [][]byte{{255}, textVectorBytes(t, v.UpdateA)} {
		p.Documents[0] = badState
		if _, err := EncodeKeptTextPayload(p); err == nil {
			t.Fatal("accepted invalid or incomplete Yjs state")
		}
	}
	doc := crdt.New()
	text := doc.GetText("content")
	doc.Transact(func(txn *crdt.Transaction) { text.Insert(txn, 0, "assets/0123456789abcdef0123456789abcdef.png", nil) })
	p.Documents[0] = crdt.EncodeStateAsUpdateV1(doc, nil)
	doc.Destroy()
	if _, err := EncodeKeptTextPayload(p); err == nil {
		t.Fatal("accepted referenced attachment")
	}
	doc = crdt.New()
	text = doc.GetText("content")
	doc.Transact(func(txn *crdt.Transaction) {
		text.Insert(txn, 0, string(bytes.Repeat([]byte{'x'}, maxKeptCheckpointPayload)), nil)
	})
	p.Documents[0] = crdt.EncodeStateAsUpdateV1(doc, nil)
	doc.Destroy()
	if _, err := EncodeKeptTextPayload(p); err == nil {
		t.Fatal("accepted oversized state")
	}
	doc = crdt.New()
	child := crdt.New()
	root := doc.GetMap("other")
	doc.Transact(func(txn *crdt.Transaction) { root.Set(txn, "child", child) })
	p.Documents[0] = crdt.EncodeStateAsUpdateV1(doc, nil)
	if _, err := EncodeKeptTextPayload(p); err == nil {
		t.Fatal("accepted subdocument")
	}
	doc.Destroy()
	child.Destroy()
	p.Documents[0] = validMain
	p.Documents[8] = []byte{1}
	if _, err := EncodeKeptTextPayload(p); err == nil {
		t.Fatal("accepted unknown doc")
	}
	delete(p.Documents, 8)
	p.Manifest[0].Format = FormatCanvas
	if _, err := EncodeKeptTextPayload(p); err == nil {
		t.Fatal("accepted canvas")
	}
	p.Manifest[0].Format = FormatText
	p.Manifest[1].Path = "other.json"
	if _, err := EncodeKeptTextPayload(p); err == nil {
		t.Fatal("accepted unpaired metadata")
	}
	for _, bad := range [][]byte{raw[:len(raw)-1], append(bytes.Clone(raw), 0), bytes.Repeat([]byte{0}, maxKeptCheckpointPayload+1)} {
		if _, err := DecodeKeptTextPayload(bad, 4); err == nil {
			t.Fatal("accepted malformed payload")
		}
	}
	corrupt := bytes.Clone(raw)
	firstLength := len(textPayloadDomain) + 1
	mainOffset := firstLength + 4 + int(binary.BigEndian.Uint32(corrupt[firstLength:])) + 4
	corrupt[mainOffset] = 255
	if _, err := DecodeKeptTextPayload(corrupt, 4); err == nil {
		t.Fatal("decoded invalid Yjs state")
	}
	modified := bytes.Clone(raw)
	modified[len(textPayloadDomain)] = 1
	if _, err := DecodeKeptTextPayload(modified, 4); err == nil {
		t.Fatal("accepted unsupported attachment flag")
	}
}
