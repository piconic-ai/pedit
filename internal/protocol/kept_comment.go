package protocol

import (
	"encoding/binary"
	"errors"
	"fmt"
)

var keptCommentDomain = []byte("pedit kept comment update v1\x00")

// SealKeptCommentUpdate seals an update of a comments doc over the comment
// domain, signed with the commenters' key. An edit link or a comment link can;
// a read link cannot. Keep in sync with sealKeptCommentUpdate in packages/protocol.
func SealKeptCommentUpdate(keys *RoomKeys, id uint32, update []byte) ([]byte, error) {
	if keys == nil || len(update) == 0 || len(update) > MaxFrameBytes {
		return nil, errors.New("invalid kept comment update")
	}
	body := make([]byte, 4+len(update))
	binary.BigEndian.PutUint32(body, id)
	copy(body[4:], update)
	return sealKeptWith(keys, keys.CommentSigner, keys.CommentKey, keptCommentDomain, body)
}

// OpenKeptEntry opens a kept update entry and says which tier signed it:
// AccessEdit for the edit domains (id 0 for a legacy entry), or AccessComment
// for the comment domain, which the commenters' key signs. The domain is read
// first, then the signature is checked with the key of that tier. A comment
// entry must also pass CheckKeptCommentEntry before it is applied.
func OpenKeptEntry(keys *RoomKeys, frame []byte) (Access, uint32, []byte, error) {
	if keys != nil {
		if body, err := openKeptWith(keys, keys.CommentKey, keptCommentDomain, frame); err == nil {
			if len(body) <= 4 {
				return 0, 0, nil, errors.New("invalid kept comment update")
			}
			return AccessComment, binary.BigEndian.Uint32(body), body[4:], nil
		}
	}
	id, update, err := OpenKeptFileUpdate(keys, frame)
	return AccessEdit, id, update, err
}

// CheckKeptCommentEntry accepts a comment-tier entry only for a paired comments
// doc: id must be the FormatMeta entry that MetaFiles pairs with a file of the
// manifest, and check, the live room's comment check bound to that doc
// (meta.CheckUpdate), must pass the update.
func CheckKeptCommentEntry(files []FileEntry, id uint32, update []byte, check func(update []byte) error) error {
	for _, meta := range MetaFiles(files) {
		if meta == uint64(id) {
			if err := check(update); err != nil {
				return fmt.Errorf("invalid kept comments: %w", err)
			}
			return nil
		}
	}
	return errors.New("kept comment entry for a file without comments")
}
