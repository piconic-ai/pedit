package protocol_test

import (
	"bytes"
	"crypto/ed25519"
	"crypto/hkdf"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"os"
	"strings"
	"testing"

	"github.com/piconic-ai/pedit/internal/protocol"
)

// accessVectors pins the key chain of room links so the TypeScript side
// (packages/protocol/test/access.test.ts) can check it derives the same.
// Regenerate with PEDIT_UPDATE_VECTORS=1 go test ./internal/protocol/.
const accessVectorsFile = "../../packages/testdata/access-vectors.json"

type accessVectors struct {
	RoomID        string `json:"roomId"`
	Edit          string `json:"edit"`
	Comment       string `json:"comment"`
	Read          string `json:"read"`
	EditKey       string `json:"editKey"`
	CommentKey    string `json:"commentKey"`
	FrameKey      string `json:"frameKey"`
	EditAdmission string `json:"editAdmission"`
	ReadAdmission string `json:"readAdmission"`
	// V1Admission is the admission token protocol versions 1 to 4 derived
	// from the same 32 bytes, which no value of the chain may equal.
	V1Admission string `json:"v1Admission"`
}

const vectorRoomID = "AAECAwQFBgcICQoLDA0ODw"

var b64 = base64.RawURLEncoding.EncodeToString

func roomKeys(t *testing.T, fragment, roomID string) *protocol.RoomKeys {
	t.Helper()
	link, err := protocol.ParseFragment(fragment)
	if err != nil {
		t.Fatal(err)
	}
	keys, err := protocol.DeriveRoomKeys(link, roomID)
	if err != nil {
		t.Fatal(err)
	}
	return keys
}

func makeAccessVectors(t *testing.T) accessVectors {
	t.Helper()
	edit := vectorKey()
	k := roomKeys(t, edit, vectorRoomID)
	raw, _ := protocol.DecodeKey(edit)
	v1, err := hkdf.Key(sha256.New, raw, nil, "pedit admission v1", protocol.KeyBytes)
	if err != nil {
		t.Fatal(err)
	}
	return accessVectors{
		RoomID:        vectorRoomID,
		Edit:          k.Fragments[protocol.AccessEdit],
		Comment:       k.Fragments[protocol.AccessComment],
		Read:          k.Fragments[protocol.AccessRead],
		EditKey:       b64(k.EditKey),
		CommentKey:    b64(k.CommentKey),
		FrameKey:      b64(k.FrameKey),
		EditAdmission: k.EditAdmission,
		ReadAdmission: k.ReadAdmission,
		V1Admission:   b64(v1),
	}
}

func TestAccessVectors(t *testing.T) {
	want := makeAccessVectors(t)
	if os.Getenv("PEDIT_UPDATE_VECTORS") != "" {
		data, err := json.MarshalIndent(want, "", "  ")
		if err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(accessVectorsFile, append(data, '\n'), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	data, err := os.ReadFile(accessVectorsFile)
	if err != nil {
		t.Fatal(err)
	}
	var got accessVectors
	if err := json.Unmarshal(data, &got); err != nil {
		t.Fatal(err)
	}
	if got != want {
		t.Fatalf("access-vectors.json is stale:\n got %+v\nwant %+v", got, want)
	}
}

// Every link derives the same room, and only what its access allows.
func TestLinksDeriveTheSameRoom(t *testing.T) {
	v := makeAccessVectors(t)
	cases := []struct {
		fragment  string
		access    protocol.Access
		fragments []protocol.Access
	}{
		{v.Edit, protocol.AccessEdit, []protocol.Access{protocol.AccessEdit, protocol.AccessComment, protocol.AccessRead}},
		{v.Comment, protocol.AccessComment, []protocol.Access{protocol.AccessComment, protocol.AccessRead}},
		{v.Read, protocol.AccessRead, []protocol.Access{protocol.AccessRead}},
	}
	for _, c := range cases {
		k := roomKeys(t, c.fragment, v.RoomID)
		if k.Access != c.access || b64(k.FrameKey) != v.FrameKey || k.ReadAdmission != v.ReadAdmission ||
			b64(k.EditKey) != v.EditKey || b64(k.CommentKey) != v.CommentKey {
			t.Fatalf("%s link derives another room", c.access)
		}
		if len(k.Fragments) != len(c.fragments) {
			t.Fatalf("%s link hands out %v", c.access, k.Fragments)
		}
		for _, a := range c.fragments {
			if k.Fragments[a] != map[protocol.Access]string{
				protocol.AccessEdit: v.Edit, protocol.AccessComment: v.Comment, protocol.AccessRead: v.Read,
			}[a] {
				t.Fatalf("%s link hands out another %s link", c.access, a)
			}
		}
		if (k.EditAdmission != "") != (c.access == protocol.AccessEdit) {
			t.Fatalf("%s link has the editor admission: %q", c.access, k.EditAdmission)
		}
	}
	signers := map[protocol.Access]ed25519.PublicKey{}
	for _, c := range cases {
		if s := roomKeys(t, c.fragment, v.RoomID).Signer; s != nil {
			signers[c.access] = s.Public().(ed25519.PublicKey)
		}
	}
	if b64(signers[protocol.AccessEdit]) != v.EditKey || b64(signers[protocol.AccessComment]) != v.CommentKey ||
		signers[protocol.AccessRead] != nil {
		t.Fatal("links sign with the wrong keys")
	}
}

// A link that carries a verifying key of someone else's choosing, or is used
// in another room, decrypts nothing.
func TestSubstitutedKeysGiveAnotherFrameKey(t *testing.T) {
	v := makeAccessVectors(t)
	read, _ := protocol.ParseFragment(v.Read)
	comment, _ := protocol.ParseFragment(v.Comment)
	other := ed25519.NewKeyFromSeed(bytes.Repeat([]byte{7}, 32)).Public().(ed25519.PublicKey)
	variants := []struct {
		name string
		link protocol.LinkSecrets
		room string
	}{
		{"read link, other editor key", withKeys(read, other, read.CommentKey), v.RoomID},
		{"read link, other commenter key", withKeys(read, read.EditKey, other), v.RoomID},
		{"comment link, other editor key", withKeys(comment, other, nil), v.RoomID},
		{"another room", read, "AQECAwQFBgcICQoLDA0ODw"},
	}
	for _, c := range variants {
		k, err := protocol.DeriveRoomKeys(c.link, c.room)
		if err != nil {
			t.Fatal(err)
		}
		if b64(k.FrameKey) == v.FrameKey || k.ReadAdmission == v.ReadAdmission {
			t.Fatalf("%s: same frame key", c.name)
		}
	}
}

func withKeys(l protocol.LinkSecrets, edit, comment ed25519.PublicKey) protocol.LinkSecrets {
	l.EditKey = edit
	if comment != nil {
		l.CommentKey = comment
	}
	return l
}

// No value of the chain is the admission token of versions 1 to 4 or the
// secret itself, so a client that takes an edit link for a room key reads
// and writes nothing.
func TestChainIsSeparateFromVersion1(t *testing.T) {
	v := makeAccessVectors(t)
	values := []string{v.Comment, v.Read, v.EditKey, v.CommentKey, v.FrameKey, v.EditAdmission, v.ReadAdmission}
	for _, value := range values {
		if strings.Contains(value, v.V1Admission) || strings.Contains(value, v.Edit) {
			t.Fatalf("%q repeats a version 1 value", value)
		}
	}
}

func TestParseFragmentRefusesOtherText(t *testing.T) {
	v := makeAccessVectors(t)
	for _, f := range []string{
		"", v.Edit[1:], v.Edit + "A", "c." + v.Edit, v.Comment[:len(v.Comment)-1], "x." + v.Comment[2:],
		"r." + v.Comment[2:], v.Read + "A", strings.Replace(v.Edit, v.Edit[:1], "+", 1),
	} {
		if _, err := protocol.ParseFragment(f); err == nil {
			t.Fatalf("parsed %q", f)
		}
	}
	if _, err := protocol.DeriveRoomKeys(protocol.LinkSecrets{Access: protocol.AccessComment}, v.RoomID); err == nil {
		t.Fatal("derived keys from an empty link")
	}
}
