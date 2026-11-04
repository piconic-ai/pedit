package protocol

import (
	"bytes"
	"crypto/ed25519"
	"encoding/binary"
	"errors"
	"strings"
	"unicode/utf8"
)

var keptTextDomain = []byte("pedit kept text v1\x00")

// SealKeptText accepts editor updates only; reader and commenter keys cannot sign them.
func SealKeptText(keys *RoomKeys, update []byte) ([]byte, error) {
	return sealKeptPayload(keys, keptTextDomain, update)
}

func sealKeptPayload(keys *RoomKeys, domain, update []byte) ([]byte, error) {
	if keys == nil || keys.Access != AccessEdit {
		return nil, errors.New("invalid kept text update")
	}
	return sealKeptWith(keys, keys.Signer, keys.EditKey, domain, update)
}

// sealKeptWith signs domain || update with signer, which must be the private
// half of public, and encrypts the result under the frame key.
func sealKeptWith(keys *RoomKeys, signer ed25519.PrivateKey, public ed25519.PublicKey, domain, update []byte) ([]byte, error) {
	if keys == nil || len(signer) != ed25519.PrivateKeySize || !bytes.Equal(signer.Public().(ed25519.PublicKey), public) || len(update) == 0 || len(update)+len(domain)+ed25519.SignatureSize+ivBytes+tagBytes > MaxFrameBytes {
		return nil, errors.New("invalid kept text update")
	}
	c, err := NewCipher(keys.FrameKey)
	if err != nil {
		return nil, errors.New("invalid kept text key")
	}
	body := append(bytes.Clone(domain), update...)
	return c.Encrypt(append(body, ed25519.Sign(signer, body)...)), nil
}

func OpenKeptText(keys *RoomKeys, ciphertext []byte) ([]byte, error) {
	return openKeptPayload(keys, keptTextDomain, ciphertext)
}

func openKeptPayload(keys *RoomKeys, domain, ciphertext []byte) ([]byte, error) {
	if keys == nil {
		return nil, errors.New("invalid kept text frame")
	}
	return openKeptWith(keys, keys.EditKey, domain, ciphertext)
}

// openKeptWith decrypts a kept frame and checks that domain starts it and key signed it.
func openKeptWith(keys *RoomKeys, key ed25519.PublicKey, domain, ciphertext []byte) ([]byte, error) {
	if keys == nil || len(key) != ed25519.PublicKeySize || len(ciphertext) > MaxFrameBytes {
		return nil, errors.New("invalid kept text frame")
	}
	c, err := NewCipher(keys.FrameKey)
	if err != nil {
		return nil, errors.New("invalid kept text key")
	}
	body, err := c.Decrypt(ciphertext)
	if err != nil || len(body) <= len(domain)+ed25519.SignatureSize {
		return nil, errors.New("invalid kept text frame")
	}
	message, sig := body[:len(body)-ed25519.SignatureSize], body[len(body)-ed25519.SignatureSize:]
	if !bytes.HasPrefix(message, domain) || !ed25519.Verify(key, message, sig) {
		return nil, errors.New("invalid kept text signature")
	}
	return bytes.Clone(message[len(domain):]), nil
}

var keptSnapshotDomain = []byte("pedit kept snapshot v1\x00")

func validKeptFilename(name string) bool {
	return len(name) > 0 && len(name) <= 4096 && name != "." && name != ".." && utf8.ValidString(name) && !strings.ContainsAny(name, "/\\\x00")
}

// SealKeptTextSnapshot keeps display metadata inside the authenticated ciphertext.
func SealKeptTextSnapshot(keys *RoomKeys, name string, update []byte) ([]byte, error) {
	if !validKeptFilename(name) || len(update) == 0 || len(update) > MaxFrameBytes {
		return nil, errors.New("invalid kept snapshot")
	}
	payload := make([]byte, 2+len(name)+len(update))
	binary.BigEndian.PutUint16(payload, uint16(len(name)))
	copy(payload[2:], name)
	copy(payload[2+len(name):], update)
	return sealKeptPayload(keys, keptSnapshotDomain, payload)
}

// OpenKeptTextSnapshot accepts legacy snapshots without display metadata.
func OpenKeptTextSnapshot(keys *RoomKeys, ciphertext []byte) (string, []byte, error) {
	payload, err := openKeptPayload(keys, keptSnapshotDomain, ciphertext)
	if err != nil {
		legacy, legacyErr := OpenKeptText(keys, ciphertext)
		return "", legacy, legacyErr
	}
	if len(payload) < 2 {
		return "", nil, errors.New("invalid kept snapshot")
	}
	n := int(binary.BigEndian.Uint16(payload))
	if n >= len(payload)-2 {
		return "", nil, errors.New("invalid kept snapshot")
	}
	name := string(payload[2 : 2+n])
	if !validKeptFilename(name) {
		return "", nil, errors.New("invalid kept snapshot name")
	}
	return name, payload[2+n:], nil
}
