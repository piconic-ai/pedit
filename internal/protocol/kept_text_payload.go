package protocol

import (
	"bytes"
	"encoding/binary"
	"errors"
	"regexp"

	"github.com/reearth/ygo/crdt"
)

const textPayloadDomain = "pedit/v6/text-checkpoint\x00"

var keptAssetReference = regexp.MustCompile(`assets/[0-9a-f]{32}\.(png|jpg|gif|webp)`)

func validKeptYjsUpdate(update []byte, content bool) bool {
	return validKeptYjsUpdateWithAssets(update, content, false)
}

func keptCheckpointWork(update []byte, content bool) (uint64, error) {
	if content {
		return KeptTextWork(update, false)
	}
	return KeptCommentsWork(update, false)
}

func validKeptYjsUpdateWithAssets(update []byte, content, allowAssets bool) (valid bool) {
	work, err := keptCheckpointWork(update, content)
	if err != nil || work > MaxKeptYjsWork {
		return false
	}
	defer func() {
		if recover() != nil {
			valid = false
		}
	}()
	doc := crdt.New()
	defer doc.Destroy()
	if crdt.ApplyUpdateV1(doc, update, nil) != nil {
		return false
	}
	pending := doc.PendingStats()
	if pending.Items != 0 || pending.DeleteRanges != 0 || len(doc.GetSubdocs()) != 0 {
		return false
	}
	return !content || allowAssets || !keptAssetReference.MatchString(doc.GetText("content").ToString())
}

type KeptAttachmentInventory uint8

const (
	KeptAttachmentsUnverified KeptAttachmentInventory = iota
	KeptAttachmentsNone
	KeptAttachmentsPresent
)

type KeptTextPayload struct {
	Manifest    []FileEntry
	Documents   map[uint64][]byte
	Ledger      KeptLedger
	Attachments KeptAttachmentInventory
}

func validTextManifest(files []FileEntry) bool {
	if len(files) != 2 {
		return false
	}
	var text, meta *FileEntry
	for i := range files {
		f := &files[i]
		if f.ID == 0 && f.Format == FormatText {
			text = f
		} else if f.ID > 0 && f.Format == FormatMeta {
			meta = f
		} else {
			return false
		}
	}
	return text != nil && meta != nil && meta.Path == MetaPath(text.Path)
}

// EncodeKeptTextPayload requires a complete attachment inventory and full Yjs
// updates captured consistently with the ledger. It does not inspect attachments
// or coordinate document snapshots; callers must do both before publication.
func EncodeKeptTextPayload(value KeptTextPayload) ([]byte, error) {
	bad := errors.New("unsupported or invalid text checkpoint")
	if value.Attachments != KeptAttachmentsNone || !validTextManifest(value.Manifest) || len(value.Documents) != 2 {
		return nil, bad
	}
	manifest, err := EncodeManifest(value.Manifest)
	if err != nil {
		return nil, bad
	}
	var metaID uint64
	for _, f := range value.Manifest {
		if f.Format == FormatMeta {
			metaID = f.ID
		}
	}
	text, ok := value.Documents[0]
	if !ok || len(text) == 0 {
		return nil, bad
	}
	meta, ok := value.Documents[metaID]
	if !ok || len(meta) == 0 {
		return nil, bad
	}
	if len(text) > maxKeptCheckpointPayload || len(meta) > maxKeptCheckpointPayload || !validKeptYjsUpdate(text, true) || !validKeptYjsUpdate(meta, false) {
		return nil, bad
	}
	ledger, err := EncodeKeptLedger(value.Ledger)
	if err != nil {
		return nil, bad
	}
	parts := [][]byte{manifest, text, meta, ledger}
	size := len(textPayloadDomain) + 1 + 4*len(parts)
	for _, p := range parts {
		if len(p) > maxKeptCheckpointPayload-size {
			return nil, bad
		}
		size += len(p)
	}
	out := make([]byte, size)
	at := copy(out, textPayloadDomain)
	out[at] = 0
	at++
	for _, p := range parts {
		binary.BigEndian.PutUint32(out[at:], uint32(len(p)))
		at += 4
		at += copy(out[at:], p)
	}
	return out, nil
}

// DecodeKeptTextPayload only parses an authenticated checkpoint payload.
// Permission, complete attachment inventory, and atomic recovery are external.
func DecodeKeptTextPayload(data []byte, ledgerLimit int) (KeptTextPayload, error) {
	var result KeptTextPayload
	bad := errors.New("invalid text checkpoint")
	if len(data) > maxKeptCheckpointPayload || len(data) < len(textPayloadDomain)+1+16 || !bytes.Equal(data[:len(textPayloadDomain)], []byte(textPayloadDomain)) || data[len(textPayloadDomain)] != 0 {
		return result, bad
	}
	at := len(textPayloadDomain) + 1
	parts := make([][]byte, 0, 4)
	for range 4 {
		if len(data)-at < 4 {
			return result, bad
		}
		n := binary.BigEndian.Uint32(data[at:])
		at += 4
		if n == 0 || uint64(n) > uint64(len(data)-at) {
			return result, bad
		}
		parts = append(parts, data[at:at+int(n)])
		at += int(n)
	}
	if at != len(data) {
		return result, bad
	}
	msg, err := DecodeFiles(parts[0])
	if err != nil || msg.Kind != FilesManifest || !validTextManifest(msg.Files) {
		return result, bad
	}
	canonical, err := EncodeManifest(msg.Files)
	if err != nil || !bytes.Equal(canonical, parts[0]) {
		return result, bad
	}
	if !validKeptYjsUpdate(parts[1], true) || !validKeptYjsUpdate(parts[2], false) {
		return result, bad
	}
	ledger, err := DecodeKeptLedger(ledgerLimit, parts[3])
	if err != nil {
		return result, bad
	}
	var id uint64
	for _, f := range msg.Files {
		if f.Format == FormatMeta {
			id = f.ID
		}
	}
	return KeptTextPayload{Manifest: msg.Files, Documents: map[uint64][]byte{0: bytes.Clone(parts[1]), id: bytes.Clone(parts[2])}, Ledger: ledger, Attachments: KeptAttachmentsNone}, nil
}
