package protocol_test

import (
	"bytes"
	"errors"
	"regexp"
	"testing"

	"github.com/piconic-ai/pedit/internal/protocol"
)

func TestGenerateKey(t *testing.T) {
	key := protocol.GenerateKey()
	if !regexp.MustCompile(`^[A-Za-z0-9_-]{43}$`).MatchString(key) {
		t.Fatalf("unexpected key format: %q", key)
	}
	raw, err := protocol.DecodeKey(key)
	if err != nil || len(raw) != 32 {
		t.Fatalf("DecodeKey(%q) = %v, %v", key, raw, err)
	}
	if protocol.GenerateKey() == key {
		t.Fatal("keys should differ")
	}
}

func TestDecodeKeyRejectsMalformed(t *testing.T) {
	for _, k := range []string{"short", "not base64url!", protocol.GenerateKey() + "="} {
		if _, err := protocol.DecodeKey(k); err == nil {
			t.Errorf("DecodeKey(%q) should fail", k)
		}
	}
}

func newCipher(t *testing.T) *protocol.Cipher {
	t.Helper()
	raw, _ := protocol.DecodeKey(protocol.GenerateKey())
	c, err := protocol.NewCipher(raw)
	if err != nil {
		t.Fatal(err)
	}
	return c
}

func TestCipher(t *testing.T) {
	c := newCipher(t)
	plaintext := []byte("hello, pedit")

	t.Run("round-trips plaintext", func(t *testing.T) {
		ciphertext := c.Encrypt(plaintext)
		if len(ciphertext) != 12+len(plaintext)+16 {
			t.Fatalf("unexpected length %d", len(ciphertext))
		}
		got, err := c.Decrypt(ciphertext)
		if err != nil || !bytes.Equal(got, plaintext) {
			t.Fatalf("Decrypt = %q, %v", got, err)
		}
	})

	t.Run("uses a fresh IV each time", func(t *testing.T) {
		if bytes.Equal(c.Encrypt(plaintext), c.Encrypt(plaintext)) {
			t.Fatal("ciphertexts should differ")
		}
	})

	t.Run("fails with a different key", func(t *testing.T) {
		if _, err := newCipher(t).Decrypt(c.Encrypt(plaintext)); err == nil {
			t.Fatal("expected an error")
		}
	})

	t.Run("fails on tampered data", func(t *testing.T) {
		ciphertext := c.Encrypt(plaintext)
		ciphertext[len(ciphertext)-1] ^= 1
		if _, err := c.Decrypt(ciphertext); err == nil {
			t.Fatal("expected an error")
		}
		if _, err := c.Decrypt(ciphertext[:12]); err == nil {
			t.Fatal("expected an error for short data")
		}
	})
}

func TestFrameLimit(t *testing.T) {
	// Pins the limit, which packages/protocol/test/frame.test.ts pins too; the
	// relay takes it from there.
	if protocol.MaxFrameBytes != 1<<20 || protocol.MessageTooBig != 1009 {
		t.Fatalf("MaxFrameBytes = %d, MessageTooBig = %d", protocol.MaxFrameBytes, protocol.MessageTooBig)
	}
	c := newCipher(t)
	for _, n := range []int{0, 1, 1000} {
		frame := c.Encrypt(protocol.EncodeFrame(protocol.Sender{}, 1, protocol.EncodeMessage(protocol.MessageSync, make([]byte, n))))
		if len(frame) != protocol.FrameBytes(n) {
			t.Errorf("a payload of %d bytes is a frame of %d, FrameBytes says %d", n, len(frame), protocol.FrameBytes(n))
		}
	}
}

func TestMessage(t *testing.T) {
	sync := protocol.EncodeMessage(protocol.MessageSync, []byte{9, 8, 7})
	if !bytes.Equal(sync, []byte{0, 9, 8, 7}) {
		t.Fatalf("EncodeMessage = %v", sync)
	}
	typ, payload, err := protocol.DecodeMessage(sync)
	if err != nil || typ != protocol.MessageSync || !bytes.Equal(payload, []byte{9, 8, 7}) {
		t.Fatalf("DecodeMessage = %v, %v, %v", typ, payload, err)
	}
	typ, _, _ = protocol.DecodeMessage(protocol.EncodeMessage(protocol.MessageAwareness, nil))
	if typ != protocol.MessageAwareness {
		t.Fatalf("type = %v", typ)
	}
	typ, _, _ = protocol.DecodeMessage(protocol.EncodeMessage(protocol.MessageAttachment, nil))
	if typ != protocol.MessageAttachment {
		t.Fatalf("type = %v", typ)
	}
	if _, _, err := protocol.DecodeMessage([]byte{7, 1}); !errors.Is(err, protocol.ErrUnknownMessageType) {
		t.Errorf("DecodeMessage(unknown) = %v, want ErrUnknownMessageType", err)
	}
	if _, _, err := protocol.DecodeMessage(nil); err == nil || errors.Is(err, protocol.ErrUnknownMessageType) {
		t.Errorf("DecodeMessage(empty) = %v", err)
	}
}
