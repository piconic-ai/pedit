package protocol

import (
	"bytes"
	"crypto/ed25519"
	"encoding/base64"
	"encoding/json"
	"os"
	"slices"
	"testing"
)

func TestKeptAccessVectors(t *testing.T) {
	data, err := os.ReadFile("../../packages/testdata/kept-access-vectors.json")
	if err != nil {
		t.Fatal(err)
	}
	var v struct {
		RoomID, HostKey, Edit, Comment, Read, EditKey, CommentKey, FrameKey, EditAdmission, CommentAdmission, ReadAdmission, HostSignature string
		InvalidPublicKeys                                                                                                                  []struct{ Name, Key string }
	}
	if err := json.Unmarshal(data, &v); err != nil {
		t.Fatal(err)
	}
	link, err := ParseKeptFragment(v.Edit)
	if err != nil {
		t.Fatal(err)
	}
	keys, err := DeriveKeptRoomKeys(link, v.RoomID)
	if err != nil {
		t.Fatal(err)
	}
	enc := base64.RawURLEncoding.EncodeToString
	got := []string{keys.Fragments[AccessEdit], keys.Fragments[AccessComment], keys.Fragments[AccessRead], enc(keys.HostKey), enc(keys.EditKey), enc(keys.CommentKey), enc(keys.FrameKey), keys.EditAdmission, keys.CommentAdmission, keys.ReadAdmission}
	want := []string{v.Edit, v.Comment, v.Read, v.HostKey, v.EditKey, v.CommentKey, v.FrameKey, v.EditAdmission, v.CommentAdmission, v.ReadAdmission}
	if !slices.Equal(got, want) {
		t.Fatalf("kept access vector mismatch: got %v, want %v", got, want)
	}
	signature, err := base64.RawURLEncoding.Strict().DecodeString(v.HostSignature)
	if err != nil || !ed25519.Verify(keys.HostKey, []byte("kept checkpoint vector"), signature) || ed25519.Verify(keys.HostKey, []byte("another message"), signature) {
		t.Fatal("invalid host signature vector")
	}
	if _, err := ParseFragment(v.Edit); err == nil {
		t.Fatal("v5 parser accepted a v6 fragment")
	}
	if _, err := ParseKeptFragment(v.Edit + "\n"); err == nil {
		t.Fatal("accepted a fragment with a trailing newline")
	}
	for _, invalidKey := range v.InvalidPublicKeys {
		invalid, err := base64.RawURLEncoding.Strict().DecodeString(invalidKey.Key)
		if err != nil {
			t.Fatal(err)
		}
		for _, offset := range []int{32, 64, 96} {
			raw, err := base64.RawURLEncoding.Strict().DecodeString(v.Read[5:])
			if err != nil {
				t.Fatal(err)
			}
			copy(raw[offset:offset+32], invalid)
			if _, err := ParseKeptFragment("v6.r." + enc(raw)); err == nil {
				t.Errorf("accepted %s public key at offset %d", invalidKey.Name, offset)
			}
			bad, err := ParseKeptFragment(v.Read)
			if err != nil {
				t.Fatal(err)
			}
			switch offset {
			case 32:
				copy(bad.EditKey[:], invalid)
			case 64:
				copy(bad.CommentKey[:], invalid)
			case 96:
				copy(bad.HostKey[:], invalid)
			}
			if _, err := DeriveKeptRoomKeys(bad, v.RoomID); err == nil {
				t.Errorf("derived with %s public key at offset %d", invalidKey.Name, offset)
			}
		}
	}
}

func TestKeptLinksPreserveHostKeyAndAccess(t *testing.T) {
	seed := bytes.Repeat([]byte{7}, ed25519.SeedSize)
	host := ed25519.NewKeyFromSeed(seed)
	var secret, hostKey [32]byte
	copy(secret[:], bytes.Repeat([]byte{3}, 32))
	copy(hostKey[:], host.Public().(ed25519.PublicKey))
	edit := KeptLinkSecrets{Access: AccessEdit, Secret: secret, HostKey: hostKey}
	keys, err := DeriveKeptRoomKeys(edit, "AAECAwQFBgcICQoLDA0ODw")
	if err != nil {
		t.Fatal(err)
	}
	for _, access := range []Access{AccessEdit, AccessComment, AccessRead} {
		parsed, err := ParseKeptFragment(keys.Fragments[access])
		if err != nil || parsed.Access != access || parsed.HostKey != hostKey {
			t.Fatalf("parse %v: %+v, %v", access, parsed, err)
		}
		other, err := DeriveKeptRoomKeys(parsed, "AAECAwQFBgcICQoLDA0ODw")
		if err != nil || !bytes.Equal(other.FrameKey, keys.FrameKey) {
			t.Fatalf("derive %v: %v", access, err)
		}
		if access == AccessRead && other.CommentAdmission != "" {
			t.Fatal("read link produced a comment capability")
		}
		if access != AccessRead && other.CommentAdmission != keys.CommentAdmission {
			t.Fatal("comment capability differs across tiers")
		}
		if other.CommentAdmission != "" && (other.CommentAdmission == other.EditAdmission || other.CommentAdmission == other.ReadAdmission) {
			t.Fatal("capabilities are not separated")
		}
		if access != AccessEdit && other.Fragments[AccessEdit] != "" {
			t.Fatal("lower link produced an edit link")
		}
		if access == AccessRead && other.Fragments[AccessComment] != "" {
			t.Fatal("read link produced a comment link")
		}
	}
	commentLink, err := ParseKeptFragment(keys.Fragments[AccessComment])
	if err != nil {
		t.Fatal(err)
	}
	changedComment := commentLink
	copy(changedComment.EditKey[:], ed25519.NewKeyFromSeed(bytes.Repeat([]byte{9}, 32)).Public().(ed25519.PublicKey))
	changedKeys, err := DeriveKeptRoomKeys(changedComment, keys.roomID)
	if err != nil || changedKeys.CommentAdmission == keys.CommentAdmission {
		t.Fatal("editor key not bound to comment capability")
	}
	changedComment = commentLink
	changedComment.Secret[0] ^= 1
	changedKeys, err = DeriveKeptRoomKeys(changedComment, keys.roomID)
	if err != nil || changedKeys.CommentAdmission == keys.CommentAdmission {
		t.Fatal("comment secret not bound to capability")
	}
	message := []byte("checkpoint")
	if keys.Signer == nil || ed25519.Verify(host.Public().(ed25519.PublicKey), message, ed25519.Sign(keys.Signer.key, message)) {
		t.Fatal("editor signer impersonated the host")
	}
	changed := edit
	otherHost := ed25519.NewKeyFromSeed(bytes.Repeat([]byte{8}, ed25519.SeedSize))
	copy(changed.HostKey[:], otherHost.Public().(ed25519.PublicKey))
	other, err := DeriveKeptRoomKeys(changed, "AAECAwQFBgcICQoLDA0ODw")
	if err != nil || bytes.Equal(other.FrameKey, keys.FrameKey) || other.CommentAdmission == keys.CommentAdmission {
		t.Fatal("host key was not bound to frame and comment capability")
	}
	other, err = DeriveKeptRoomKeys(edit, "BAECAwQFBgcICQoLDA0ODw")
	if err != nil || bytes.Equal(other.FrameKey, keys.FrameKey) || other.CommentAdmission == keys.CommentAdmission {
		t.Fatal("room ID was not bound to frame and comment capability")
	}
	for _, invalid := range []string{"", "room-one", "室", "AAECAwQFBgcICQoLDA0ODw\n"} {
		if _, err := DeriveKeptRoomKeys(edit, invalid); err == nil {
			t.Errorf("accepted invalid room ID %q", invalid)
		}
	}
}

func TestKeptFragmentRejectsMalformedAndNonCanonical(t *testing.T) {
	for _, fragment := range []string{"", "v6.e.A", "v5.e.invalid", "v6.e." + string(bytes.Repeat([]byte{'A'}, 86)), "v6.r." + string(bytes.Repeat([]byte{'A'}, 170)) + "B"} {
		if _, err := ParseKeptFragment(fragment); err == nil {
			t.Errorf("accepted %q", fragment)
		}
	}
}
