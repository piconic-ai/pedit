package protocol

import (
	"bytes"
	"crypto/ed25519"
	"errors"
)

var keptTextDomain = []byte("pedit kept text v1\x00")

// SealKeptText accepts editor updates only; reader and commenter keys cannot sign them.
func SealKeptText(keys *RoomKeys, update []byte) ([]byte, error) {
	if keys == nil || keys.Access != AccessEdit || len(keys.Signer) != ed25519.PrivateKeySize || !bytes.Equal(keys.Signer.Public().(ed25519.PublicKey), keys.EditKey) || len(update) == 0 || len(update)+len(keptTextDomain)+ed25519.SignatureSize+ivBytes+tagBytes > MaxFrameBytes {
		return nil, errors.New("invalid kept text update")
	}
	c, err := NewCipher(keys.FrameKey)
	if err != nil {
		return nil, errors.New("invalid kept text key")
	}
	body := append(bytes.Clone(keptTextDomain), update...)
	return c.Encrypt(append(body, ed25519.Sign(keys.Signer, body)...)), nil
}

func OpenKeptText(keys *RoomKeys, ciphertext []byte) ([]byte, error) {
	if keys == nil || len(keys.EditKey) != ed25519.PublicKeySize || len(ciphertext) > MaxFrameBytes {
		return nil, errors.New("invalid kept text frame")
	}
	c, err := NewCipher(keys.FrameKey)
	if err != nil {
		return nil, errors.New("invalid kept text key")
	}
	body, err := c.Decrypt(ciphertext)
	if err != nil || len(body) <= len(keptTextDomain)+ed25519.SignatureSize {
		return nil, errors.New("invalid kept text frame")
	}
	message, sig := body[:len(body)-ed25519.SignatureSize], body[len(body)-ed25519.SignatureSize:]
	if !bytes.HasPrefix(message, keptTextDomain) || !ed25519.Verify(keys.EditKey, message, sig) {
		return nil, errors.New("invalid kept text signature")
	}
	return bytes.Clone(message[len(keptTextDomain):]), nil
}
