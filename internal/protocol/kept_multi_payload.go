package protocol

import (
	"bytes"
	"encoding/binary"
	"errors"
	"regexp"

	"github.com/reearth/ygo/crdt"
)

// This internal wire format records every manifest document and a complete
// inventory of attachment paths. Capturing a consistent snapshot and proving
// that inventory blobs exist remains the caller's responsibility.
const multiPayloadDomain = "pedit/v6/multi-checkpoint\x00"
const maxKeptAttachments = 1024

var keptAssetPath = regexp.MustCompile(`^assets/[0-9a-f]{32}\.(png|jpg|gif|webp)$`)
var errMultiPayload = errors.New("invalid multi-file checkpoint")

type KeptMultiPayload struct {
	Manifest    []FileEntry
	Documents   map[uint64][]byte
	Attachments []string
	Ledger      KeptLedger
}

func validateMultiManifest(files []FileEntry, docs map[uint64][]byte) error {
	if len(files) == 0 || len(files) != len(docs) {
		return errMultiPayload
	}
	pairs := MetaFiles(files)
	texts, metas, root := 0, 0, false
	var totalWork uint64
	for _, f := range files {
		switch f.Format {
		case FormatText:
			texts++
			if f.ID == 0 {
				root = true
			}
			if _, ok := pairs[f.ID]; !ok {
				return errMultiPayload
			}
		case FormatMeta:
			metas++
		default:
			return errMultiPayload
		}
		work, err := validateMultiDocument(docs[f.ID], f.Format == FormatText, MaxKeptYjsWork-totalWork)
		if err != nil {
			return err
		}
		totalWork += work
	}
	if !root || texts != metas {
		return errMultiPayload
	}
	return nil
}

func validateMultiDocument(update []byte, content bool, remaining uint64) (uint64, error) {
	if len(update) == 0 || len(update) > maxKeptCheckpointPayload {
		return 0, errMultiPayload
	}
	work, err := keptCheckpointWork(update, content)
	if err != nil || work > remaining || !validKeptYjsUpdateWithAssets(update, content, true) {
		return 0, errMultiPayload
	}
	return work, nil
}

func validateMultiAttachments(files []FileEntry, docs map[uint64][]byte, paths []string) error {
	if paths == nil || len(paths) > maxKeptAttachments {
		return errMultiPayload
	}
	available := make(map[string]bool, len(paths))
	for i, path := range paths {
		if !keptAssetPath.MatchString(path) || (i > 0 && paths[i-1] >= path) {
			return errMultiPayload
		}
		available[path] = true
	}
	for _, f := range files {
		if f.Format != FormatText {
			continue
		}
		doc := crdt.New()
		err := crdt.ApplyUpdateV1(doc, docs[f.ID], nil)
		if err != nil {
			doc.Destroy()
			return errMultiPayload
		}
		text := doc.GetText("content").ToString()
		doc.Destroy()
		for _, path := range keptAssetReference.FindAllString(text, -1) {
			if !available[path] {
				return errMultiPayload
			}
		}
	}
	return nil
}

func appendMultiPart(dst, part []byte) ([]byte, error) {
	if len(part) == 0 || len(part) > maxKeptCheckpointPayload-4-len(dst) {
		return nil, errMultiPayload
	}
	dst = binary.BigEndian.AppendUint32(dst, uint32(len(part)))
	return append(dst, part...), nil
}

func EncodeKeptMultiPayload(value KeptMultiPayload) ([]byte, error) {
	manifest, err := EncodeManifest(value.Manifest)
	if err != nil || validateMultiManifest(value.Manifest, value.Documents) != nil || validateMultiAttachments(value.Manifest, value.Documents, value.Attachments) != nil {
		return nil, errMultiPayload
	}
	ledger, err := EncodeKeptLedger(value.Ledger)
	if err != nil {
		return nil, errMultiPayload
	}
	out := append([]byte(multiPayloadDomain), 0)
	out, err = appendMultiPart(out, manifest)
	if err != nil {
		return nil, err
	}
	// Documents follow manifest order; the manifest binds each state to its ID.
	for _, f := range value.Manifest {
		out, err = appendMultiPart(out, value.Documents[f.ID])
		if err != nil {
			return nil, err
		}
	}
	out = binary.BigEndian.AppendUint32(out, uint32(len(value.Attachments)))
	for _, path := range value.Attachments {
		out, err = appendMultiPart(out, []byte(path))
		if err != nil {
			return nil, err
		}
	}
	return appendMultiPart(out, ledger)
}

func DecodeKeptMultiPayload(data []byte, ledgerLimit int) (KeptMultiPayload, error) {
	var out KeptMultiPayload
	if len(data) > maxKeptCheckpointPayload || len(data) < len(multiPayloadDomain)+1 || !bytes.Equal(data[:len(multiPayloadDomain)], []byte(multiPayloadDomain)) || data[len(multiPayloadDomain)] != 0 {
		return out, errMultiPayload
	}
	at := len(multiPayloadDomain) + 1
	read := func() ([]byte, error) {
		if len(data)-at < 4 {
			return nil, errMultiPayload
		}
		n := binary.BigEndian.Uint32(data[at:])
		at += 4
		if n == 0 || uint64(n) > uint64(len(data)-at) {
			return nil, errMultiPayload
		}
		part := data[at : at+int(n)]
		at += int(n)
		return part, nil
	}
	raw, err := read()
	if err != nil {
		return out, err
	}
	msg, err := DecodeFiles(raw)
	if err != nil || msg.Kind != FilesManifest {
		return out, errMultiPayload
	}
	canonical, err := EncodeManifest(msg.Files)
	if err != nil || !bytes.Equal(raw, canonical) {
		return out, errMultiPayload
	}
	out.Manifest = msg.Files
	out.Documents = make(map[uint64][]byte, len(msg.Files))
	for _, f := range msg.Files {
		part, e := read()
		if e != nil {
			return KeptMultiPayload{}, e
		}
		out.Documents[f.ID] = bytes.Clone(part)
	}
	if len(data)-at < 4 {
		return KeptMultiPayload{}, errMultiPayload
	}
	count := binary.BigEndian.Uint32(data[at:])
	at += 4
	if count > maxKeptAttachments {
		return KeptMultiPayload{}, errMultiPayload
	}
	out.Attachments = make([]string, 0, count)
	for range count {
		part, e := read()
		if e != nil {
			return KeptMultiPayload{}, e
		}
		out.Attachments = append(out.Attachments, string(part))
	}
	raw, err = read()
	if err != nil || at != len(data) {
		return KeptMultiPayload{}, errMultiPayload
	}
	out.Ledger, err = DecodeKeptLedger(ledgerLimit, raw)
	if err != nil || validateMultiManifest(out.Manifest, out.Documents) != nil || validateMultiAttachments(out.Manifest, out.Documents, out.Attachments) != nil {
		return KeptMultiPayload{}, errMultiPayload
	}
	return out, nil
}
