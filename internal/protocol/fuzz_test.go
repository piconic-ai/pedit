package protocol_test

import (
	"bytes"
	"reflect"
	"testing"

	"github.com/piconic-ai/pedit/internal/protocol"
)

// Everything in these fuzz tests comes from a peer: anyone with the room link
// holds the key, so a decrypted frame can carry any bytes. None of it may
// panic the CLI.

func FuzzDecodeMessage(f *testing.F) {
	f.Add([]byte{})
	f.Add(protocol.EncodeMessage(protocol.MessageSync, []byte{0, 1, 0}))
	f.Add(protocol.EncodeMessage(protocol.MessageCanvas, []byte(`{"kind":"x"}`)))
	f.Add([]byte{0xff, 1, 2})
	f.Fuzz(func(t *testing.T, data []byte) {
		typ, payload, err := protocol.DecodeMessage(data)
		if err != nil {
			return
		}
		if got := protocol.EncodeMessage(typ, payload); !bytes.Equal(got, data) {
			t.Fatalf("EncodeMessage(DecodeMessage(%x)) = %x", data, got)
		}
	})
}

func FuzzDecrypt(f *testing.F) {
	key := make([]byte, protocol.KeyBytes)
	c, err := protocol.NewCipher(key)
	if err != nil {
		f.Fatal(err)
	}
	f.Add([]byte{}, false)
	f.Add([]byte("hello"), true)
	f.Add(make([]byte, 40), false)
	f.Fuzz(func(t *testing.T, data []byte, seal bool) {
		if !seal {
			_, _ = c.Decrypt(data) // must not panic
			return
		}
		got, err := c.Decrypt(c.Encrypt(data))
		if err != nil || !bytes.Equal(got, data) {
			t.Fatalf("Decrypt(Encrypt(%x)) = %x, %v", data, got, err)
		}
	})
}

func FuzzBlobDecrypt(f *testing.F) {
	keys, err := protocol.DeriveBlobKeys(make([]byte, protocol.KeyBytes))
	if err != nil {
		f.Fatal(err)
	}
	f.Add([]byte{}, "")
	f.Add(make([]byte, 64), protocol.ContentHash([]byte("x")))
	f.Fuzz(func(t *testing.T, data []byte, hash string) {
		_, _ = keys.Decrypt(data, hash) // must not panic
	})
}

func FuzzDecodeKey(f *testing.F) {
	f.Add(protocol.GenerateKey())
	f.Add("")
	f.Add("not base64!")
	f.Fuzz(func(t *testing.T, s string) {
		raw, err := protocol.DecodeKey(s)
		if err == nil && len(raw) != protocol.KeyBytes {
			t.Fatalf("DecodeKey(%q) gave %d bytes", s, len(raw))
		}
	})
}

func FuzzDecodeAttachment(f *testing.F) {
	hash := protocol.ContentHash([]byte("x"))
	f.Add([]byte{})
	for _, a := range []protocol.Attachment{
		{Kind: protocol.AttachmentAnnounce, Hash: hash, Mime: "image/png"},
		{Kind: protocol.AttachmentWant, Hashes: []string{hash, hash}},
		{Kind: protocol.AttachmentStored, Hash: hash, Path: "assets/a.png"},
		{Kind: protocol.AttachmentRejected, Hash: hash, Reason: "too large"},
	} {
		seed, err := protocol.EncodeAttachment(a)
		if err != nil {
			f.Fatal(err)
		}
		f.Add(seed)
	}
	f.Fuzz(func(t *testing.T, payload []byte) {
		a, err := protocol.DecodeAttachment(payload)
		if err != nil {
			return
		}
		// What decodes encodes again, to the same message.
		again, err := protocol.EncodeAttachment(a)
		if err != nil {
			t.Fatalf("EncodeAttachment(%+v): %v", a, err)
		}
		b, err := protocol.DecodeAttachment(again)
		if err != nil || !reflect.DeepEqual(a, b) {
			t.Fatalf("round trip of %+v gave %+v, %v", a, b, err)
		}
	})
}

func FuzzDecodeCanvas(f *testing.F) {
	f.Add([]byte{})
	for _, m := range []protocol.CanvasMessage{
		{Kind: protocol.CanvasEdit, ID: "e1", Base: `{"nodes":[]}`, Next: `{"nodes":[{"id":"a"}]}`},
		{Kind: protocol.CanvasApplied, ID: "e1"},
		{Kind: protocol.CanvasRejected, ID: "e1", Reason: "conflict"},
	} {
		seed, err := protocol.EncodeCanvas(m)
		if err != nil {
			f.Fatal(err)
		}
		f.Add(seed)
	}
	f.Fuzz(func(t *testing.T, payload []byte) {
		m, err := protocol.DecodeCanvas(payload)
		if err != nil {
			return
		}
		again, err := protocol.EncodeCanvas(m)
		if err != nil {
			t.Fatalf("EncodeCanvas(%+v): %v", m, err)
		}
		n, err := protocol.DecodeCanvas(again)
		if err != nil || n != m {
			t.Fatalf("round trip of %+v gave %+v, %v", m, n, err)
		}
	})
}

func FuzzParseExpiredReason(f *testing.F) {
	f.Add("")
	f.Add(protocol.ExpiredReason(86400))
	f.Fuzz(func(t *testing.T, reason string) {
		_, _ = protocol.ParseExpiredReason(reason) // must not panic
	})
}
