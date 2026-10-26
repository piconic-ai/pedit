package protocol

import (
	"crypto/hkdf"
	"crypto/sha256"
	"encoding/base64"
	"fmt"
)

// AdmissionHeader carries a room capability, never the encryption key.
const AdmissionHeader = "X-Pedit-Admission"

// ReadAdmissionHeader carries the reader admission token (access.go) on the
// host's upgrade request, so the relay admits comment-only and read-only
// links too. The host offers the editor token as its subprotocol, as every
// editor does. Keep it equal to READ_ADMISSION_HEADER in packages/protocol.
const ReadAdmissionHeader = "X-Pedit-Read-Admission"

// ProtocolVersion is the wire format version, offered as SocketProtocol.
// Bump it only for changes older peers cannot skip; adding a message type or
// kind does not need a bump. Keep it in sync with packages/protocol.
const ProtocolVersion = 5

// SocketProtocol is "pedit-v" followed by ProtocolVersion.
const SocketProtocol = "pedit-v5"
const AdmissionProtocolPrefix = "pedit-admission."

// AdmissionToken derives the relay capability of everyone in a room from its
// frame key (access.go), domain-separated from all encryption keys. Knowing
// this token does not reveal document plaintext.
func AdmissionToken(frameKey []byte) (string, error) {
	if len(frameKey) != KeyBytes {
		return "", fmt.Errorf("key must be %d bytes", KeyBytes)
	}
	token, err := hkdf.Key(sha256.New, frameKey, nil, labelReadAdmission, KeyBytes)
	if err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(token), nil
}
