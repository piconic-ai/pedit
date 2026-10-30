package protocol

import (
	"encoding/binary"
	"strconv"
	"strings"
)

// Protocol version 6 starts every binary WebSocket message with one plaintext
// byte, the kind. The relay reads only this byte; the payload after it is as
// it was in version 5 (docs/design/rooms-away.md). Keep these equal to Kind in
// packages/protocol/src/kinds.ts.
const (
	// KindLive is a frame, any peer to the relay and on to every other peer.
	KindLive byte = 0
	// KindEntry is one kept-text entry, an editor to the relay. While the
	// host is present the relay passes it on unchanged.
	KindEntry byte = 1
	// KindSnapshot is a kept bundle, the host to the relay: the room's snapshot.
	KindSnapshot byte = 2
	// KindCheckpoint is a uint64 cutoff and a kept bundle, the host to the relay.
	KindCheckpoint byte = 3
	// KindLogged is a uint64 id and an entry, the relay to a peer: a log entry.
	KindLogged byte = 4
	// KindReplay is a kept bundle, the relay to a peer that joins or the host that returns.
	KindReplay byte = 5
	// KindLogEnd is a uint64 tail, the relay to a peer: the replay is over.
	KindLogEnd byte = 6
)

// The texts the relay adds in version 6. Keep them equal to relayTextsV6 in
// packages/testdata/close-codes.json.
const (
	// Kept is "kept <until-ms>": the host left and the room is kept until then.
	Kept = "kept"
	// Keep is "keep <seconds> <until-ms>", sent to the host: the keep the relay will honour.
	Keep = "keep"
	// Checkpoint is "checkpoint <cutoff> <tail>", the answer to a checkpoint.
	Checkpoint        = "checkpoint"
	CheckpointRefused = "checkpoint refused"
	// LogFull answers an entry the log has no room for.
	LogFull = "log full"
)

// KeepHeader and AfterHeader are the host's request headers: the keep it asks
// for in seconds, and the last log entry it holds.
const (
	KeepHeader  = "X-Pedit-Keep"
	AfterHeader = "X-Pedit-After"
)

// WithKind is a message of this kind: the kind byte, then the parts.
func WithKind(kind byte, parts ...[]byte) []byte {
	out := []byte{kind}
	for _, part := range parts {
		out = append(out, part...)
	}
	return out
}

// SplitKind splits a message into its kind and the payload after it.
func SplitKind(data []byte) (kind byte, payload []byte, ok bool) {
	if len(data) == 0 {
		return 0, nil, false
	}
	return data[0], data[1:], true
}

func encodeUint64(n uint64) []byte { return binary.BigEndian.AppendUint64(nil, n) }

// EncodeCheckpoint is a kind 3 message: the entries up to cutoff are in bundle.
func EncodeCheckpoint(cutoff uint64, bundle []byte) []byte {
	return WithKind(KindCheckpoint, encodeUint64(cutoff), bundle)
}

// EncodeLogged is a kind 4 message, as the relay sends it.
func EncodeLogged(id uint64, entry []byte) []byte {
	return WithKind(KindLogged, encodeUint64(id), entry)
}

// DecodeLogged reads the id and entry of a kind 4 payload.
func DecodeLogged(payload []byte) (id uint64, entry []byte, ok bool) {
	if len(payload) < 8 {
		return 0, nil, false
	}
	return binary.BigEndian.Uint64(payload), payload[8:], true
}

// DecodeLogEnd reads the tail of a kind 6 payload.
func DecodeLogEnd(payload []byte) (tail uint64, ok bool) {
	if len(payload) != 8 {
		return 0, false
	}
	return binary.BigEndian.Uint64(payload), true
}

// EncodeLogEnd is a kind 6 message, as the relay sends it.
func EncodeLogEnd(tail uint64) []byte { return WithKind(KindLogEnd, encodeUint64(tail)) }

// words are the count words after word in a relay text such as "keep 86400 0",
// or nil if the text is not word followed by exactly count of them.
func words(word, text string, count int) []string {
	rest, ok := strings.CutPrefix(text, word+" ")
	if parts := strings.Split(rest, " "); ok && len(parts) == count {
		return parts
	}
	return nil
}

// ParseKept reads "kept <until-ms>".
func ParseKept(text string) (until int64, ok bool) {
	w := words(Kept, text, 1)
	if w == nil {
		return 0, false
	}
	until, err := strconv.ParseInt(w[0], 10, 64)
	return until, err == nil && until >= 0
}

// ParseKeep reads "keep <seconds> <until-ms>".
func ParseKeep(text string) (seconds, until int64, ok bool) {
	w := words(Keep, text, 2)
	if w == nil {
		return 0, 0, false
	}
	seconds, err1 := strconv.ParseInt(w[0], 10, 64)
	until, err2 := strconv.ParseInt(w[1], 10, 64)
	return seconds, until, err1 == nil && err2 == nil && seconds >= 0 && until >= 0
}

// ParseCheckpoint reads "checkpoint <cutoff> <tail>".
func ParseCheckpoint(text string) (cutoff, tail uint64, ok bool) {
	w := words(Checkpoint, text, 2)
	if w == nil {
		return 0, 0, false
	}
	cutoff, err1 := strconv.ParseUint(w[0], 10, 64)
	tail, err2 := strconv.ParseUint(w[1], 10, 64)
	return cutoff, tail, err1 == nil && err2 == nil
}
