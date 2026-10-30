package protocol

import (
	"bytes"
	"strings"
	"testing"
)

func TestKeptTextSnapshotFilename(t *testing.T) {
	link, _ := ParseFragment(GenerateEditSecret())
	keys, _ := DeriveRoomKeys(link, "abcdefghijklmnopqrstuv")
	raw := []byte{0, 0}
	frame, err := SealKeptTextSnapshot(keys, "議事録.md", raw)
	if err != nil {
		t.Fatal(err)
	}
	name, got, err := OpenKeptTextSnapshot(keys, frame)
	if err != nil || name != "議事録.md" || !bytes.Equal(got, raw) {
		t.Fatalf("snapshot: %q %x %v", name, got, err)
	}
	if bytes.Contains(frame, []byte(name)) {
		t.Fatal("plaintext filename exposed")
	}
	if _, err := OpenKeptText(keys, frame); err == nil {
		t.Fatal("snapshot accepted as log update")
	}
	frame[len(frame)-1] ^= 1
	if _, _, err := OpenKeptTextSnapshot(keys, frame); err == nil {
		t.Fatal("tamper accepted")
	}
	legacy, _ := SealKeptText(keys, raw)
	name, got, err = OpenKeptTextSnapshot(keys, legacy)
	if err != nil || name != "" || !bytes.Equal(got, raw) {
		t.Fatal("legacy snapshot rejected")
	}
	for _, name := range []string{"", strings.Repeat("x", 4097), "../secret.md", "dir/name", "a\\b", "bad\x00name", string([]byte{255})} {
		if _, err := SealKeptTextSnapshot(keys, name, raw); err == nil {
			t.Fatalf("invalid filename accepted: %q", name)
		}
	}
	if _, err := SealKeptTextSnapshot(keys, "notes.md", make([]byte, MaxFrameBytes)); err == nil {
		t.Fatal("oversize accepted")
	}
}

func TestKeptTextSnapshotRejectsMalformedPayload(t *testing.T) {
	link, _ := ParseFragment(GenerateEditSecret())
	keys, _ := DeriveRoomKeys(link, "abcdefghijklmnopqrstuv")
	for _, payload := range [][]byte{{0}, {0, 0, 1}, {0, 4, 'a', 1}, {0, 1, 255, 1}, {0, 1, 'a'}} {
		frame, err := sealKeptPayload(keys, keptSnapshotDomain, payload)
		if err != nil {
			t.Fatal(err)
		}
		if _, _, err := OpenKeptTextSnapshot(keys, frame); err == nil {
			t.Fatalf("malformed snapshot accepted: %x", payload)
		}
	}
	if _, err := SealKeptTextSnapshot(keys, "notes.md", nil); err == nil {
		t.Fatal("empty update accepted")
	}
}
