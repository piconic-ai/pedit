package protocol_test

import (
	"crypto/ed25519"
	"encoding/base64"
	"encoding/json"
	"errors"
	"os"
	"slices"
	"strings"
	"testing"

	"github.com/piconic-ai/pedit/internal/meta"
	"github.com/piconic-ai/pedit/internal/protocol"
	"github.com/reearth/ygo/crdt"
)

// keptCommentVectors pins the comment-signed entry of docs/design/kept-comments.md:
// the signed message and its Ed25519 signature (deterministic), beside the same
// payload under the edit file-update domain. packages/protocol/test/kept-comments.test.ts
// checks the TypeScript side signs and opens the same bytes.
// Regenerate with PEDIT_UPDATE_VECTORS=1 go test ./internal/protocol/.
const keptCommentVectorsFile = "../../packages/testdata/kept-comment-vectors.json"

type keptCommentVectors struct {
	RoomID  string `json:"roomId"`
	Edit    string `json:"edit"`
	Comment string `json:"comment"`
	Read    string `json:"read"`
	FileID  uint32 `json:"fileId"`
	Update  string `json:"update"`
	// Message and Signature are the comment-domain message and the commenters' signature over it.
	Message   string `json:"message"`
	Signature string `json:"signature"`
	// EditMessage and EditSignature are the same payload under the edit file-update domain, signed by the editors.
	EditMessage   string `json:"editMessage"`
	EditSignature string `json:"editSignature"`
}

func makeKeptCommentVectors(t *testing.T) keptCommentVectors {
	t.Helper()
	k := roomKeys(t, vectorKey(), vectorRoomID)
	update := []byte{1, 2, 3, 4}
	payload := append([]byte{0, 0, 4, 1}, update...) // file id 1025, then the update
	message := append([]byte("pedit kept comment update v1\x00"), payload...)
	editMessage := append([]byte("pedit kept file update v1\x00"), payload...)
	return keptCommentVectors{
		RoomID:        vectorRoomID,
		Edit:          k.Fragments[protocol.AccessEdit],
		Comment:       k.Fragments[protocol.AccessComment],
		Read:          k.Fragments[protocol.AccessRead],
		FileID:        1025,
		Update:        b64(update),
		Message:       b64(message),
		Signature:     b64(ed25519.Sign(k.CommentSigner, message)),
		EditMessage:   b64(editMessage),
		EditSignature: b64(ed25519.Sign(k.Signer, editMessage)),
	}
}

func TestKeptCommentVectors(t *testing.T) {
	want := makeKeptCommentVectors(t)
	if os.Getenv("PEDIT_UPDATE_VECTORS") != "" {
		data, err := json.MarshalIndent(want, "", "  ")
		if err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(keptCommentVectorsFile, append(data, '\n'), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	data, err := os.ReadFile(keptCommentVectorsFile)
	if err != nil {
		t.Fatal(err)
	}
	var got keptCommentVectors
	if err := json.Unmarshal(data, &got); err != nil {
		t.Fatal(err)
	}
	if got != want {
		t.Fatalf("kept-comment-vectors.json is stale:\n got %+v\nwant %+v", got, want)
	}
	// Both links seal exactly the pinned message and signature.
	message, _ := base64.RawURLEncoding.DecodeString(got.Message)
	signature, _ := base64.RawURLEncoding.DecodeString(got.Signature)
	for _, fragment := range []string{got.Edit, got.Comment} {
		k := roomKeys(t, fragment, got.RoomID)
		frame, err := protocol.SealKeptCommentUpdate(k, got.FileID, []byte{1, 2, 3, 4})
		if err != nil {
			t.Fatal(err)
		}
		c, _ := protocol.NewCipher(k.FrameKey)
		plain, err := c.Decrypt(frame)
		if err != nil || !slices.Equal(plain, append(message, signature...)) {
			t.Fatalf("sealed bytes differ from the vector: %v", err)
		}
	}
}

// forge signs domain || payload with signer, as a holder of that key could.
func forge(k *protocol.RoomKeys, signer ed25519.PrivateKey, domain string, payload []byte) []byte {
	body := append([]byte(domain), payload...)
	c, _ := protocol.NewCipher(k.FrameKey)
	return c.Encrypt(append(body, ed25519.Sign(signer, body)...))
}

func commentsUpdate() []byte {
	doc := crdt.New()
	comments := doc.GetMap("comments")
	doc.Transact(func(tx *crdt.Transaction) { comments.Set(tx, "t1", "x") })
	return crdt.EncodeStateAsUpdateV1(doc, nil)
}

func TestKeptCommentEntryRoundTrip(t *testing.T) {
	v := makeKeptCommentVectors(t)
	update := commentsUpdate()
	for name, fragment := range map[string]string{"edit": v.Edit, "comment": v.Comment} {
		frame, err := protocol.SealKeptCommentUpdate(roomKeys(t, fragment, v.RoomID), 7, update)
		if err != nil {
			t.Fatalf("%s link: %v", name, err)
		}
		// Any link of the room opens it, whatever its access.
		for _, f := range []string{v.Edit, v.Comment, v.Read} {
			tier, id, got, err := protocol.OpenKeptEntry(roomKeys(t, f, v.RoomID), frame)
			if err != nil || tier != protocol.AccessComment || id != 7 || !slices.Equal(got, update) {
				t.Fatalf("%s entry: %v %d %v", name, tier, id, err)
			}
		}
	}
	if _, err := protocol.SealKeptCommentUpdate(roomKeys(t, v.Read, v.RoomID), 7, update); err == nil {
		t.Fatal("a read link sealed a comment entry")
	}
}

func TestKeptEditEntryKeepsItsTier(t *testing.T) {
	v := makeKeptCommentVectors(t)
	k := roomKeys(t, v.Edit, v.RoomID)
	frame, err := protocol.SealKeptFileUpdate(k, 3, []byte{9, 9})
	if err != nil {
		t.Fatal(err)
	}
	tier, id, got, err := protocol.OpenKeptEntry(roomKeys(t, v.Read, v.RoomID), frame)
	if err != nil || tier != protocol.AccessEdit || id != 3 || !slices.Equal(got, []byte{9, 9}) {
		t.Fatalf("edit entry: %v %d %v", tier, id, err)
	}
	comment, err := protocol.SealKeptCommentUpdate(k, 1, []byte{1})
	if err != nil {
		t.Fatal(err)
	}
	if _, _, err := protocol.OpenKeptFileUpdate(k, comment); err == nil {
		t.Fatal("a comment entry opened as an edit file update")
	}
}

// A signature of one tier never passes in the other tier's domain.
func TestKeptCommentDomainsDoNotCross(t *testing.T) {
	v := makeKeptCommentVectors(t)
	k := roomKeys(t, v.Edit, v.RoomID)
	payload := []byte{0, 0, 0, 1, 1}
	for name, frame := range map[string][]byte{
		"edit key, comment domain": forge(k, k.Signer, "pedit kept comment update v1\x00", payload),
		"comment key, edit domain": forge(k, k.CommentSigner, "pedit kept file update v1\x00", payload),
	} {
		if _, _, _, err := protocol.OpenKeptEntry(k, frame); err == nil {
			t.Fatalf("%s opened", name)
		}
	}
}

func TestCheckKeptCommentEntry(t *testing.T) {
	files := []protocol.FileEntry{
		{ID: 0, Path: "a.md", Format: protocol.FormatText},
		{ID: 1, Path: protocol.MetaPath("a.md"), Format: protocol.FormatMeta},
		{ID: 2, Path: "c.canvas", Format: protocol.FormatCanvas},
		{ID: 3, Path: protocol.MetaPath("gone.md"), Format: protocol.FormatMeta},
	}
	update := commentsUpdate()
	check := func(u []byte) error { return meta.CheckUpdate(crdt.New(), u) }
	if err := protocol.CheckKeptCommentEntry(files, 1, update, check); err != nil {
		t.Fatal("paired comments doc refused:", err)
	}
	for name, id := range map[string]uint32{"text file": 0, "canvas file": 2, "meta without a file": 3, "unknown id": 99} {
		if protocol.CheckKeptCommentEntry(files, id, update, check) == nil {
			t.Fatalf("%s accepted", name)
		}
	}
	if protocol.CheckKeptCommentEntry(nil, 1, update, check) == nil {
		t.Fatal("accepted without a manifest")
	}
	if protocol.CheckKeptCommentEntry(files, 1, update, func([]byte) error { return errors.New("refused") }) == nil {
		t.Fatal("a failing comment check accepted")
	}
	// A real failure: an update holding text, not comments.
	doc := crdt.New()
	text := doc.GetText("content")
	doc.Transact(func(tx *crdt.Transaction) { text.Insert(tx, 0, "x", nil) })
	if protocol.CheckKeptCommentEntry(files, 1, crdt.EncodeStateAsUpdateV1(doc, nil), check) == nil {
		t.Fatal("a text update accepted as comments")
	}
}

func TestOfferProtocolsAndAcceptedVersion(t *testing.T) {
	token, comment := strings.Repeat("A", 43), strings.Repeat("B", 43)
	if got := protocol.OfferProtocols(token, ""); !slices.Equal(got, []string{"pedit-v8", "pedit-v7", "pedit-admission." + token}) {
		t.Fatalf("offer: %v", got)
	}
	if got := protocol.OfferProtocols(token, comment); !slices.Equal(got, []string{"pedit-v8", "pedit-v7", "pedit-admission." + token, "pedit-comment-admission." + comment}) {
		t.Fatalf("offer with comment: %v", got)
	}
	for sub, want := range map[string]int{"pedit-v8": 8, "pedit-v7": 7, "pedit-v10": 10, "pedit-v": 0, "pedit-v08": 0, "pedit-vx": 0, "": 0, "pedit-admission.x": 0} {
		if got := protocol.AcceptedVersion(sub); got != want {
			t.Fatalf("AcceptedVersion(%q) = %d, want %d", sub, got, want)
		}
	}
}
