package protocol

import (
	"crypto/ed25519"
	"errors"
	"fmt"

	"github.com/reearth/ygo/encoding"
	ysync "github.com/reearth/ygo/sync"
)

// Editors and commenters sign every frame they send (#122); peers with a
// read link cannot, and send plain messages. A signed message is
//
//	MessageSigned || tier || signature || message
//
// where message is the type byte and payload (EncodeMessage) and tier says
// which key signed it: 0 the editors', 1 the commenters'. The signature,
// Ed25519, covers a context string, the tier, the frame's sender and
// counter, and message, so a signed message cannot be moved to another frame
// or tier, and a frame replayed from a signer is one a receiver drops
// (replayGuard). The signature sits inside the encryption: the relay sees
// none of it. Every peer checks it before reading the message, and what a
// frame may do follows from the tier that verified, never from the message.
// Keep in sync with packages/protocol/src/signed.ts.
const (
	MessageSigned  MessageType = 5
	signedOverhead             = 2 + ed25519.SignatureSize
	signContext                = "pedit v5 frame sig"
)

var tiers = [...]Access{AccessEdit, AccessComment}

// ErrBadSignature marks a signed message whose signature does not verify, or
// that names no tier.
var ErrBadSignature = errors.New("frame signature does not verify")

// ErrNotAllowed marks a frame its sender's access does not allow: a write
// from a peer that may only read what it writes to, or a message only editors
// send. It is dropped.
var ErrNotAllowed = errors.New("not allowed for the sender's access")

func notAllowed(what string, access Access) error {
	return fmt.Errorf("dropped %s from a peer with %s access: %w", what, access, ErrNotAllowed)
}

func tierOf(access Access) byte {
	if access == AccessComment {
		return 1
	}
	return 0
}

func signingInput(tier byte, header, message []byte) []byte {
	out := make([]byte, 0, len(signContext)+1+len(header)+len(message))
	out = append(out, signContext...)
	out = append(out, tier)
	out = append(out, header...)
	return append(out, message...)
}

// signMessage signs message for the frame whose sender and counter are
// header (EncodeFrame's first bytes), and returns what the frame carries.
func signMessage(signer ed25519.PrivateKey, access Access, header, message []byte) []byte {
	tier := tierOf(access)
	out := make([]byte, signedOverhead, signedOverhead+len(message))
	out[0] = byte(MessageSigned)
	out[1] = tier
	copy(out[2:], ed25519.Sign(signer, signingInput(tier, header, message)))
	return append(out, message...)
}

// openMessage reads what a frame carries: a signed message, checked against
// the key of the tier it names, or a plain one, which speaks for a read link.
// It returns the access the message speaks for, and the message.
func (k *RoomKeys) openMessage(header, data []byte) (Access, []byte, error) {
	if len(data) == 0 || MessageType(data[0]) != MessageSigned {
		return AccessRead, data, nil
	}
	if len(data) <= signedOverhead || int(data[1]) >= len(tiers) {
		return 0, nil, ErrBadSignature
	}
	access := tiers[data[1]]
	key := k.EditKey
	if access == AccessComment {
		key = k.CommentKey
	}
	message := data[signedOverhead:]
	if !ed25519.Verify(key, signingInput(data[1], header, message), data[2:signedOverhead]) {
		return 0, nil, ErrBadSignature
	}
	return access, message, nil
}

// mayWrite tells whether a peer with this access writes a doc that
// commenters write if comments is set.
func mayWrite(access Access, comments bool) bool {
	return access == AccessEdit || access == AccessComment && comments
}

// allowSync lets a sync message through only if it is a request for what
// the sender is missing (SyncStep1), unless the sender may write the doc:
// anyone in the room needs to receive the doc, but only its writers change it.
func allowSync(payload []byte, writes bool, access Access) error {
	if writes {
		return nil
	}
	kind, err := encoding.NewDecoder(payload).ReadVarUint()
	if err != nil {
		return notAllowed("a sync message", access)
	}
	if kind != ysync.MsgSyncStep1 {
		return notAllowed("an update", access)
	}
	return nil
}

// editorsOnly refuses a message that only editors may send, from anyone else.
func editorsOnly(what string, access Access) error {
	if access != AccessEdit {
		return notAllowed(what, access)
	}
	return nil
}

// allowAttachment refuses an attachment message of a kind only editors send,
// from anyone else: everyone may ask for attachments (want), which they need
// to see the images.
func allowAttachment(a Attachment, access Access) error {
	if a.Kind == AttachmentWant {
		return nil
	}
	return editorsOnly(fmt.Sprintf("an attachment message of kind %d", a.Kind), access)
}
