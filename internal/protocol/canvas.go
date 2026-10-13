package protocol

import (
	"errors"
	"fmt"
	"unicode/utf8"

	"github.com/reearth/ygo/encoding"
)

// CanvasKind says what a canvas message is about.
type CanvasKind uint64

// Canvas messages carry JSON someone edited by hand in a canvas room. The
// browser does not change the shared structure itself: it sends what it
// started from and what it made, and the host applies the change the way it
// applies an edit to the file made outside pedit.
const (
	// CanvasEdit: someone changed the canvas from Base to Next, both JSON Canvas text.
	CanvasEdit CanvasKind = 0
	// CanvasApplied: the host applied the edit with this ID.
	CanvasApplied CanvasKind = 1
	// CanvasRejected: the host did not apply the edit with this ID, for Reason.
	CanvasRejected CanvasKind = 2
)

// Limits in UTF-8 bytes, the same as the web client's. An edit carries two
// copies of the canvas and must fit in one relayed frame (MaxFrameBytes).
const (
	MaxCanvasEditBytes = 960 << 10
	maxCanvasID        = 64
	maxCanvasReason    = 16 << 10
)

// CanvasMessage is one canvas message. Which fields are set depends on Kind:
// Edit has ID, Base and Next, Applied has ID, Rejected has ID and Reason.
//
// An edit's ID must be unique within the room, such as a random one: the
// host applies an ID once and answers a repeat, sent again after a
// reconnect, without applying it, so two guests sharing an ID would lose
// the second edit.
type CanvasMessage struct {
	Kind   CanvasKind
	ID     string
	Base   string
	Next   string
	Reason string
}

// ErrUnknownCanvasKind marks a canvas kind this version does not know, from a
// newer peer. Clients skip such messages instead of reporting them.
var ErrUnknownCanvasKind = errors.New("unknown canvas kind")

var errCanvasTruncated = errors.New("truncated canvas message")

func EncodeCanvas(m CanvasMessage) ([]byte, error) {
	if err := m.validate(); err != nil {
		return nil, err
	}
	enc := encoding.NewEncoder()
	enc.WriteVarUint(uint64(m.Kind))
	writeString := func(s string) { enc.WriteVarBytes([]byte(s)) }
	writeString(m.ID)
	switch m.Kind {
	case CanvasEdit:
		writeString(m.Base)
		writeString(m.Next)
	case CanvasRejected:
		writeString(m.Reason)
	}
	return enc.Bytes(), nil
}

// DecodeCanvas fails on malformed payloads, and with ErrUnknownCanvasKind on
// kinds this version does not know.
func DecodeCanvas(payload []byte) (CanvasMessage, error) {
	dec := encoding.NewDecoder(payload)
	var err error
	readString := func() string {
		if err != nil {
			return ""
		}
		var b []byte
		if b, err = dec.ReadVarBytes(); err != nil {
			err = errCanvasTruncated
			return ""
		}
		return string(b) // validate checks UTF-8
	}
	kind, kerr := dec.ReadVarUint()
	if kerr != nil {
		return CanvasMessage{}, errCanvasTruncated
	}
	m := CanvasMessage{Kind: CanvasKind(kind)}
	switch m.Kind {
	case CanvasEdit:
		m.ID, m.Base, m.Next = readString(), readString(), readString()
	case CanvasApplied:
		m.ID = readString()
	case CanvasRejected:
		m.ID, m.Reason = readString(), readString()
	default:
		return CanvasMessage{}, fmt.Errorf("%w: %d", ErrUnknownCanvasKind, kind)
	}
	if err != nil {
		return CanvasMessage{}, err
	}
	if dec.HasContent() {
		return CanvasMessage{}, errors.New("trailing bytes in canvas message")
	}
	if err := m.validate(); err != nil {
		return CanvasMessage{}, err
	}
	return m, nil
}

func (m CanvasMessage) validate() error {
	if len(m.ID) == 0 || len(m.ID) > maxCanvasID || !utf8.ValidString(m.ID) {
		return errors.New("invalid canvas message id")
	}
	switch m.Kind {
	case CanvasEdit:
		if len(m.Base)+len(m.Next) > MaxCanvasEditBytes {
			return errors.New("canvas edit too large")
		}
		if !utf8.ValidString(m.Base) || !utf8.ValidString(m.Next) {
			return errors.New("canvas edit is not UTF-8")
		}
		return nil
	case CanvasApplied:
		return nil
	case CanvasRejected:
		if len(m.Reason) == 0 || len(m.Reason) > maxCanvasReason || !utf8.ValidString(m.Reason) {
			return errors.New("invalid reason")
		}
		return nil
	}
	return fmt.Errorf("unknown canvas kind: %d", m.Kind)
}
