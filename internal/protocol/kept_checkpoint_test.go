package protocol

import (
	"bytes"
	"crypto/ed25519"
	"encoding/base64"
	"encoding/json"
	"os"
	"testing"
)

func TestKeptCheckpointRoundTripAndContext(t *testing.T) {
	private := ed25519.NewKeyFromSeed(bytes.Repeat([]byte{7}, ed25519.SeedSize))
	var host, secret, epoch [32]byte
	copy(host[:], private.Public().(ed25519.PublicKey))
	copy(secret[:], bytes.Repeat([]byte{3}, 32))
	copy(epoch[:], bytes.Repeat([]byte{5}, 32))
	keys, err := DeriveKeptRoomKeys(KeptLinkSecrets{Access: AccessEdit, Secret: secret, HostKey: host}, "AAECAwQFBgcICQoLDA0ODw")
	if err != nil {
		t.Fatal(err)
	}
	context := KeptCheckpointContext{RoomID: "AAECAwQFBgcICQoLDA0ODw", Epoch: epoch, Generation: 1, Cutoff: 9}
	sealed, err := SealKeptCheckpoint(keys, private, context, []byte("state"))
	if err != nil {
		t.Fatal(err)
	}
	if bytes.Contains(sealed, []byte("state")) {
		t.Fatal("checkpoint contains plaintext")
	}
	got, err := OpenKeptCheckpoint(keys, context, sealed)
	if err != nil || string(got) != "state" {
		t.Fatalf("open = %q, %v", got, err)
	}
	wrong := context
	wrong.Cutoff++
	if _, err := OpenKeptCheckpoint(keys, wrong, sealed); err == nil {
		t.Fatal("accepted different cutoff")
	}
	wrong = context
	wrong.Epoch[0] ^= 1
	if _, err := OpenKeptCheckpoint(keys, wrong, sealed); err == nil {
		t.Fatal("accepted different epoch")
	}
	wrong = context
	wrong.RoomID = "BAECAwQFBgcICQoLDA0ODw"
	if _, err := OpenKeptCheckpoint(keys, wrong, sealed); err == nil {
		t.Fatal("accepted different room")
	}
	if _, err := SealKeptCheckpoint(keys, private, wrong, []byte("state")); err == nil {
		t.Fatal("sealed for different room")
	}
	other := ed25519.NewKeyFromSeed(bytes.Repeat([]byte{8}, ed25519.SeedSize))
	if _, err := SealKeptCheckpoint(keys, other, context, []byte("state")); err == nil {
		t.Fatal("accepted non-host signer")
	}
	altered := *keys
	altered.HostKey = other.Public().(ed25519.PublicKey)
	if _, err := SealKeptCheckpoint(&altered, other, context, []byte("state")); err == nil {
		t.Fatal("accepted a replaced host key")
	}
	altered = *keys
	altered.FrameKey = bytes.Repeat([]byte{9}, 32)
	if _, err := OpenKeptCheckpoint(&altered, context, sealed); err == nil {
		t.Fatal("accepted a replaced frame key")
	}
	boundary := context
	boundary.Generation = maxKeptCounter
	boundary.Cutoff = maxKeptCounter
	maximum := bytes.Repeat([]byte{1}, maxKeptCheckpointPayload)
	large, err := SealKeptCheckpoint(keys, private, boundary, maximum)
	if err != nil || len(large) != MaxFrameBytes {
		t.Fatalf("maximum checkpoint: length %d, error %v", len(large), err)
	}
	if got, err := OpenKeptCheckpoint(keys, boundary, large); err != nil || !bytes.Equal(got, maximum) {
		t.Fatalf("open maximum checkpoint: %v", err)
	}
	if _, err := SealKeptCheckpoint(keys, private, boundary, append(maximum, 1)); err == nil {
		t.Fatal("accepted oversized payload")
	}
	sealed[len(sealed)-1] ^= 1
	if _, err := OpenKeptCheckpoint(keys, context, sealed); err == nil {
		t.Fatal("accepted modified ciphertext")
	}
}

func TestKeptCheckpointVector(t *testing.T) {
	data, err := os.ReadFile("../../packages/testdata/kept-checkpoint-vectors.json")
	if err != nil {
		t.Fatal(err)
	}
	var v struct {
		RoomID, Epoch, Payload, Ciphertext string
		Generation, Cutoff                 uint64
	}
	if err := json.Unmarshal(data, &v); err != nil {
		t.Fatal(err)
	}
	decode := func(s string) []byte {
		t.Helper()
		b, err := base64.RawURLEncoding.Strict().DecodeString(s)
		if err != nil {
			t.Fatal(err)
		}
		return b
	}
	var secret, host, epoch [32]byte
	copy(secret[:], bytes.Repeat([]byte{3}, 32))
	copy(host[:], ed25519.NewKeyFromSeed(bytes.Repeat([]byte{7}, 32)).Public().(ed25519.PublicKey))
	copy(epoch[:], decode(v.Epoch))
	keys, err := DeriveKeptRoomKeys(KeptLinkSecrets{Access: AccessEdit, Secret: secret, HostKey: host}, v.RoomID)
	if err != nil {
		t.Fatal(err)
	}
	context := KeptCheckpointContext{RoomID: v.RoomID, Epoch: epoch, Generation: v.Generation, Cutoff: v.Cutoff}
	got, err := OpenKeptCheckpoint(keys, context, decode(v.Ciphertext))
	if err != nil || !bytes.Equal(got, decode(v.Payload)) {
		t.Fatalf("open vector: %v", err)
	}
	private := ed25519.NewKeyFromSeed(bytes.Repeat([]byte{7}, 32))
	sealed, err := SealKeptCheckpoint(keys, private, context, decode(v.Payload))
	if err != nil {
		t.Fatal(err)
	}
	checkCipher, err := NewCipher(keys.FrameKey)
	if err != nil {
		t.Fatal(err)
	}
	goPlain, err := checkCipher.Decrypt(sealed)
	if err != nil {
		t.Fatal(err)
	}
	fixturePlain, err := checkCipher.Decrypt(decode(v.Ciphertext))
	if err != nil || !bytes.Equal(goPlain, fixturePlain) {
		t.Fatalf("checkpoint signature vector mismatch: %v", err)
	}
	readLink, err := ParseKeptFragment(keys.Fragments[AccessRead])
	if err != nil {
		t.Fatal(err)
	}
	reader, err := DeriveKeptRoomKeys(readLink, v.RoomID)
	if err != nil {
		t.Fatal(err)
	}
	frameCipher, err := NewCipher(reader.FrameKey)
	if err != nil {
		t.Fatal(err)
	}
	plain, err := frameCipher.Decrypt(decode(v.Ciphertext))
	if err != nil {
		t.Fatal(err)
	}
	plain[keptCheckpointHeader] ^= 1
	if _, err := OpenKeptCheckpoint(keys, context, frameCipher.Encrypt(plain)); err == nil {
		t.Fatal("accepted a reader's forged checkpoint")
	}
	for _, bad := range []KeptCheckpointContext{
		{RoomID: context.RoomID, Epoch: epoch, Generation: 0, Cutoff: 9},
		{RoomID: context.RoomID, Epoch: epoch, Generation: 1 << 53, Cutoff: 9},
		{RoomID: context.RoomID, Epoch: epoch, Generation: 1, Cutoff: 1 << 53},
		{RoomID: context.RoomID, Generation: 1, Cutoff: 9},
	} {
		if _, err := OpenKeptCheckpoint(keys, bad, decode(v.Ciphertext)); err == nil {
			t.Fatal("accepted invalid context")
		}
	}
}
