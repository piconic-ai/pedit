package protocol

import (
	"crypto/hkdf"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"regexp"
)

const (
	blobEncInfo = "pedit blob enc v2"
	blobIDInfo  = "pedit blob id v2"
)

var (
	// hashPattern matches a content hash: the first 128 bits of SHA-256, as 32 lowercase hex digits.
	hashPattern = regexp.MustCompile(`^[0-9a-f]{32}$`)
	// blobIDPattern matches a blob id: the first 128 bits of an HMAC, as 22 base64url characters.
	blobIDPattern = regexp.MustCompile(`^[A-Za-z0-9_-]{22}$`)
)

// ValidHash reports whether s is a content hash.
func ValidHash(s string) bool { return hashPattern.MatchString(s) }

// ValidBlobID reports whether s is a blob id.
func ValidBlobID(s string) bool { return blobIDPattern.MatchString(s) }

// BlobKeys holds the attachment keys, derived from the frame key
// (RoomKeys.FrameKey) with HKDF-SHA256. They are separate from the frame key, so a blob can never be
// replayed as a frame.
type BlobKeys struct {
	cipher *Cipher
	id     []byte
	// Admission is safe to send to the relay; it cannot decrypt blobs or frames.
	Admission string
}

// DeriveBlobKeys derives the attachment keys from a room's frame key.
func DeriveBlobKeys(key []byte) (*BlobKeys, error) {
	if len(key) != KeyBytes {
		return nil, fmt.Errorf("key must be %d bytes", KeyBytes)
	}
	enc, err := hkdf.Key(sha256.New, key, nil, blobEncInfo, KeyBytes)
	if err != nil {
		return nil, err
	}
	id, err := hkdf.Key(sha256.New, key, nil, blobIDInfo, KeyBytes)
	if err != nil {
		return nil, err
	}
	c, err := NewCipher(enc)
	if err != nil {
		return nil, err
	}
	admission, err := AdmissionToken(key)
	if err != nil {
		return nil, err
	}
	return &BlobKeys{cipher: c, id: id, Admission: admission}, nil
}

// ContentHash names an attachment by its content; the host uses it as the file name.
func ContentHash(content []byte) string {
	sum := sha256.Sum256(content)
	return hex.EncodeToString(sum[:16])
}

// BlobID is where the attachment is stored on the server. Anyone in the room
// can derive it from a link in the document, but the server cannot tell which
// content it is.
func (k *BlobKeys) BlobID(hash string) (string, error) {
	if !ValidHash(hash) {
		return "", fmt.Errorf("invalid content hash: %q", hash)
	}
	mac := hmac.New(sha256.New, k.id)
	mac.Write([]byte(hash))
	return base64.RawURLEncoding.EncodeToString(mac.Sum(nil)[:16]), nil
}

// Encrypt encrypts an attachment as `iv || ciphertext`.
func (k *BlobKeys) Encrypt(plaintext []byte) []byte {
	return k.cipher.Encrypt(plaintext)
}

// Decrypt reverses Encrypt and checks the content against the hash it was
// fetched for: whoever uploaded first under a blob id could have put anything there.
func (k *BlobKeys) Decrypt(data []byte, hash string) ([]byte, error) {
	plaintext, err := k.cipher.Decrypt(data)
	if err != nil {
		return nil, err
	}
	if ContentHash(plaintext) != hash {
		return nil, errors.New("attachment does not match its hash")
	}
	return plaintext, nil
}
