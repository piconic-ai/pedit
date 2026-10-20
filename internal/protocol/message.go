package protocol

import (
	"crypto/rand"
	"encoding/binary"
	"errors"
	"fmt"
	"sync"
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

// HostLeft is the WebSocket close code a host sends when it ends the session
// on purpose, as on Ctrl+C. The relay then closes the room at once (with
// RoomClosed for everyone else), where a host that drops gets a grace period
// to come back.
const HostLeft = 4008

// HostAway and HostBack are the text frames the relay itself sends guests,
// the only frames not from a peer and not encrypted: the host dropped and the
// relay waits for it to come back, or it came back. Guests do not edit while
// the host is away: nobody would save what they wrote. Keep them equal to
// HOST_AWAY and HOST_BACK in packages/protocol.
const (
	HostAway = "host away"
	HostBack = "host back"
)

// RelayPing and RelayPong check that the room still has a connection: a
// client sends RelayPing as a text frame, and the room's Durable Object
// answers RelayPong itself, without waking up. A WebSocket ping does not
// tell as much: Cloudflare's edge answers it even when the room has lost the
// connection. Keep them equal to RELAY_PING and RELAY_PONG in
// packages/protocol.
const (
	RelayPing = "pedit ping"
	RelayPong = "pedit pong"
)

// MessageTooBig is the WebSocket close code (the standard 1009) the relay
// sends a connection whose frame is over MaxFrameBytes. Clients must not
// reconnect on it: they would send the same frame again.
const MessageTooBig = 1009

// MaxFrameBytes is the most bytes one frame may have on the wire: one
// WebSocket message, encrypted. The relay closes a connection that sends a
// larger one with MessageTooBig, and Client never sends one. Keep it equal to
// MAX_FRAME_BYTES in packages/protocol, which the relay uses.
const MaxFrameBytes = 1 << 20

// FrameOverhead is what a frame adds to its payload: the sender and counter
// (EncodeFrame), the message type byte, and AES-GCM's IV and tag.
const FrameOverhead = frameHeaderBytes + 1 + ivBytes + tagBytes // 53

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
	case MessageSync, MessageAwareness, MessageAttachment, MessageCanvas, MessageFiles:
		return t, data[1:], nil
	}
	return 0, nil, fmt.Errorf("%w: %d", ErrUnknownMessageType, data[0])
}

// A frame encrypts `sender || counter || message`. The relay could otherwise
// send a frame again, and a canvas edit applied twice is not the same as once
// (Yjs updates and awareness are). Each client picks a random sender when it
// starts and counts the frames it sends from 1, across reconnects; receivers
// drop a frame whose counter is not above the last one from its sender. The
// room key is new for every room and the host stays for its whole life, so
// the host never applies a frame twice. Keep in sync with packages/protocol.
const (
	SenderBytes      = 16
	frameHeaderBytes = SenderBytes + 8
)

// Sender is the random id a client puts on every frame it sends.
type Sender [SenderBytes]byte

func newSender() Sender {
	var s Sender
	_, _ = rand.Read(s[:]) // never fails
	return s
}

// ErrReplayedFrame marks a frame received before, or one of our own: only the
// relay can send those.
var ErrReplayedFrame = errors.New("frame received twice")

// EncodeFrame puts the sender and its counter before a message (EncodeMessage):
// what a frame encrypts.
func EncodeFrame(from Sender, counter uint64, message []byte) []byte {
	out := make([]byte, frameHeaderBytes+len(message))
	copy(out, from[:])
	binary.BigEndian.PutUint64(out[SenderBytes:], counter)
	copy(out[frameHeaderBytes:], message)
	return out
}

// DecodeFrame reverses EncodeFrame.
func DecodeFrame(data []byte) (Sender, uint64, []byte, error) {
	var from Sender
	if len(data) < frameHeaderBytes {
		return from, 0, nil, errors.New("frame too short")
	}
	copy(from[:], data)
	return from, binary.BigEndian.Uint64(data[SenderBytes:]), data[frameHeaderBytes:], nil
}

// replayGuard remembers the last counter from each sender. Only peers with
// the key can add senders, so it grows with the people who joined the room.
type replayGuard struct {
	self Sender
	mu   sync.Mutex
	last map[Sender]uint64
}

// accept tells whether a frame is new, and if it is, remembers it.
func (g *replayGuard) accept(from Sender, counter uint64) bool {
	if from == g.self {
		return false
	}
	g.mu.Lock()
	defer g.mu.Unlock()
	if counter <= g.last[from] {
		return false
	}
	if g.last == nil {
		g.last = map[Sender]uint64{}
	}
	g.last[from] = counter
	return true
}
