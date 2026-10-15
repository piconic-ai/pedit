package protocol

import (
	"testing"

	"github.com/reearth/ygo/awareness"
	"github.com/reearth/ygo/crdt"
	"github.com/reearth/ygo/encoding"
	ysync "github.com/reearth/ygo/sync"
)

// FuzzReceive feeds a client what any peer in the room can send: every
// frame, once decrypted with the shared key, goes through receive into the
// Yjs document and awareness. A peer must not be able to crash the CLI.
func FuzzReceive(f *testing.F) {
	peer := crdt.New()
	text := peer.GetText("content")
	peer.Transact(func(txn *crdt.Transaction) { text.Insert(txn, 0, "hello 🌏\n", nil) })
	peerAw := awareness.New(uint64(peer.ClientID()))
	peerAw.SetLocalState(map[string]any{"user": map[string]any{"name": "Bob"}})
	aw := encoding.NewEncoder()
	aw.WriteVarBytes(peerAw.EncodeUpdate([]uint64{uint64(peer.ClientID())}))

	f.Add(EncodeMessage(MessageSync, ysync.EncodeSyncStep1(peer)))
	f.Add(EncodeMessage(MessageSync, syncStep2(peer)))
	f.Add(EncodeMessage(MessageSync, ysync.EncodeUpdate(peer.EncodeStateAsUpdate())))
	f.Add(EncodeMessage(MessageAwareness, aw.Bytes()))
	f.Add([]byte{byte(MessageSync)})
	f.Add([]byte{byte(MessageAwareness), 0xff, 0xff})

	f.Fuzz(func(t *testing.T, plaintext []byte) {
		doc := crdt.New()
		c, err := NewClient(ClientOptions{
			Key:       make([]byte, KeyBytes),
			Doc:       doc,
			Awareness: awareness.New(uint64(doc.ClientID())),
		})
		if err != nil {
			t.Fatal(err)
		}
		defer c.Destroy()
		_ = c.receive(c.cipher.Encrypt(plaintext)) // an error is fine, a panic is not
	})
}
