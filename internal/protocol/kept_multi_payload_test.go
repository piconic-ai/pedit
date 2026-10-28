package protocol

import (
	"bytes"
	"encoding/json"
	"os"
	"testing"

	"github.com/reearth/ygo/crdt"
)

func multiFixture(t *testing.T) KeptMultiPayload {
	t.Helper()
	v := loadTextVector(t)
	single, err := DecodeKeptTextPayload(textVectorBytes(t, v.Payload), 4)
	if err != nil {
		t.Fatal(err)
	}
	doc := crdt.New()
	defer doc.Destroy()
	text := doc.GetText("content")
	doc.Transact(func(tx *crdt.Transaction) {
		text.Insert(tx, 0, "image assets/0123456789abcdef0123456789abcdef.png", nil)
	})
	return KeptMultiPayload{
		Manifest:    []FileEntry{{ID: 0, Path: "draft.md", Format: FormatText}, {ID: 7, Path: MetaPath("draft.md"), Format: FormatMeta}, {ID: 8, Path: "second.md", Format: FormatText}, {ID: 9, Path: MetaPath("second.md"), Format: FormatMeta}},
		Documents:   map[uint64][]byte{0: single.Documents[0], 7: single.Documents[7], 8: crdt.EncodeStateAsUpdateV1(doc, nil), 9: single.Documents[7]},
		Attachments: []string{"assets/0123456789abcdef0123456789abcdef.png"}, Ledger: single.Ledger,
	}
}

func TestKeptMultiPayloadInterop(t *testing.T) {
	value := multiFixture(t)
	_, err := EncodeKeptMultiPayload(value)
	if err != nil {
		t.Fatal(err)
	}

	data, err := os.ReadFile("../../packages/testdata/kept-multi-payload-vectors.json")
	if err != nil {
		t.Fatal(err)
	}
	var vector struct{ Payload string }
	if err = json.Unmarshal(data, &vector); err != nil {
		t.Fatal(err)
	}
	fixture := textVectorBytes(t, vector.Payload)
	decoded, err := DecodeKeptMultiPayload(fixture, 4)
	if err != nil {
		t.Fatal(err)
	}
	again, err := EncodeKeptMultiPayload(decoded)
	if err != nil || !bytes.Equal(again, fixture) {
		t.Fatalf("round trip: %v", err)
	}
	if len(decoded.Manifest) != 4 || len(decoded.Documents) != 4 || len(decoded.Attachments) != 1 {
		t.Fatal("missing states or attachments")
	}
}

func TestKeptMultiPayloadTypeScriptVector(t *testing.T) {
	data, err := os.ReadFile("../../packages/testdata/kept-multi-payload-ts-vectors.json")
	if err != nil {
		t.Fatal(err)
	}
	var vector struct{ Payload string }
	if err := json.Unmarshal(data, &vector); err != nil {
		t.Fatal(err)
	}
	wire := textVectorBytes(t, vector.Payload)
	value, err := DecodeKeptMultiPayload(wire, 4)
	if err != nil {
		t.Fatal(err)
	}
	doc := crdt.New()
	defer doc.Destroy()
	if err := crdt.ApplyUpdateV1(doc, value.Documents[8], nil); err != nil {
		t.Fatal(err)
	}
	if doc.GetText("content").ToString() != "typescript assets/0123456789abcdef0123456789abcdef.png" {
		t.Fatal("text mismatch")
	}
	meta := crdt.New()
	defer meta.Destroy()
	if err := crdt.ApplyUpdateV1(meta, value.Documents[9], nil); err != nil {
		t.Fatal(err)
	}
	comment, ok := meta.GetMap("comments").Get("separate")
	if !ok || comment != "second file comment" {
		t.Fatal("second file metadata mismatch")
	}
	encoded, err := EncodeKeptMultiPayload(value)
	if err != nil || !bytes.Equal(encoded, wire) {
		t.Fatalf("round trip: %v", err)
	}
}

func TestKeptMultiPayloadRejectsIncompleteAndUnsupported(t *testing.T) {
	value := multiFixture(t)
	value.Attachments = []string{}
	if _, err := EncodeKeptMultiPayload(value); err == nil {
		t.Fatal("missing referenced attachment")
	}
	value.Attachments = nil
	if _, err := EncodeKeptMultiPayload(value); err == nil {
		t.Fatal("unverified attachment inventory")
	}
	value = multiFixture(t)
	value.Manifest[2].Format = FormatCanvas
	if _, err := EncodeKeptMultiPayload(value); err == nil {
		t.Fatal("canvas accepted")
	}
	value = multiFixture(t)
	delete(value.Documents, 9)
	if _, err := EncodeKeptMultiPayload(value); err == nil {
		t.Fatal("missing metadata accepted")
	}
	value = multiFixture(t)
	value.Attachments = append(value.Attachments, value.Attachments[0])
	if _, err := EncodeKeptMultiPayload(value); err == nil {
		t.Fatal("duplicate inventory accepted")
	}
}
