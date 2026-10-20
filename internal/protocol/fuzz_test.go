package protocol_test

import (
	"bytes"
	"path"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"unicode"
	"unicode/utf8"

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

func FuzzCheckPath(f *testing.F) {
	for _, p := range []string{"notes.md", "docs/a.md", "../x", "CON", "a:b", "a\\b", "café.md", "a‮b", "trailing.", "a//b", "\xff"} {
		f.Add(p)
	}
	f.Fuzz(func(t *testing.T, p string) {
		if protocol.CheckPath(p) != nil {
			return
		}
		// What the checks promise, and what filepath agrees with on this platform.
		if !utf8.ValidString(p) || path.Clean(p) != p || !filepath.IsLocal(filepath.FromSlash(p)) {
			t.Fatalf("CheckPath accepted %q, which is not a clean local path", p)
		}
		if strings.ContainsAny(p, `\:<>"|?*`) {
			t.Fatalf("CheckPath accepted %q, with a character Windows refuses", p)
		}
		for _, r := range p {
			if unicode.IsControl(r) || unicode.Is(unicode.Bidi_Control, r) {
				t.Fatalf("CheckPath accepted %q, with %U", p, r)
			}
		}
		if k := protocol.PathKey(p); protocol.PathKey(k) != k {
			t.Fatalf("PathKey(%q) = %q, but PathKey of that is %q", p, k, protocol.PathKey(k))
		}
	})
}

func FuzzDecodeFiles(f *testing.F) {
	m, _ := protocol.EncodeManifest([]protocol.FileEntry{{ID: 1, Path: "a.md", Format: protocol.FormatText}})
	d, _ := protocol.EncodeFileDoc(1, protocol.MessageSync, []byte{0, 1, 0})
	f.Add(m)
	f.Add(d)
	f.Add([]byte{})
	f.Add([]byte{0, 1, 1, 4, '.', '.', '/', 'x', 4, 't', 'e', 'x', 't'})
	f.Fuzz(func(t *testing.T, data []byte) {
		m, err := protocol.DecodeFiles(data)
		if err != nil {
			return
		}
		// What decodes is safe to show and to route, and encodes the same.
		var again []byte
		if m.Kind == protocol.FilesManifest {
			for _, e := range m.Files {
				if protocol.CheckPath(e.Path) != nil || e.ID > protocol.MaxFileID {
					t.Fatalf("decoded an unsafe entry %+v", e)
				}
			}
			again, err = protocol.EncodeManifest(m.Files)
		} else {
			again, err = protocol.EncodeFileDoc(m.File, m.Type, m.Payload)
		}
		if err != nil {
			t.Fatalf("re-encoding %+v: %v", m, err)
		}
		if again2, _ := protocol.DecodeFiles(again); !reflect.DeepEqual(again2, m) {
			t.Fatalf("decode(encode(%+v)) = %+v", m, again2)
		}
	})
}
