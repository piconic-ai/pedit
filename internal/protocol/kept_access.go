package protocol

import (
	"bytes"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"encoding/binary"
	"errors"
	"regexp"
	"strings"

	"filippo.io/edwards25519"
)

var keptRoomIDPattern = regexp.MustCompile(`^[A-Za-z0-9_-]{22}$`)

type KeptLinkSecrets struct {
	Access     Access
	Secret     [32]byte
	EditKey    [32]byte
	CommentKey [32]byte
	HostKey    [32]byte
}

type KeptRoomKeys struct {
	roomID         string
	hostBinding    [32]byte
	frameBinding   [32]byte
	editBinding    [32]byte
	commentBinding [32]byte
	Access         Access
	FrameKey       []byte
	EditKey        ed25519.PublicKey
	CommentKey     ed25519.PublicKey
	HostKey        ed25519.PublicKey
	Signer         *KeptSigner
	ReadAdmission  string
	EditAdmission  string
	Fragments      map[Access]string
}

type KeptSigner struct {
	Access Access
	key    ed25519.PrivateKey
}

func GenerateKeptHostKey() (ed25519.PublicKey, ed25519.PrivateKey, error) {
	return ed25519.GenerateKey(rand.Reader)
}

func ParseKeptFragment(fragment string) (KeptLinkSecrets, error) {
	var link KeptLinkSecrets
	var body string
	var size int
	switch {
	case strings.HasPrefix(fragment, "v6.e."):
		link.Access, body, size = AccessEdit, fragment[5:], 64
	case strings.HasPrefix(fragment, "v6.c."):
		link.Access, body, size = AccessComment, fragment[5:], 96
	case strings.HasPrefix(fragment, "v6.r."):
		link.Access, body, size = AccessRead, fragment[5:], 128
	default:
		return link, errors.New("not a kept room link")
	}
	if len(body) != base64.RawURLEncoding.EncodedLen(size) {
		return KeptLinkSecrets{}, errors.New("invalid kept room link")
	}
	raw, err := base64.RawURLEncoding.Strict().DecodeString(body)
	if err != nil || len(raw) != size {
		return KeptLinkSecrets{}, errors.New("invalid kept room link")
	}
	copy(link.Secret[:], raw[:32])
	if link.Access != AccessEdit {
		copy(link.EditKey[:], raw[32:64])
	}
	if link.Access == AccessRead {
		copy(link.CommentKey[:], raw[64:96])
	}
	copy(link.HostKey[:], raw[size-32:])
	if err := link.check(); err != nil {
		return KeptLinkSecrets{}, err
	}
	return link, nil
}

func (l KeptLinkSecrets) check() error {
	if !validKeptPublicKey(l.HostKey[:]) || (l.Access == AccessComment || l.Access == AccessRead) && !validKeptPublicKey(l.EditKey[:]) || l.Access == AccessRead && !validKeptPublicKey(l.CommentKey[:]) {
		return errors.New("invalid kept room link")
	}
	if l.Access != AccessEdit && l.Access != AccessComment && l.Access != AccessRead {
		return errors.New("invalid kept room access")
	}
	return nil
}

func validKeptPublicKey(raw []byte) bool {
	point, err := new(edwards25519.Point).SetBytes(raw)
	if err != nil || !bytes.Equal(point.Bytes(), raw) || point.Equal(edwards25519.NewIdentityPoint()) == 1 {
		return false
	}
	var eightBytes [32]byte
	eightBytes[0] = 8
	eight, _ := new(edwards25519.Scalar).SetCanonicalBytes(eightBytes[:])
	inverse := new(edwards25519.Scalar).Invert(eight)
	cofactored := new(edwards25519.Point).MultByCofactor(point)
	return new(edwards25519.Point).ScalarMult(inverse, cofactored).Equal(point) == 1
}

func DeriveKeptRoomKeys(link KeptLinkSecrets, roomID string) (*KeptRoomKeys, error) {
	if err := link.check(); err != nil {
		return nil, err
	}
	if !keptRoomIDPattern.MatchString(roomID) {
		return nil, errors.New("invalid room ID")
	}
	enc := base64.RawURLEncoding.EncodeToString
	k := &KeptRoomKeys{roomID: roomID, Access: link.Access, HostKey: append(ed25519.PublicKey(nil), link.HostKey[:]...), Fragments: map[Access]string{}}
	var comment, read []byte
	editKey := link.EditKey[:]
	if link.Access == AccessEdit {
		sk := ed25519.NewKeyFromSeed(derive(link.Secret[:], "pedit v6 edit sign"))
		k.Signer = &KeptSigner{Access: AccessEdit, key: sk}
		editKey = sk.Public().(ed25519.PublicKey)
		k.EditAdmission = enc(derive(link.Secret[:], "pedit v6 edit admission"))
		comment = derive(link.Secret[:], "pedit v6 comment")
		k.Fragments[AccessEdit] = "v6.e." + enc(append(append([]byte{}, link.Secret[:]...), link.HostKey[:]...))
	} else if link.Access == AccessComment {
		comment = link.Secret[:]
	}
	commentKey := link.CommentKey[:]
	if comment != nil {
		sk := ed25519.NewKeyFromSeed(derive(comment, "pedit v6 comment sign"))
		if k.Signer == nil {
			k.Signer = &KeptSigner{Access: AccessComment, key: sk}
		}
		commentKey = sk.Public().(ed25519.PublicKey)
		read = derive(comment, "pedit v6 read")
		body := append(append(append([]byte{}, comment...), editKey...), link.HostKey[:]...)
		k.Fragments[AccessComment] = "v6.c." + enc(body)
	} else {
		read = link.Secret[:]
	}
	body := append(append(append(append([]byte{}, read...), editKey...), commentKey...), link.HostKey[:]...)
	k.Fragments[AccessRead] = "v6.r." + enc(body)
	k.EditKey, k.CommentKey = editKey, commentKey
	info := []byte("pedit v6 frame")
	var length [2]byte
	binary.BigEndian.PutUint16(length[:], uint16(len(roomID)))
	info = append(info, length[:]...)
	info = append(info, roomID...)
	info = append(info, editKey...)
	info = append(info, commentKey...)
	info = append(info, link.HostKey[:]...)
	k.FrameKey = derive(read, string(info))
	copy(k.hostBinding[:], k.HostKey)
	copy(k.frameBinding[:], k.FrameKey)
	copy(k.editBinding[:], k.EditKey)
	copy(k.commentBinding[:], k.CommentKey)
	k.ReadAdmission = enc(derive(k.FrameKey, labelReadAdmission))
	return k, nil
}
