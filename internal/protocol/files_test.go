package protocol_test

import (
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"reflect"
	"testing"

	"github.com/piconic-ai/pedit/internal/protocol"
)

var manifest = []protocol.FileEntry{
	{ID: 0, Path: "agenda.md", Format: protocol.FormatText},
	{ID: 1, Path: "notes.md", Format: protocol.FormatText},
	{ID: 2, Path: "議事録/board.canvas", Format: protocol.FormatCanvas},
	{ID: 300, Path: "data.csv", Format: protocol.FormatText},
}

func TestManifestRoundTrips(t *testing.T) {
	for _, files := range [][]protocol.FileEntry{
		manifest, {}, {{ID: protocol.MaxFileID, Path: "a", Format: "future-format"}},
		// A leading BOM is part of the name, here and in packages/protocol.
		{{ID: 1, Path: "\ufeffagenda.md", Format: "text"}, {ID: 2, Path: "agenda.md", Format: "text"}},
	} {
		payload, err := protocol.EncodeManifest(files)
		if err != nil {
			t.Fatal(err)
		}
		m, err := protocol.DecodeFiles(payload)
		if err != nil {
			t.Fatal(err)
		}
		if m.Kind != protocol.FilesManifest || len(m.Files) != len(files) || (len(files) > 0 && !reflect.DeepEqual(m.Files, files)) {
			t.Fatalf("decoded %+v, want %+v", m, files)
		}
	}
}

func TestFileDocRoundTrips(t *testing.T) {
	for _, typ := range []protocol.MessageType{protocol.MessageSync, protocol.MessageAttachment, protocol.MessageCanvas} {
		payload, err := protocol.EncodeFileDoc(7, typ, []byte{1, 2, 3})
		if err != nil {
			t.Fatal(err)
		}
		m, err := protocol.DecodeFiles(payload)
		if err != nil {
			t.Fatal(err)
		}
		if m.Kind != protocol.FilesDoc || m.File != 7 || m.Type != typ || string(m.Payload) != "\x01\x02\x03" {
			t.Fatalf("decoded %+v", m)
		}
	}
}

func TestManifestRefusesWhatAPeerMustNotTrust(t *testing.T) {
	tooMany := make([]protocol.FileEntry, protocol.MaxFiles+1)
	for i := range tooMany {
		tooMany[i] = protocol.FileEntry{ID: uint64(i), Path: fmt.Sprintf("f%d.md", i), Format: "text"}
	}
	for name, files := range map[string][]protocol.FileEntry{
		"unsafe path":     {{ID: 1, Path: "../x.md", Format: "text"}},
		"absolute path":   {{ID: 1, Path: "/etc/passwd", Format: "text"}},
		"bidi in path":    {{ID: 1, Path: "a‮b.md", Format: "text"}},
		"id listed twice": {{ID: 1, Path: "a.md", Format: "text"}, {ID: 1, Path: "b.md", Format: "text"}},
		"path twice":      {{ID: 1, Path: "a.md", Format: "text"}, {ID: 2, Path: "a.md", Format: "text"}},
		"id too large":    {{ID: protocol.MaxFileID + 1, Path: "a.md", Format: "text"}},
		"no format":       {{ID: 1, Path: "a.md"}},
		"odd format":      {{ID: 1, Path: "a.md", Format: "Text/../x"}},
		"too many":        tooMany,
	} {
		if _, err := protocol.EncodeManifest(files); err == nil {
			t.Errorf("%s: encoded", name)
		}
		if _, err := protocol.DecodeFiles(rawManifest(files)); err == nil {
			t.Errorf("%s: decoded", name)
		}
	}
}

// rawManifest encodes files without checking them, as a hostile peer would.
func rawManifest(files []protocol.FileEntry) []byte {
	out := []byte{byte(protocol.FilesManifest)}
	out = appendUvarint(out, uint64(len(files)))
	for _, f := range files {
		out = appendUvarint(out, f.ID)
		out = appendUvarint(out, uint64(len(f.Path)))
		out = append(out, f.Path...)
		out = appendUvarint(out, uint64(len(f.Format)))
		out = append(out, f.Format...)
	}
	return out
}

func appendUvarint(b []byte, v uint64) []byte {
	for v >= 0x80 {
		b = append(b, byte(v)|0x80)
		v >>= 7
	}
	return append(b, byte(v))
}

func TestFileDocCarriesOnlySyncAttachmentsAndCanvas(t *testing.T) {
	// File 0 is the room's own doc, synced with plain messages.
	if _, err := protocol.EncodeFileDoc(0, protocol.MessageSync, nil); err == nil {
		t.Error("a doc message about file 0 encoded")
	}
	if _, err := protocol.DecodeFiles([]byte{byte(protocol.FilesDoc), 0, byte(protocol.MessageSync), 0}); err == nil {
		t.Error("a doc message about file 0 decoded")
	}
	for _, typ := range []protocol.MessageType{protocol.MessageAwareness, protocol.MessageFiles} {
		if _, err := protocol.EncodeFileDoc(1, typ, nil); err == nil {
			t.Errorf("type %d: encoded", typ)
		}
		if _, err := protocol.DecodeFiles(append([]byte{byte(protocol.FilesDoc), 1, byte(typ)}, 0)); err == nil {
			t.Errorf("type %d: decoded", typ)
		}
	}
	// A type from a newer peer is skipped, like at the top level.
	if _, err := protocol.DecodeFiles([]byte{byte(protocol.FilesDoc), 1, 9, 0}); !errors.Is(err, protocol.ErrUnknownMessageType) {
		t.Fatalf("unknown inner type: %v", err)
	}
}

func TestDecodeFilesRefusesMalformedPayloads(t *testing.T) {
	good, _ := protocol.EncodeManifest(manifest)
	for name, payload := range map[string][]byte{
		"empty":           {},
		"truncated":       good[:len(good)-1],
		"trailing":        append(append([]byte{}, good...), 0),
		"doc without id":  {byte(protocol.FilesDoc)},
		"doc without msg": {byte(protocol.FilesDoc), 1},
		"bad utf-8 path":  rawManifest([]protocol.FileEntry{{ID: 1, Path: "a\xff.md", Format: "text"}}),
	} {
		if _, err := protocol.DecodeFiles(payload); err == nil {
			t.Errorf("%s: decoded", name)
		}
	}
	if _, err := protocol.DecodeFiles([]byte{9}); !errors.Is(err, protocol.ErrUnknownFilesKind) {
		t.Fatalf("unknown kind: %v", err)
	}
}

// filesVectors pins the encoding so packages/protocol (test/files.test.ts)
// can check it reads and writes the same bytes.
// Regenerate with PEDIT_UPDATE_VECTORS=1 go test ./internal/protocol/.
const filesVectorsFile = "../../packages/testdata/files-vectors.json"

type filesVectors struct {
	Manifest struct {
		Files   []fileVector `json:"files"`
		Payload string       `json:"payload"` // hex
	} `json:"manifest"`
	Docs []struct {
		File    uint64 `json:"file"`
		Type    byte   `json:"type"`
		Inner   string `json:"inner"`   // hex
		Payload string `json:"payload"` // hex
	} `json:"docs"`
}

type fileVector struct {
	ID     uint64 `json:"id"`
	Path   string `json:"path"`
	Format string `json:"format"`
}

func TestFilesVectors(t *testing.T) {
	if os.Getenv("PEDIT_UPDATE_VECTORS") != "" {
		writeFilesVectors(t)
	}
	data, err := os.ReadFile(filesVectorsFile)
	if err != nil {
		t.Fatal(err)
	}
	var v filesVectors
	if err := json.Unmarshal(data, &v); err != nil {
		t.Fatal(err)
	}
	var files []protocol.FileEntry
	for _, f := range v.Manifest.Files {
		files = append(files, protocol.FileEntry{ID: f.ID, Path: f.Path, Format: f.Format})
	}
	got, err := protocol.EncodeManifest(files)
	if err != nil || hex.EncodeToString(got) != v.Manifest.Payload {
		t.Fatalf("manifest = %x, %v; vectors say %s", got, err, v.Manifest.Payload)
	}
	if len(v.Docs) == 0 {
		t.Fatal("no doc vectors")
	}
	for _, d := range v.Docs {
		inner, _ := hex.DecodeString(d.Inner)
		got, err := protocol.EncodeFileDoc(d.File, protocol.MessageType(d.Type), inner)
		if err != nil || hex.EncodeToString(got) != d.Payload {
			t.Fatalf("doc = %x, %v; vectors say %s", got, err, d.Payload)
		}
	}
}

func writeFilesVectors(t *testing.T) {
	var v filesVectors
	for _, f := range manifest {
		v.Manifest.Files = append(v.Manifest.Files, fileVector{ID: f.ID, Path: f.Path, Format: f.Format})
	}
	payload, err := protocol.EncodeManifest(manifest)
	if err != nil {
		t.Fatal(err)
	}
	v.Manifest.Payload = hex.EncodeToString(payload)
	for _, d := range []struct {
		file  uint64
		typ   protocol.MessageType
		inner []byte
	}{
		{1, protocol.MessageSync, []byte{0, 1, 0}},
		{300, protocol.MessageAttachment, []byte{1, 0}},
		{protocol.MaxFileID, protocol.MessageCanvas, []byte{1, 2, 'i', 'd'}},
	} {
		payload, err := protocol.EncodeFileDoc(d.file, d.typ, d.inner)
		if err != nil {
			t.Fatal(err)
		}
		v.Docs = append(v.Docs, struct {
			File    uint64 `json:"file"`
			Type    byte   `json:"type"`
			Inner   string `json:"inner"`
			Payload string `json:"payload"`
		}{d.file, byte(d.typ), hex.EncodeToString(d.inner), hex.EncodeToString(payload)})
	}
	data, err := json.MarshalIndent(v, "", "  ")
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filesVectorsFile, append(data, '\n'), 0o644); err != nil {
		t.Fatal(err)
	}
}

func TestDecodeMessageKnowsTheFilesType(t *testing.T) {
	typ, _, err := protocol.DecodeMessage(protocol.EncodeMessage(protocol.MessageFiles, nil))
	if err != nil || typ != protocol.MessageFiles {
		t.Fatalf("type %d, %v", typ, err)
	}
	// CONTRIBUTING.md lists it as type 4, as packages/protocol does.
	if protocol.MessageFiles != 4 {
		t.Fatalf("MessageFiles = %d", protocol.MessageFiles)
	}
}
