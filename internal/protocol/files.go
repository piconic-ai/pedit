package protocol

import (
	"errors"
	"fmt"
	"regexp"

	"github.com/reearth/ygo/encoding"
)

// MessageFiles carries the files of a room that shares several (#113). Each
// file is a Y.Doc of its own: one doc for all would put every file under the
// one frame its state is sent in. Older peers skip this type, so a room that
// shares one file, which never sends it, works as before.
const MessageFiles MessageType = 4

// FilesKind says what a files message is about.
type FilesKind uint64

const (
	// FilesManifest: the host's list of the room's files. It replaces any
	// list sent before.
	FilesManifest FilesKind = 0
	// FilesDoc: a sync, attachment or canvas message, as it would be sent in
	// a room that shares one file, for the file with ID File.
	FilesDoc FilesKind = 1
)

// The formats a shared file has. A peer leaves out a file of a format it
// does not know.
const (
	FormatText   = "text"
	FormatCanvas = "canvas"
)

// Limits on a manifest. The host shares fewer files than MaxFiles; this only
// bounds what a peer accepts.
const (
	MaxFiles  = 64
	MaxFileID = 1<<32 - 1
)

var formatPattern = regexp.MustCompile(`^[a-z][a-z0-9-]{0,31}$`)

// FileEntry is one file in a manifest. The host gives each file an ID that
// it never reuses in the room, and only ever routes a message by the ID it
// carries: Path is for people to read, and checked with CheckPath.
type FileEntry struct {
	ID     uint64
	Path   string
	Format string
}

// FilesMessage is one files message. Manifest has Files; Doc has File, and
// Type and Payload as DecodeMessage returns them.
type FilesMessage struct {
	Kind    FilesKind
	Files   []FileEntry
	File    uint64
	Type    MessageType
	Payload []byte
}

// ErrUnknownFilesKind marks a files kind this version does not know, from a
// newer peer. Clients skip such messages instead of reporting them.
var ErrUnknownFilesKind = errors.New("unknown files kind")

var errFilesTruncated = errors.New("truncated files message")

// EncodeManifest encodes the list of a room's files.
func EncodeManifest(files []FileEntry) ([]byte, error) {
	if err := validateManifest(files); err != nil {
		return nil, err
	}
	enc := encoding.NewEncoder()
	enc.WriteVarUint(uint64(FilesManifest))
	enc.WriteVarUint(uint64(len(files)))
	for _, f := range files {
		enc.WriteVarUint(f.ID)
		enc.WriteVarBytes([]byte(f.Path))
		enc.WriteVarBytes([]byte(f.Format))
	}
	return enc.Bytes(), nil
}

// EncodeFileDoc wraps a sync, attachment or canvas payload for one file.
func EncodeFileDoc(file uint64, t MessageType, payload []byte) ([]byte, error) {
	if err := validateDoc(file, t); err != nil {
		return nil, err
	}
	enc := encoding.NewEncoder()
	enc.WriteVarUint(uint64(FilesDoc))
	enc.WriteVarUint(file)
	return append(enc.Bytes(), EncodeMessage(t, payload)...), nil
}

// DecodeFiles fails on malformed payloads, with ErrUnknownFilesKind on kinds
// this version does not know, and with ErrUnknownMessageType on a doc message
// of a type it does not know.
func DecodeFiles(payload []byte) (FilesMessage, error) {
	dec := encoding.NewDecoder(payload)
	var err error
	readUint := func() uint64 {
		if err != nil {
			return 0
		}
		var v uint64
		if v, err = dec.ReadVarUint(); err != nil {
			err = errFilesTruncated
		}
		return v
	}
	readString := func() string {
		if err != nil {
			return ""
		}
		var b []byte
		if b, err = dec.ReadVarBytes(); err != nil {
			err = errFilesTruncated
			return ""
		}
		return string(b) // validated below
	}

	m := FilesMessage{Kind: FilesKind(readUint())}
	if err != nil {
		return FilesMessage{}, err
	}
	switch m.Kind {
	case FilesManifest:
		n := readUint()
		if err == nil && n > MaxFiles {
			return FilesMessage{}, errors.New("too many files")
		}
		for i := uint64(0); i < n && err == nil; i++ {
			m.Files = append(m.Files, FileEntry{ID: readUint(), Path: readString(), Format: readString()})
		}
		if err != nil {
			return FilesMessage{}, err
		}
		if dec.HasContent() {
			return FilesMessage{}, errors.New("trailing bytes in files message")
		}
		if err := validateManifest(m.Files); err != nil {
			return FilesMessage{}, err
		}
	case FilesDoc:
		m.File = readUint()
		if err != nil {
			return FilesMessage{}, err
		}
		if m.Type, m.Payload, err = DecodeMessage(dec.RemainingBytes()); err != nil {
			return FilesMessage{}, err
		}
		if err := validateDoc(m.File, m.Type); err != nil {
			return FilesMessage{}, err
		}
	default:
		return FilesMessage{}, fmt.Errorf("%w: %d", ErrUnknownFilesKind, m.Kind)
	}
	return m, nil
}

func validateManifest(files []FileEntry) error {
	if len(files) > MaxFiles {
		return errors.New("too many files")
	}
	ids := make(map[uint64]bool, len(files))
	paths := make(map[string]bool, len(files))
	for _, f := range files {
		if f.ID > MaxFileID || ids[f.ID] {
			return fmt.Errorf("invalid file id %d", f.ID)
		}
		if err := CheckPath(f.Path); err != nil {
			return fmt.Errorf("file %d: %w", f.ID, err)
		}
		if paths[f.Path] {
			return fmt.Errorf("file %d: path listed twice", f.ID)
		}
		if !formatPattern.MatchString(f.Format) {
			return fmt.Errorf("file %d: invalid format", f.ID)
		}
		ids[f.ID], paths[f.Path] = true, true
	}
	return nil
}

func validateDoc(file uint64, t MessageType) error {
	if file > MaxFileID {
		return fmt.Errorf("invalid file id %d", file)
	}
	switch t {
	case MessageSync, MessageAttachment, MessageCanvas:
		return nil
	}
	return fmt.Errorf("a %d message cannot be about a file", t)
}
