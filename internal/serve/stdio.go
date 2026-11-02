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
)

// Stdio writes pedit's side of the frames to w: one goroutine owns w.
type Stdio struct {
	out  chan []byte
	done chan struct{}
	mu   sync.RWMutex // held for reading while sending on out
	shut bool
}

// NewStdio starts writing frames to w.
func NewStdio(w io.Writer) *Stdio {
	st := &Stdio{out: make(chan []byte, 1024), done: make(chan struct{})}
	go func() {
		defer close(st.done)
		dead := false
		for b := range st.out {
			// A parent that stopped reading must not hold up the shutdown:
			// keep draining after a failed write.
			if !dead {
				if _, err := w.Write(b); err != nil {
					dead = true
				}
			}
		}
	}()
	return st
}

func encodeFrame(kind byte, stream uint32, payload []byte) []byte {
	b := make([]byte, headerLen, headerLen+len(payload))
	b[0] = kind
	binary.BigEndian.PutUint32(b[1:], stream)
	binary.BigEndian.PutUint32(b[5:], uint32(len(payload)))
	return append(b, payload...)
}

func closeFrame(stream uint32, ce *closeError) []byte {
	return encodeFrame(kindClose, stream, append(binary.BigEndian.AppendUint16(nil, uint16(ce.code)), ce.reason...))
}

func (st *Stdio) put(b []byte) {
	st.mu.RLock()
	defer st.mu.RUnlock()
	if !st.shut {
		st.out <- b
	}
}

// Event writes an event frame; fields get the key "event" set to name.
func (st *Stdio) Event(name string, fields map[string]any) {
	fields["event"] = name
	payload, _ := json.Marshal(fields)
	st.put(encodeFrame(kindEvent, 0, payload))
}

// Close writes what is queued, then stops. Nothing is written after it.
func (st *Stdio) Close() {
	st.mu.Lock()
	if !st.shut {
		st.shut = true
		close(st.out)
	}
	st.mu.Unlock()
	<-st.done
}

// stream is a client's end of one stream.
type stream struct {
	st   *Stdio
	id   uint32
	sess *session
}

func (x *stream) write(msg []byte) error {
	x.st.put(encodeFrame(kindData, x.id, msg))
	return nil
}

func (x *stream) close(ce *closeError) {
	if ce != nil {
		x.st.put(closeFrame(x.id, ce))
	}
	x.sess.mu.Lock()
	delete(x.sess.open, x.id)
	x.sess.mu.Unlock()
}

// session is the streams of one Serve.
type session struct {
	mu   sync.Mutex
	open map[uint32]*client
	last uint32 // the highest id opened; ids are never reused
}

// Serve reads frames from in and attaches each stream to s until in ends,
// which is a clean end (nil), or a frame breaks the format, which is an error.
// Either way the streams it opened are closed. Only the parent holds in.
func (st *Stdio) Serve(s *Server, in io.Reader) error {
	sess := &session{open: map[uint32]*client{}}
	defer func() {
		sess.mu.Lock()
		rest := make([]*client, 0, len(sess.open))
		for _, c := range sess.open {
			rest = append(rest, c)
		}
		sess.mu.Unlock()
		for _, c := range rest {
			c.finish(s, nil)
		}
	}()
	br := bufio.NewReader(in)
	var hdr [headerLen]byte
	for {
		if _, err := io.ReadFull(br, hdr[:]); err != nil {
			if errors.Is(err, io.EOF) {
				return nil
			}
			return fmt.Errorf("frame cut short: %w", err)
		}
		kind, id, n := hdr[0], binary.BigEndian.Uint32(hdr[1:]), binary.BigEndian.Uint32(hdr[5:])
		if n > maxPayload {
			return fmt.Errorf("frame of %d bytes is over the %d byte limit", n, maxPayload)
		}
		var buf bytes.Buffer
		if _, err := io.CopyN(&buf, br, int64(n)); err != nil {
			return fmt.Errorf("frame cut short: %w", err)
		}
		payload := buf.Bytes()
		switch kind {
		case kindOpen:
			if len(payload) != 1 || payload[0] > 1 {
				return errors.New("open frame without a role")
			}
			sess.mu.Lock()
			if id <= sess.last {
				sess.mu.Unlock()
				return fmt.Errorf("stream %d opened out of order", id)
			}
			if len(sess.open) >= maxStreams {
				sess.mu.Unlock()
				return fmt.Errorf("more than %d streams open", maxStreams)
			}
			sess.last = id
			if c := s.attach(&stream{st: st, id: id, sess: sess}, payload[0] == 1); c != nil {
				sess.open[id] = c
			} else {
				st.put(closeFrame(id, &closeError{code: 1001, reason: "closing"}))
			}
			sess.mu.Unlock()
		case kindData, kindClose:
			sess.mu.Lock()
			c, ok := sess.open[id]
			never := id == 0 || id > sess.last
			sess.mu.Unlock()
			if !ok {
				if never {
					return fmt.Errorf("stream %d was never opened", id)
				}
				continue // closed already: the app sent this before it knew
			}
			if kind == kindData {
				s.receive(c, payload)
			} else {
				c.finish(s, nil)
			}
		default:
			return fmt.Errorf("unknown frame kind %d", kind)
		}
	}
}
