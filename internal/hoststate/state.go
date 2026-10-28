// Package hoststate stores the credentials needed to resume a kept room.
package hoststate

import (
	"crypto/ed25519"
	"encoding/base64"
	"errors"
	"net/url"
	"regexp"

	"github.com/piconic-ai/pedit/internal/protocol"
)

var roomPattern = regexp.MustCompile(`^[A-Za-z0-9_-]{22}$`)
var ErrUnavailable = errors.New("host recovery credential storage unavailable")
var ErrInvalid = errors.New("invalid host recovery credentials")

// Credentials never include guest plaintext. Generation is advanced only after
// the caller has durably accepted and verified the corresponding checkpoint.
type Credentials struct {
	Version    int      `json:"version"`
	Origin     string   `json:"origin"`
	RoomID     string   `json:"roomId"`
	HostToken  string   `json:"hostToken"`
	EditSecret [32]byte `json:"editSecret"`
	HostSeed   [32]byte `json:"hostSeed"`
	Generation uint64   `json:"generation"`
}

func (c Credentials) validate() error {
	u, err := url.Parse(c.Origin)
	if err != nil || u.Scheme != "https" || u.Host == "" || u.User != nil || u.Path != "" || u.RawQuery != "" || u.Fragment != "" || u.String() != c.Origin || len(c.Origin) > 2048 || !roomPattern.MatchString(c.RoomID) || len(c.HostToken) < 1 || len(c.HostToken) > 1024 || c.Generation > 1<<53-1 || c.Version != 1 || c.EditSecret == [32]byte{} || c.HostSeed == [32]byte{} {
		return ErrInvalid
	}
	room, err := base64.RawURLEncoding.Strict().DecodeString(c.RoomID)
	if err != nil || len(room) != 16 || base64.RawURLEncoding.EncodeToString(room) != c.RoomID {
		return ErrInvalid
	}
	for _, b := range []byte(c.HostToken) {
		if b < 0x21 || b > 0x7e {
			return ErrInvalid
		}
	}
	return nil
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
