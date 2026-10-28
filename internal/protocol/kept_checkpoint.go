package protocol

import (
	"bytes"
	"crypto/ed25519"
	"crypto/subtle"
	"encoding/binary"
	"errors"
)

const (
	keptCheckpointDomain     = "pedit/v6/checkpoint\x00"
	keptCheckpointHeader     = len(keptCheckpointDomain) + 22 + 32 + 8 + 8 + 4
	maxKeptCounter           = 1<<53 - 1
	maxKeptCheckpointPayload = MaxFrameBytes - ivBytes - tagBytes - ed25519.SignatureSize - keptCheckpointHeader
)

type KeptCheckpointContext struct {
	RoomID     string
	Epoch      [32]byte
	Generation uint64
	Cutoff     uint64
}

func (keys *KeptRoomKeys) validCheckpointKeys(roomID string) bool {
	return keys != nil && keys.roomID == roomID &&
		subtle.ConstantTimeCompare(keys.HostKey, keys.hostBinding[:]) == 1 &&
		subtle.ConstantTimeCompare(keys.FrameKey, keys.frameBinding[:]) == 1 &&
		validKeptPublicKey(keys.HostKey)
}

func keptCheckpointHeaderFor(context KeptCheckpointContext, payloadSize int) ([]byte, error) {
	var zero [32]byte
	if !keptRoomIDPattern.MatchString(context.RoomID) || context.Epoch == zero || context.Generation == 0 || context.Generation > maxKeptCounter || context.Cutoff > maxKeptCounter || payloadSize <= 0 || payloadSize > maxKeptCheckpointPayload {
		return nil, errors.New("invalid checkpoint context or size")
	}
	header := make([]byte, keptCheckpointHeader)
	at := copy(header, keptCheckpointDomain)
	at += copy(header[at:], context.RoomID)
	at += copy(header[at:], context.Epoch[:])
	binary.BigEndian.PutUint64(header[at:], context.Generation)
	at += 8
	binary.BigEndian.PutUint64(header[at:], context.Cutoff)
	at += 8
	binary.BigEndian.PutUint32(header[at:], uint32(payloadSize))
	return header, nil
}

func SealKeptCheckpoint(keys *KeptRoomKeys, host ed25519.PrivateKey, context KeptCheckpointContext, payload []byte) ([]byte, error) {
	if !keys.validCheckpointKeys(context.RoomID) {
		return nil, errors.New("invalid checkpoint room")
	}
	header, err := keptCheckpointHeaderFor(context, len(payload))
	if err != nil {
		return nil, err
	}
	if len(host) != ed25519.PrivateKeySize || subtle.ConstantTimeCompare(host, ed25519.NewKeyFromSeed(host[:ed25519.SeedSize])) != 1 || !bytes.Equal(host[ed25519.SeedSize:], keys.HostKey) {
		return nil, errors.New("invalid checkpoint signer")
	}
	cipher, err := NewCipher(keys.FrameKey)
	if err != nil {
		return nil, err
	}
	signed := append(header, payload...)
	signed = append(signed, ed25519.Sign(host, signed)...)
	return cipher.Encrypt(signed), nil
}

func OpenKeptCheckpoint(keys *KeptRoomKeys, context KeptCheckpointContext, ciphertext []byte) ([]byte, error) {
	if !keys.validCheckpointKeys(context.RoomID) || len(ciphertext) > MaxFrameBytes {
		return nil, errors.New("invalid checkpoint")
	}
	cipher, err := NewCipher(keys.FrameKey)
	if err != nil {
		return nil, err
	}
	plaintext, err := cipher.Decrypt(ciphertext)
	if err != nil || len(plaintext) < keptCheckpointHeader+ed25519.SignatureSize {
		return nil, errors.New("invalid checkpoint")
	}
	length := len(plaintext) - keptCheckpointHeader - ed25519.SignatureSize
	header, err := keptCheckpointHeaderFor(context, length)
	if err != nil || !bytes.Equal(plaintext[:keptCheckpointHeader], header) || !ed25519.Verify(keys.HostKey, plaintext[:len(plaintext)-ed25519.SignatureSize], plaintext[len(plaintext)-ed25519.SignatureSize:]) {
		return nil, errors.New("invalid checkpoint")
	}
	return bytes.Clone(plaintext[keptCheckpointHeader : len(plaintext)-ed25519.SignatureSize]), nil
}
