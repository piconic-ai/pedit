package protocol

import (
	"crypto/ed25519"
	"crypto/hkdf"
	"crypto/sha256"
	"encoding/base64"
	"errors"
	"fmt"
	"regexp"
	"strings"
)

// Access is what a room link lets its holder do (#122). Each link holds a
// secret from which the ones below it are derived, one way, so a lower link
// never yields a higher one:
//
//   - AccessEdit: the edit secret S, the 32 bytes today's link holds. From
//     it, the editors' Ed25519 signing key and their admission token, and the
//     comment secret C.
//   - AccessComment: C, which gives the commenters' signing key and the read
//     secret V.
//   - AccessRead: V.
//
// The frame key K is derived from V, the room id and both verifying keys, so
// a link carrying a verifying key of someone else's choosing decrypts nothing
// in the room. A comment link carries the editors' verifying key, and a read
// link both, since neither can be derived from the secret below it. The
// reader admission token and the attachment keys come from K. Keep in sync
// with packages/protocol/src/access.ts; packages/testdata/access-vectors.json
// pins both.
type Access int

const (
	AccessRead Access = iota
	AccessComment
	AccessEdit
)

func (a Access) String() string {
	switch a {
	case AccessEdit:
		return "edit"
	case AccessComment:
		return "comment"
	default:
		return "read"
	}
}

const (
	commentPrefix = "c."
	readPrefix    = "r."

	labelEditSign      = "pedit v5 edit sign"
	labelEditAdmission = "pedit v5 edit admission"
	labelComment       = "pedit v5 comment"
	labelCommentSign   = "pedit v5 comment sign"
	labelRead          = "pedit v5 read"
	labelFrame         = "pedit v5 frame"
	labelReadAdmission = "pedit v5 read admission"
)

// fragmentPattern matches the fragment of a room link: an edit secret, or a
// marker and the secrets of a lower link.
var fragmentPattern = regexp.MustCompile(`^(?:[A-Za-z0-9_-]{43}|c\.[A-Za-z0-9_-]{86}|r\.[A-Za-z0-9_-]{128})$`)

// LinkSecrets are the secrets one link holds, decoded. Edit is set for an
// edit link, Comment for a comment link, and Read for a read link; the
// verifying keys a lower link carries are set with them.
type LinkSecrets struct {
	Access     Access
	Edit       []byte
	Comment    []byte
	Read       []byte
	EditKey    ed25519.PublicKey
	CommentKey ed25519.PublicKey
}

// RoomKeys is everything a client needs from its link, in one room.
type RoomKeys struct {
	Access Access
	// FrameKey is the AES-GCM key for frames, and the input of the attachment keys.
	FrameKey   []byte
	EditKey    ed25519.PublicKey
	CommentKey ed25519.PublicKey
	// Signer signs this client's frames; nil for a read link.
	Signer ed25519.PrivateKey
	// ReadAdmission is the relay capability of everyone in the room;
	// EditAdmission that of editors only, empty below an edit link.
	ReadAdmission string
	EditAdmission string
	// Fragments are the fragments of the links this client can hand out:
	// its own and the ones below it.
	Fragments map[Access]string
}

// GenerateEditSecret returns a new edit secret, encoded for a URL fragment.
func GenerateEditSecret() string { return GenerateKey() }

// ParseFragment reads a link's fragment, without the '#'.
func ParseFragment(fragment string) (LinkSecrets, error) {
	if !fragmentPattern.MatchString(fragment) {
		return LinkSecrets{}, errors.New("not a room link")
	}
	var access Access
	body := fragment
	switch {
	case strings.HasPrefix(fragment, commentPrefix):
		access, body = AccessComment, fragment[len(commentPrefix):]
	case strings.HasPrefix(fragment, readPrefix):
		access, body = AccessRead, fragment[len(readPrefix):]
	default:
		access = AccessEdit
	}
	raw, err := base64.RawURLEncoding.Strict().DecodeString(body)
	if err != nil {
		return LinkSecrets{}, fmt.Errorf("invalid base64url: %w", err)
	}
	switch access {
	case AccessEdit:
		return LinkSecrets{Access: access, Edit: raw}, nil
	case AccessComment:
		return LinkSecrets{Access: access, Comment: raw[:32], EditKey: raw[32:]}, nil
	default:
		return LinkSecrets{Access: access, Read: raw[:32], EditKey: raw[32:64], CommentKey: raw[64:]}, nil
	}
}

func derive(secret []byte, info string) []byte {
	out, err := hkdf.Key(sha256.New, secret, nil, info, KeyBytes)
	if err != nil {
		panic(err) // only for lengths HKDF-SHA256 cannot give
	}
	return out
}

// FrameSecret is the raw frame key of a room: what binds V to the room id and
// both verifying keys.
func FrameSecret(read []byte, roomID string, editKey, commentKey ed25519.PublicKey) []byte {
	info := make([]byte, 0, len(labelFrame)+len(roomID)+2*ed25519.PublicKeySize)
	info = append(info, labelFrame...)
	info = append(info, roomID...)
	info = append(info, editKey...)
	info = append(info, commentKey...)
	return derive(read, string(info))
}

// DeriveRoomKeys derives everything a link gives in the room with this id.
func DeriveRoomKeys(link LinkSecrets, roomID string) (*RoomKeys, error) {
	if err := link.check(); err != nil {
		return nil, err
	}
	k := &RoomKeys{Access: link.Access, Fragments: map[Access]string{}}
	enc := base64.RawURLEncoding.EncodeToString
	comment := link.Comment
	k.EditKey = link.EditKey
	if link.Access == AccessEdit {
		k.Signer = ed25519.NewKeyFromSeed(derive(link.Edit, labelEditSign))
		k.EditKey = k.Signer.Public().(ed25519.PublicKey)
		k.EditAdmission = enc(derive(link.Edit, labelEditAdmission))
		comment = derive(link.Edit, labelComment)
		k.Fragments[AccessEdit] = enc(link.Edit)
	}
	read, commentKey := link.Read, link.CommentKey
	if comment != nil {
		sk := ed25519.NewKeyFromSeed(derive(comment, labelCommentSign))
		if k.Signer == nil {
			k.Signer = sk
		}
		commentKey = sk.Public().(ed25519.PublicKey)
		read = derive(comment, labelRead)
		k.Fragments[AccessComment] = commentPrefix + enc(append(append([]byte{}, comment...), k.EditKey...))
	}
	k.CommentKey = commentKey
	k.Fragments[AccessRead] = readPrefix + enc(append(append(append([]byte{}, read...), k.EditKey...), commentKey...))
	k.FrameKey = FrameSecret(read, roomID, k.EditKey, commentKey)
	k.ReadAdmission = enc(derive(k.FrameKey, labelReadAdmission))
	return k, nil
}

func (l LinkSecrets) check() error {
	var parts [][]byte
	switch l.Access {
	case AccessEdit:
		parts = [][]byte{l.Edit}
	case AccessComment:
		parts = [][]byte{l.Comment, l.EditKey}
	case AccessRead:
		parts = [][]byte{l.Read, l.EditKey, l.CommentKey}
	default:
		return errors.New("invalid link access")
	}
	for _, p := range parts {
		if len(p) != KeyBytes {
			return errors.New("invalid link secret")
		}
	}
	return nil
}
