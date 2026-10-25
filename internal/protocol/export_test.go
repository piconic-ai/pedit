package protocol

import (
	"testing"
	"time"
)

// ShortenResyncForTest has Clients ask the room again after d, not
// resyncEvery, until the test ends.
func ShortenResyncForTest(t *testing.T, d time.Duration) {
	old := resyncEvery
	resyncEvery = d
	t.Cleanup(func() { resyncEvery = old })
}

// SealFrame makes a frame as a Client with keys sends it: message
// (EncodeMessage) from a sender, numbered counter, signed if the link signs,
// and encrypted.
func SealFrame(keys *RoomKeys, from Sender, counter uint64, message []byte) []byte {
	c, err := NewCipher(keys.FrameKey)
	if err != nil {
		panic(err)
	}
	if keys.Signer != nil {
		message = signMessage(keys.Signer, keys.Access, EncodeFrame(from, counter, nil), message)
	}
	return c.Encrypt(EncodeFrame(from, counter, message))
}
