package protocol

import (
	"bytes"
	"crypto/ed25519"
	"testing"

	"github.com/reearth/ygo/crdt"
)

func TestKeptTextEditorSignatureAndIdempotentReplay(t *testing.T) {
	link, err := ParseFragment(GenerateEditSecret())
	if err != nil {
		t.Fatal(err)
	}
	editor, err := DeriveRoomKeys(link, "abcdefghijklmnopqrstuv")
	if err != nil {
		t.Fatal(err)
	}
	doc := crdt.New()
	defer doc.Destroy()
	text := doc.GetText("content")
	doc.Transact(func(tx *crdt.Transaction) { text.Insert(tx, 0, "guest edit", nil) })
	update := crdt.EncodeStateAsUpdateV1(doc, nil)
	frame, err := SealKeptText(editor, update)
	if err != nil {
		t.Fatal(err)
	}
	for _, tier := range []Access{AccessEdit, AccessComment, AccessRead} {
		secrets, err := ParseFragment(editor.Fragments[tier])
		if err != nil {
			t.Fatal(err)
		}
		keys, err := DeriveRoomKeys(secrets, "abcdefghijklmnopqrstuv")
		if err != nil {
			t.Fatal(err)
		}
		decoded, err := OpenKeptText(keys, frame)
		if err != nil || !bytes.Equal(decoded, update) {
			t.Fatal("tier could not verify editor update")
		}
		target := crdt.New()
		for i := 0; i < 2; i++ {
			if err := crdt.ApplyUpdateV1(target, decoded, nil); err != nil {
				t.Fatal(err)
			}
		}
		if target.GetText("content").ToString() != "guest edit" {
			t.Fatal("replay duplicated text")
		}
		target.Destroy()
		if tier != AccessEdit {
			if _, err := SealKeptText(keys, update); err == nil {
				t.Fatal("lower tier signed text")
			}
		}
		if tier == AccessComment {
			c, _ := NewCipher(keys.FrameKey)
			message := append(bytes.Clone(keptTextDomain), update...)
			forged := c.Encrypt(append(message, ed25519.Sign(keys.Signer, message)...))
			if _, err := OpenKeptText(editor, forged); err == nil {
				t.Fatal("accepted commenter signature as editor")
			}
		}
	}
	other, err := DeriveRoomKeys(link, "bbbbbbbbbbbbbbbbbbbbbb")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := OpenKeptText(other, frame); err == nil {
		t.Fatal("replayed into another room")
	}
	frame[len(frame)-1] ^= 1
	if _, err := OpenKeptText(editor, frame); err == nil {
		t.Fatal("accepted corrupt ciphertext")
	}
	for _, bad := range [][]byte{nil, {1}, make([]byte, MaxFrameBytes+1)} {
		if _, err := OpenKeptText(editor, bad); err == nil {
			t.Fatal("accepted malformed frame")
		}
	}
	if _, err := SealKeptText(editor, make([]byte, MaxFrameBytes)); err == nil {
		t.Fatal("accepted oversized update")
	}
	c, _ := NewCipher(editor.FrameKey)
	message := []byte("another domain\x00update")
	forged := c.Encrypt(append(message, ed25519.Sign(editor.Signer, message)...))
	if _, err := OpenKeptText(editor, forged); err == nil {
		t.Fatal("accepted cross-protocol frame")
	}
}
