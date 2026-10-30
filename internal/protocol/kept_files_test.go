package protocol

import (
	"bytes"
	"strconv"
	"testing"

	"github.com/reearth/ygo/crdt"
)

func TestKeptBundlePairsMetaDocsAndCapsTextFilesOnly(t *testing.T) {
	link, _ := ParseFragment(GenerateEditSecret())
	keys, _ := DeriveRoomKeys(link, "abcdefghijklmnopqrstuv")
	files := make([]KeptFileSnapshot, 0, 128)
	for i := range 64 {
		files = append(files, KeptFileSnapshot{ID: uint32(i), Path: strconv.Itoa(i) + ".md", Update: []byte{0, 0}})
	}
	for i := range 64 {
		files = append(files, KeptFileSnapshot{ID: uint32(1024 + i), Path: MetaPath(strconv.Itoa(i) + ".md"), Update: []byte{0, 0}})
	}
	frame, err := SealKeptBundle(keys, files)
	if err != nil {
		t.Fatal("64 text files with 64 meta docs rejected:", err)
	}
	got, err := OpenKeptBundle(keys, frame)
	if err != nil || len(got) != 128 || got[127].Path != MetaPath("63.md") {
		t.Fatalf("bundle with meta docs: %d %v", len(got), err)
	}
	files = append(files[:64:64], KeptFileSnapshot{ID: 64, Path: "extra.md", Update: []byte{0, 0}})
	files = append(files, KeptFileSnapshot{ID: 2000, Path: MetaPath("0.md"), Update: []byte{0, 0}})
	if _, err := SealKeptBundle(keys, files); err == nil {
		t.Fatal("65 text files accepted")
	}
}

func TestValidateKeptDocUpdateNamesTheRoot(t *testing.T) {
	doc := crdt.New()
	doc.Transact(func(tx *crdt.Transaction) { doc.GetMap("comments").Set(tx, "t1", "x") })
	update := crdt.EncodeStateAsUpdateV1(doc, nil)
	if err := ValidateKeptDocUpdate(update, KeptCommentsRoot); err != nil {
		t.Fatal("comments root refused:", err)
	}
	if err := ValidateKeptTextUpdate(update); err == nil {
		t.Fatal("comments root accepted as a text file")
	}
}

func TestKeptFilesCodec(t *testing.T) {
	link, _ := ParseFragment(GenerateEditSecret())
	keys, _ := DeriveRoomKeys(link, "abcdefghijklmnopqrstuv")
	files := []KeptFileSnapshot{{ID: 0, Path: "notes.md", Update: []byte{0, 0}}, {ID: 7, Path: "docs/日本語.md", Update: []byte{0, 0}}}
	frame, err := SealKeptBundle(keys, files)
	if err != nil {
		t.Fatal(err)
	}
	got, err := OpenKeptBundle(keys, frame)
	if err != nil || len(got) != 2 || got[1].ID != 7 || got[1].Path != files[1].Path || !bytes.Equal(got[1].Update, files[1].Update) {
		t.Fatalf("bundle: %+v %v", got, err)
	}
	if _, _, err := OpenKeptFileUpdate(keys, frame); err == nil {
		t.Fatal("snapshot accepted as update")
	}
	update, err := SealKeptFileUpdate(keys, 7, []byte{0, 0})
	if err != nil {
		t.Fatal(err)
	}
	id, raw, err := OpenKeptFileUpdate(keys, update)
	if err != nil || id != 7 || !bytes.Equal(raw, []byte{0, 0}) {
		t.Fatal("update mismatch")
	}
	if _, err := OpenKeptBundle(keys, update); err == nil {
		t.Fatal("file update accepted as bundle")
	}
	for _, bad := range [][]KeptFileSnapshot{nil, {files[1]}, {files[0], files[0]}, {{ID: 0, Path: "../escape", Update: []byte{0, 0}}}, {{ID: 0, Path: "ok", Update: make([]byte, MaxFrameBytes)}}} {
		if _, err := SealKeptBundle(keys, bad); err == nil {
			t.Fatal("invalid bundle accepted")
		}
	}
	legacy, _ := SealKeptTextSnapshot(keys, "old.md", []byte{0, 0})
	got, err = OpenKeptBundle(keys, legacy)
	if err != nil || len(got) != 1 || got[0].ID != 0 || got[0].Path != "old.md" {
		t.Fatal("legacy snapshot rejected")
	}
	oldUpdate, _ := SealKeptText(keys, []byte{0, 0})
	id, raw, err = OpenKeptFileUpdate(keys, oldUpdate)
	if err != nil || id != 0 || !bytes.Equal(raw, []byte{0, 0}) {
		t.Fatal("legacy update rejected")
	}
}

func TestKeptBundleMalformedAndBoundary(t *testing.T) {
	link, _ := ParseFragment(GenerateEditSecret())
	keys, _ := DeriveRoomKeys(link, "abcdefghijklmnopqrstuv")
	files := make([]KeptFileSnapshot, 64)
	for i := range files {
		files[i] = KeptFileSnapshot{ID: uint32(i), Path: strconv.Itoa(i) + ".md", Update: []byte{0, 0}}
	}
	if _, err := SealKeptBundle(keys, files); err != nil {
		t.Fatal("64 files rejected", err)
	}
	files = append(files, KeptFileSnapshot{ID: 64, Path: "last.md", Update: []byte{0, 0}})
	if _, err := SealKeptBundle(keys, files); err == nil {
		t.Fatal("65 files accepted")
	}
	frame, _ := SealKeptBundle(keys, files[:2])
	payload, _ := openKeptPayload(keys, keptFilesDomain, frame)
	for n := 1; n < len(payload); n++ {
		malformed, _ := sealKeptPayload(keys, keptFilesDomain, payload[:n])
		if _, err := OpenKeptBundle(keys, malformed); err == nil {
			t.Fatalf("truncated bundle accepted at%d", n)
		}
	}
	trailing, _ := sealKeptPayload(keys, keptFilesDomain, append(payload, 0))
	if _, err := OpenKeptBundle(keys, trailing); err == nil {
		t.Fatal("trailing bytes accepted")
	}
	files[1].Path = files[0].Path
	if _, err := SealKeptBundle(keys, files[:2]); err == nil {
		t.Fatal("duplicate path accepted")
	}
}
