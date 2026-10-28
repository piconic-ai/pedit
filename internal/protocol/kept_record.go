package protocol

import (
	"bytes"
	"crypto/ed25519"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/binary"
	"errors"
)

const (
	senderDomain     = "pedit/v6/sender-cert\x00"
	recordDomain     = "pedit/v6/durable-frame\x00"
	senderBodySize   = len(senderDomain) + 22 + 32 + 1 + 32
	senderCertSize   = senderBodySize + ed25519.SignatureSize
	recordHeaderSize = len(recordDomain) + senderCertSize + 32 + 8 + 8 + 4
	maxRecordPayload = MaxFrameBytes - ivBytes - tagBytes - recordHeaderSize - ed25519.SignatureSize
)

type KeptRecordContext struct {
	RoomID     string
	Epoch      [32]byte
	Generation uint64
}
type KeptRecord struct {
	Access   Access
	Sender   [32]byte
	Sequence uint64
	Message  []byte
}

func (k *KeptRoomKeys) validRecordKeys(roomID string) bool {
	return k.validCheckpointKeys(roomID) && subtle.ConstantTimeCompare(k.EditKey, k.editBinding[:]) == 1 && subtle.ConstantTimeCompare(k.CommentKey, k.commentBinding[:]) == 1
}

func recordContextValid(c KeptRecordContext) bool {
	return keptRoomIDPattern.MatchString(c.RoomID) && c.Epoch != [32]byte{} && c.Generation > 0 && c.Generation <= maxKeptCounter
}

func recordBinding(k *KeptRoomKeys) [32]byte {
	h := sha256.New()
	h.Write([]byte("pedit/v6/room-binding\x00"))
	h.Write(k.FrameKey)
	var result [32]byte
	copy(result[:], h.Sum(nil))
	return result
}

func CreateKeptSenderCertificate(k *KeptRoomKeys, sender ed25519.PublicKey) ([]byte, error) {
	if k == nil || !k.validRecordKeys(k.roomID) || k.Signer == nil || !validKeptPublicKey(sender) {
		return nil, errors.New("invalid sender certificate")
	}
	signer := k.Signer
	var tier byte
	var expected ed25519.PublicKey
	switch signer.Access {
	case AccessEdit:
		tier, expected = 0, k.EditKey
	case AccessComment:
		tier, expected = 1, k.CommentKey
	default:
		return nil, errors.New("invalid sender certificate")
	}
	if len(signer.key) != ed25519.PrivateKeySize || !bytes.Equal(ed25519.NewKeyFromSeed(signer.key[:32]), signer.key) || !bytes.Equal(signer.key[32:], expected) {
		return nil, errors.New("invalid sender certificate")
	}
	body := make([]byte, 0, senderCertSize)
	body = append(body, senderDomain...)
	body = append(body, k.roomID...)
	binding := recordBinding(k)
	body = append(body, binding[:]...)
	body = append(body, tier)
	body = append(body, sender...)
	return append(body, ed25519.Sign(signer.key, body)...), nil
}

func openKeptCertificate(k *KeptRoomKeys, cert []byte) (Access, ed25519.PublicKey, error) {
	if len(cert) != senderCertSize || !bytes.Equal(cert[:len(senderDomain)], []byte(senderDomain)) {
		return 0, nil, errors.New("invalid sender certificate")
	}
	at := len(senderDomain)
	if string(cert[at:at+22]) != k.roomID {
		return 0, nil, errors.New("invalid sender certificate")
	}
	at += 22
	binding := recordBinding(k)
	if !bytes.Equal(cert[at:at+32], binding[:]) {
		return 0, nil, errors.New("invalid sender certificate")
	}
	at += 32
	var access Access
	var key ed25519.PublicKey
	switch cert[at] {
	case 0:
		access, key = AccessEdit, k.EditKey
	case 1:
		access, key = AccessComment, k.CommentKey
	default:
		return 0, nil, errors.New("invalid sender certificate")
	}
	at++
	sender := cert[at : at+32]
	if !validKeptPublicKey(sender) || !ed25519.Verify(key, cert[:senderBodySize], cert[senderBodySize:]) {
		return 0, nil, errors.New("invalid sender certificate")
	}
	return access, sender, nil
}

func SealKeptRecord(k *KeptRoomKeys, c KeptRecordContext, sender ed25519.PrivateKey, cert []byte, sequence uint64, message []byte) ([]byte, error) {
	if !k.validRecordKeys(c.RoomID) || !recordContextValid(c) || sequence == 0 || sequence > maxKeptCounter || len(message) == 0 || len(message) > maxRecordPayload {
		return nil, errors.New("invalid durable record")
	}
	_, public, err := openKeptCertificate(k, cert)
	if err != nil || len(sender) != ed25519.PrivateKeySize || !bytes.Equal(sender, ed25519.NewKeyFromSeed(sender[:32])) || !bytes.Equal(sender[32:], public) {
		return nil, errors.New("invalid durable record")
	}
	body := make([]byte, recordHeaderSize, recordHeaderSize+len(message)+ed25519.SignatureSize)
	at := copy(body, recordDomain)
	at += copy(body[at:], cert)
	at += copy(body[at:], c.Epoch[:])
	binary.BigEndian.PutUint64(body[at:], c.Generation)
	at += 8
	binary.BigEndian.PutUint64(body[at:], sequence)
	at += 8
	binary.BigEndian.PutUint32(body[at:], uint32(len(message)))
	body = append(body, message...)
	body = append(body, ed25519.Sign(sender, body)...)
	cipher, err := NewCipher(k.FrameKey)
	if err != nil {
		return nil, err
	}
	return cipher.Encrypt(body), nil
}

func OpenKeptRecord(k *KeptRoomKeys, c KeptRecordContext, ciphertext []byte) (KeptRecord, error) {
	var out KeptRecord
	bad := errors.New("invalid durable record")
	if !k.validRecordKeys(c.RoomID) || !recordContextValid(c) || len(ciphertext) > MaxFrameBytes {
		return out, bad
	}
	cipher, err := NewCipher(k.FrameKey)
	if err != nil {
		return out, bad
	}
	body, err := cipher.Decrypt(ciphertext)
	if err != nil || len(body) < recordHeaderSize+ed25519.SignatureSize+1 || !bytes.Equal(body[:len(recordDomain)], []byte(recordDomain)) {
		return out, bad
	}
	at := len(recordDomain)
	access, sender, err := openKeptCertificate(k, body[at:at+senderCertSize])
	if err != nil {
		return out, bad
	}
	at += senderCertSize
	if !bytes.Equal(body[at:at+32], c.Epoch[:]) {
		return out, bad
	}
	at += 32
	generation := binary.BigEndian.Uint64(body[at:])
	at += 8
	sequence := binary.BigEndian.Uint64(body[at:])
	at += 8
	length := binary.BigEndian.Uint32(body[at:])
	at += 4
	end := len(body) - ed25519.SignatureSize
	if generation != c.Generation || sequence == 0 || sequence > maxKeptCounter || int(length) != end-at || !ed25519.Verify(sender, body[:end], body[end:]) {
		return out, bad
	}
	out.Access = access
	copy(out.Sender[:], sender)
	out.Sequence = sequence
	out.Message = bytes.Clone(body[at:end])
	return out, nil
}
