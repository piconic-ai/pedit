package protocol

import (
	"errors"
	"fmt"
)

type MessageType byte

const (
	MessageSync       MessageType = 0
	MessageAwareness  MessageType = 1
	MessageAttachment MessageType = 2
	MessageCanvas     MessageType = 3
)

// RoomClosed is the WebSocket close code sent to everyone in a room when its
// host leaves. Clients must not reconnect on it: the session is over.
const RoomClosed = 4001

// ClientOutdated is the WebSocket close code for a client that speaks an older
// protocol version than the server. Clients must not reconnect on it: pedit
// has to be updated first.
const ClientOutdated = 4002

// ServerOutdated is the WebSocket close code for a client that speaks a newer
// protocol version than the server. Clients must not reconnect on it: the
// server has to be updated.
const ServerOutdated = 4003

// RoomFull is the WebSocket close code sent to a guest who tries to join a
// room that already has as many guests as the relay allows. Clients must not
// reconnect on it by themselves: the room stays full until someone leaves.
const RoomFull = 4004

// RelayBusy is the WebSocket close code for a connection the relay turns away
// because too many came from the same network just now. Clients reconnect, but
// wait longer than after a dropped connection.
const RelayBusy = 4005

// RelayMaintenance is the WebSocket close code for a connection to a relay
// closed for maintenance. Clients must not reconnect on it by themselves:
// whoever was editing decides whether to pick the session up again.
const RelayMaintenance = 4006

// RoomExpired is the WebSocket close code sent to everyone in a room that
// reached the relay's time limit, counted from its host's first connection,
// and to anyone who connects to it afterwards (the reason names the limit,
// see ExpiredReason). Clients must not reconnect on
// it: the room ID is never reopened; the host starts a new room.
const RoomExpired = 4007

// MessageTooBig is the WebSocket close code (the standard 1009) the relay
// sends a connection whose frame is over MaxFrameBytes. Clients must not
// reconnect on it: they would send the same frame again.
const MessageTooBig = 1009

// MaxFrameBytes is the most bytes one frame may have on the wire: one
// WebSocket message, encrypted. The relay closes a connection that sends a
// larger one with MessageTooBig, and Client never sends one. Keep it equal to
// MAX_FRAME_BYTES in packages/protocol, which the relay uses.
const MaxFrameBytes = 1 << 20

// FrameOverhead is what a frame adds to its payload: the message type byte,
// and AES-GCM's IV and tag.
const FrameOverhead = 1 + ivBytes + tagBytes // 29

// FrameBytes is the size on the wire of a frame carrying payload bytes.
func FrameBytes(payload int) int { return payload + FrameOverhead }

// ErrFrameTooLarge means a frame the Client had to send is over
// MaxFrameBytes: the document grew too large to share.
var ErrFrameTooLarge = errors.New("frame too large for the relay")

// ErrUnknownMessageType marks a message type this version does not know, from
// a newer peer. Clients skip such messages instead of reporting them.
var ErrUnknownMessageType = errors.New("unknown message type")

// EncodeMessage prefixes a payload with a one-byte message type.
func EncodeMessage(t MessageType, payload []byte) []byte {
	out := make([]byte, 1+len(payload))
	out[0] = byte(t)
	copy(out[1:], payload)
	return out
}

func DecodeMessage(data []byte) (MessageType, []byte, error) {
	if len(data) == 0 {
		return 0, nil, fmt.Errorf("empty message")
	}
	t := MessageType(data[0])
	switch t {
	case MessageSync, MessageAwareness, MessageAttachment, MessageCanvas:
		return t, data[1:], nil
	}
	return 0, nil, fmt.Errorf("%w: %d", ErrUnknownMessageType, data[0])
}
