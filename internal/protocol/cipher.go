package protocol

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"errors"
)

const (
	ivBytes  = 12
	tagBytes = 16 // AES-GCM's tag, aead.Overhead()
)

// Cipher encrypts frames with AES-GCM as `iv || ciphertext`, the same layout
// the web client uses.
type Cipher struct {
	aead cipher.AEAD
}

func NewCipher(key []byte) (*Cipher, error) {
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, err
	}
	aead, err := cipher.NewGCM(block)
	if err != nil {
		return nil, err
	}
	return &Cipher{aead: aead}, nil
}

// Encrypt returns `iv || ciphertext` with a fresh random IV.
func (c *Cipher) Encrypt(plaintext []byte) []byte {
	iv := make([]byte, ivBytes, ivBytes+len(plaintext)+c.aead.Overhead())
	_, _ = rand.Read(iv) // never fails
	return c.aead.Seal(iv, iv, plaintext, nil)
}

// Decrypt reverses Encrypt. It fails if the key is wrong or the data was tampered with.
func (c *Cipher) Decrypt(data []byte) ([]byte, error) {
	if len(data) <= ivBytes {
		return nil, errors.New("ciphertext too short")
	}
	return c.aead.Open(nil, data[:ivBytes], data[ivBytes:], nil)
}
