package serve

import (
	"bufio"
	"bytes"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"sync"
	"time"
)

// The app talks to pedit serve over its standard streams, one stream per page,
// as frames: kind (1 byte) | stream (uint32, big-endian) | length (uint32,
// big-endian) | payload. No frame names a path or opens a file: the file was
// chosen on the command line, and a stream's role is set by its open frame
// and never changes (docs/design/serve.md).
const (
	kindOpen  = 1 // app: one byte, 0 edit or 1 read
	kindData  = 2 // both: one y-websocket message
	kindClose = 3 // app: empty; pedit: uint16 code, then a UTF-8 reason
	kindEvent = 4 // pedit: stream 0, one JSON event

	maxStreams = 8
	maxPayload = maxFrame
	headerLen  = 9

	// eventWait is how long an event waits for room on stdout. A parent that
	// stopped reading must not hold up the shutdown, which writes the file.
	eventWait = 2 * time.Second
)

// Stdio writes pedit's side of the frames to w: one goroutine owns w.
type Stdio struct {
	out     chan []byte
	closing chan struct{} // closes when Close begins
	done    chan struct{} // closes when the writer has returned
	once    sync.Once
}

// NewStdio starts writing frames to w.
func NewStdio(w io.Writer) *Stdio {
	st := &Stdio{out: make(chan []byte, 1024), closing: make(chan struct{}), done: make(chan struct{})}
	go st.run(w)
	return st
}

func (st *Stdio) run(w io.Writer) {
	defer close(st.done)
	dead := false
	write := func(b []byte) {
		// After a failed write keep taking frames, so that nothing blocks.
		if !dead {
			_, err := w.Write(b)
			dead = err != nil
		}
	}
	for {
		select {
		case b := <-st.out:
			write(b)
		case <-st.closing:
			for {
				select {
				case b := <-st.out:
					write(b)
				default:
					return
				}
			}
		}
	}
}

// encodeFrame returns nil for a payload over the limit.
func encodeFrame(kind byte, stream uint32, payload []byte) []byte {
	if len(payload) > maxPayload {
		return nil
	}
	b := make([]byte, headerLen, headerLen+len(payload))
	b[0] = kind
	binary.BigEndian.PutUint32(b[1:], stream)
	binary.BigEndian.PutUint32(b[5:], uint32(len(payload)))
	return append(b, payload...)
}

func closeFrame(stream uint32, ce *closeError) []byte {
	return encodeFrame(kindClose, stream, append(binary.BigEndian.AppendUint16(nil, uint16(ce.code)), ce.reason...))
}

// put queues b, waiting for room until quit closes (nil: never) or Close begins.
func (st *Stdio) put(b []byte, quit <-chan struct{}) {
	select {
	case st.out <- b:
	case <-quit:
	case <-st.closing:
	}
}

// Event writes an event frame; fields get the key "event" set to name. It
// gives up if stdout has no room for eventWait.
func (st *Stdio) Event(name string, fields map[string]any) {
	fields["event"] = name
	payload, _ := json.Marshal(fields)
	timeout := time.NewTimer(eventWait)
	defer timeout.Stop()
	select {
	case st.out <- encodeFrame(kindEvent, 0, payload):
	case <-timeout.C:
	case <-st.closing:
	}
}

// Close writes what is queued, waiting at most wait for the parent to take
// it, then stops. Nothing is queued after it.
func (st *Stdio) Close(wait time.Duration) {
	st.once.Do(func() { close(st.closing) })
	select {
	case <-st.done:
	case <-time.After(wait):
	}
}

// stream is a client's end of one stream.
type stream struct {
	st   *Stdio
	id   uint32
	sess *session
}

// write reports false for a message too large for a frame.
func (x *stream) write(msg []byte, quit <-chan struct{}) bool {
	frame := encodeFrame(kindData, x.id, msg)
	if frame == nil {
		return false
	}
	x.st.put(frame, quit)
	return true
}

// close frees the stream's slot before telling the app, so that the open
// that the app sends on seeing the close finds it free.
func (x *stream) close(ce *closeError, quit <-chan struct{}) {
	x.sess.mu.Lock()
	delete(x.sess.open, x.id)
	x.sess.mu.Unlock()
	if ce != nil {
		x.st.put(closeFrame(x.id, ce), quit)
	}
}

// session is the streams of one Serve.
type session struct {
	st   *Stdio
	s    *Server
	mu   sync.Mutex
	open map[uint32]*client
	last uint32 // the highest id opened; ids are never reused
}

type header struct {
	kind   byte
	stream uint32
	length uint32
}

// readHeader reads a frame's header and refuses what the payload could not
// make valid, before the payload is read. It returns io.EOF at a clean end.
func readHeader(r io.Reader) (header, error) {
	var b [headerLen]byte
	if _, err := io.ReadFull(r, b[:]); err != nil {
		if errors.Is(err, io.EOF) {
			return header{}, io.EOF
		}
		return header{}, fmt.Errorf("frame cut short: %w", err)
	}
	h := header{kind: b[0], stream: binary.BigEndian.Uint32(b[1:]), length: binary.BigEndian.Uint32(b[5:])}
	switch {
	case h.length > maxPayload:
		return h, fmt.Errorf("frame of %d bytes is over the %d byte limit", h.length, maxPayload)
	case h.kind == kindOpen && h.length != 1:
		return h, errors.New("open frame without a role")
	case h.kind == kindClose && h.length != 0:
		return h, errors.New("close frame with a payload")
	case h.kind < kindOpen || h.kind > kindClose:
		return h, fmt.Errorf("unknown frame kind %d", h.kind)
	}
	return h, nil
}

// Serve reads frames from in and attaches each stream to s until in ends,
// which is a clean end (nil), or a frame breaks the format, which is an error.
// Either way the streams it opened are closed. Only the parent holds in.
func (st *Stdio) Serve(s *Server, in io.Reader) error {
	sess := &session{st: st, s: s, open: map[uint32]*client{}}
	defer sess.closeAll()
	br := bufio.NewReader(in)
	for {
		h, err := readHeader(br)
		if err != nil {
			if err == io.EOF {
				return nil
			}
			return err
		}
		var buf bytes.Buffer
		if _, err := io.CopyN(&buf, br, int64(h.length)); err != nil {
			return fmt.Errorf("frame cut short: %w", err)
		}
		if err := sess.handle(h, buf.Bytes()); err != nil {
			return err
		}
	}
}

func (sess *session) handle(h header, payload []byte) error {
	if h.kind == kindOpen {
		return sess.openStream(h.stream, payload[0])
	}
	sess.mu.Lock()
	c, ok := sess.open[h.stream]
	never := h.stream == 0 || h.stream > sess.last
	if ok && h.kind == kindClose {
		delete(sess.open, h.stream) // the slot is free now
	}
	sess.mu.Unlock()
	switch {
	case ok && h.kind == kindData:
		sess.s.receive(c, payload)
	case ok:
		// The app dropped the stream: what is queued for it is dropped, and
		// the other streams are not kept waiting.
		go c.finish(sess.s, nil, false)
	case never:
		return fmt.Errorf("stream %d was never opened", h.stream)
	}
	// Otherwise pedit closed the stream already, and the app sent this before
	// it knew.
	return nil
}

func (sess *session) openStream(id uint32, role byte) error {
	if role > 1 {
		return errors.New("open frame with an unknown role")
	}
	sess.mu.Lock()
	defer sess.mu.Unlock()
	if id <= sess.last {
		return fmt.Errorf("stream %d opened out of order", id)
	}
	if len(sess.open) >= maxStreams {
		return fmt.Errorf("more than %d streams open", maxStreams)
	}
	sess.last = id
	c := sess.s.attach(&stream{st: sess.st, id: id, sess: sess}, role == 1)
	if c == nil {
		sess.st.put(closeFrame(id, &closeError{code: 1001, reason: "closing"}), nil)
		return nil
	}
	sess.open[id] = c
	return nil
}

func (sess *session) closeAll() {
	sess.mu.Lock()
	rest := make([]*client, 0, len(sess.open))
	for _, c := range sess.open {
		rest = append(rest, c)
	}
	sess.mu.Unlock()
	for _, c := range rest {
		c.finish(sess.s, nil, false)
	}
}
