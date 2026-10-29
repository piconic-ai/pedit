// Package hoststate stores the credentials needed to resume a kept room.
package hoststate

import (
	"bytes"
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"net/url"
	"regexp"

	"github.com/piconic-ai/pedit/internal/protocol"
)

var roomPattern = regexp.MustCompile(`^[A-Za-z0-9_-]{22}$`)
var ErrUnavailable = errors.New("host recovery credential storage unavailable")
var ErrInvalid = errors.New("invalid host recovery credentials")

// InitialRecord is a host-signed opaque bootstrap record. Consumers must
// validate its contents before use; it is stored atomically with credentials.
type InitialRecord struct {
	Payload   []byte `json:"payload"`
	Signature []byte `json:"signature"`
}

func (InitialRecord) String() string   { return "[host initial record]" }
func (InitialRecord) GoString() string { return "[host initial record]" }

// InitialState is the canonical private record signed with the host identity.
type InitialState struct {
	File           string   `json:"file"`
	Project        string   `json:"project"`
	Text           string   `json:"text"`
	CommentsExists bool     `json:"commentsExists"`
	Comments       string   `json:"comments"`
	Epoch          [32]byte `json:"epoch"`
	Checkpoint     []byte   `json:"checkpoint"`
}

func (InitialState) String() string   { return "[host initial state]" }
func (InitialState) GoString() string { return "[host initial state]" }

const maxInitialBytes = 3 * protocol.MaxFrameBytes
const maxCredentialsBytes = 4*protocol.MaxFrameBytes + 8192
const initialDomain = "pedit/v6/initial-baseline\x00"

// Credentials can include the private initial file and comment baseline.
// Generation advances only after the checkpoint has been durably accepted.
type Credentials struct {
	Version    int            `json:"version"`
	Origin     string         `json:"origin"`
	RoomID     string         `json:"roomId"`
	HostToken  string         `json:"hostToken"`
	EditSecret [32]byte       `json:"editSecret"`
	HostSeed   [32]byte       `json:"hostSeed"`
	Generation uint64         `json:"generation"`
	Initial    *InitialRecord `json:"initial,omitempty"`
}

func (c Credentials) validate() error {
	u, err := url.Parse(c.Origin)
	if err != nil || u.Scheme != "https" || u.Host == "" || u.User != nil || u.Path != "" || u.RawQuery != "" || u.Fragment != "" || u.String() != c.Origin || len(c.Origin) > 2048 || !roomPattern.MatchString(c.RoomID) || len(c.HostToken) != 43 || c.Generation > 1<<53-1 || c.Version != 1 || c.EditSecret == [32]byte{} || c.HostSeed == [32]byte{} {
		return ErrInvalid
	}
	token, err := base64.RawURLEncoding.Strict().DecodeString(c.HostToken)
	if err != nil || len(token) != 32 || base64.RawURLEncoding.EncodeToString(token) != c.HostToken {
		return ErrInvalid
	}
	digest := sha256.Sum256([]byte(c.HostToken))
	if base64.RawURLEncoding.EncodeToString(digest[:])[:22] != c.RoomID {
		return ErrInvalid
	}

	if c.Initial != nil {
		r := c.Initial
		if len(r.Payload) == 0 || len(r.Payload) > maxInitialBytes || len(r.Signature) != ed25519.SignatureSize {
			return ErrInvalid
		}
		key := ed25519.NewKeyFromSeed(c.HostSeed[:])
		if !ed25519.Verify(key.Public().(ed25519.PublicKey), initialMessage(c.RoomID, r.Payload), r.Signature) {
			return ErrInvalid
		}
	}
	return nil
}

func initialMessage(room string, payload []byte) []byte {
	b := make([]byte, 0, len(initialDomain)+len(room)+len(payload))
	b = append(b, initialDomain...)
	b = append(b, room...)
	return append(b, payload...)
}

// BindInitial signs and copies an initial baseline before its first save.
func (c Credentials) BindInitial(payload []byte) (Credentials, error) {
	if c.Initial != nil || c.Generation != 1 || c.validate() != nil || len(payload) == 0 || len(payload) > maxInitialBytes {
		return Credentials{}, ErrInvalid
	}
	key := ed25519.NewKeyFromSeed(c.HostSeed[:])
	data := bytes.Clone(payload)
	c.Initial = &InitialRecord{Payload: data, Signature: ed25519.Sign(key, initialMessage(c.RoomID, data))}
	return c, nil
}

// InitialState validates and returns the canonical signed record.
func (c Credentials) InitialState() (InitialState, error) {
	var state InitialState
	if c.validate() != nil || c.Initial == nil {
		return state, ErrInvalid
	}
	raw := c.Initial.Payload
	if json.Unmarshal(raw, &state) != nil {
		return InitialState{}, ErrInvalid
	}
	canonical, err := json.Marshal(state)
	if err != nil || !bytes.Equal(raw, canonical) || len(state.Checkpoint) == 0 {
		return InitialState{}, ErrInvalid
	}
	return state, nil
}

func sameInitial(a, b *InitialRecord) bool {
	if a == nil || b == nil {
		return a == nil && b == nil
	}
	return bytes.Equal(a.Payload, b.Payload) && bytes.Equal(a.Signature, b.Signature)
}

// Keys derives the editor and host identities needed by recovery; no secret is
// sent to the relay by this method.
func (c Credentials) Keys() (*protocol.KeptRoomKeys, ed25519.PrivateKey, error) {
	if err := c.validate(); err != nil {
		return nil, nil, err
	}
	private := ed25519.NewKeyFromSeed(c.HostSeed[:])
	var pub [32]byte
	copy(pub[:], private.Public().(ed25519.PublicKey))
	keys, err := protocol.DeriveKeptRoomKeys(protocol.KeptLinkSecrets{Access: protocol.AccessEdit, Secret: c.EditSecret, HostKey: pub}, c.RoomID)
	return keys, private, err
}

// String and GoString avoid accidental disclosure in formatted logs.
func (Credentials) String() string   { return "[host recovery credentials]" }
func (Credentials) GoString() string { return "[host recovery credentials]" }
