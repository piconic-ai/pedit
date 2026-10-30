package session

import (
	"context"
	"errors"
	"net/http"
	"os"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/piconic-ai/pedit/internal/protocol"
)

// resumed is a kept room after the host took in what was written while it was
// away. conn is the host's connection, which the session goes on with.
type resumed struct {
	roomID string
	state  keptTextState
	conn   protocol.Conn
	// late are the entries that came in between the replay and the checkpoint.
	late [][]byte
	keep int64
}

func (r *resumed) roomInfo() *room { return &room{ID: r.roomID, HostToken: r.state.HostToken} }

// stateOf and metaOf are the docs of the file at path that the guests hold,
// or nil if there is no kept room being taken in (r is nil) or no such file.
func (r *resumed) stateOf(path string) []byte {
	if f := r.file(path); f != nil {
		return f.State
	}
	return nil
}

func (r *resumed) metaOf(path string) []byte {
	if f := r.file(path); f != nil && f.Meta != nil {
		return f.Meta.State
	}
	return nil
}

func (r *resumed) file(path string) *keptTextFileState {
	if r == nil {
		return nil
	}
	for i := range r.state.Files {
		if r.state.Files[i].File == path {
			return &r.state.Files[i]
		}
	}
	return nil
}

// dialer makes the session's first connection the one the host took the room
// in on; it dials anew when that drops.
func (r *resumed) dialer(dial protocol.Dialer) protocol.Dialer {
	if dial == nil {
		dial = protocol.DialWebSocket
	}
	var mu sync.Mutex
	conn := r.conn
	return func(ctx context.Context, url string, header http.Header) (protocol.Conn, error) {
		mu.Lock()
		first := conn
		conn = nil
		mu.Unlock()
		if first != nil {
			return first, nil
		}
		return dial(ctx, url, header)
	}
}

// beginKeep prepares a session that keeps its room, or takes one in again.
func beginKeep(ctx context.Context, opts *Options) (*resumed, error) {
	if (opts.Keep > 0 || opts.Resume != "") && runtime.GOOS == "windows" {
		return nil, errors.New("--keep and --resume require Unix file permissions; Windows is not supported")
	}
	if opts.OnKeep == nil {
		opts.OnKeep = func(int64) {}
	}
	if opts.Resume == "" {
		return nil, nil
	}
	return resumeAway(ctx, opts)
}

// abandon leaves the room on purpose, so that the relay keeps it, if the
// session could not start with it.
func (r *resumed) abandon() {
	if r != nil {
		_ = r.conn.Leave()
	}
}

// openRoom creates the room, or finds the one being taken in, with its key.
func openRoom(ctx context.Context, opts Options, server string, res *resumed) (*room, string, error) {
	if res != nil {
		return res.roomInfo(), res.state.Fragment, nil
	}
	r, err := createRoom(ctx, opts.HTTPClient, server, opts.Header)
	return r, protocol.GenerateEditSecret(), err
}

// hostHeader is the handshake of the host: its token marks it as the host, so
// the room closes for everyone once it leaves, and a relay that keeps rooms
// hears how long, and how far into its log the host is.
func hostHeader(opts Options, token string, res *resumed) (http.Header, protocol.Dialer) {
	header := opts.Header.Clone()
	if header == nil {
		header = http.Header{}
	}
	header.Set("Authorization", "Bearer "+token)
	dial := opts.Dial
	if opts.Keep > 0 || res != nil {
		keep, after := int64(opts.Keep/time.Second), uint64(0)
		if res != nil {
			keep, after, dial = res.state.Keep, res.state.After, res.dialer(dial)
		}
		header.Set(protocol.KeepHeader, strconv.FormatInt(keep, 10))
		header.Set(protocol.AfterHeader, strconv.FormatUint(after, 10))
	}
	return header, dial
}

func (s *Session) onKind(kind byte, payload []byte) {
	if s.away != nil {
		s.away.onKind(kind, payload)
	}
}

func (s *Session) onText(text string) {
	if s.away != nil {
		s.away.onText(text)
	}
}

func (s *Session) onStatus(st protocol.Status) {
	if st == protocol.StatusConnected && s.away != nil {
		go s.away.connected()
	}
	if s.opts.OnStatus != nil {
		s.opts.OnStatus(st)
	}
}

// keepOpen adds the files a room starts with beyond the first and, if it is to
// be kept, starts keeping it. The session is not connected yet.
func (s *Session) keepOpen(opts *Options, hostToken, fragment string, res *resumed) error {
	for _, file := range opts.More {
		if _, err := s.AddFile(file); err != nil {
			return err
		}
	}
	if opts.Keep <= 0 && res == nil {
		return nil
	}
	if err := s.startAway(hostToken, fragment, res); err != nil {
		return err
	}
	if res != nil {
		for _, entry := range res.late {
			s.away.takeIn(entry)
		}
		s.away.tell(s.away.granted)
	}
	return nil
}

// resumeStep is how long the relay may take to answer, between messages.
const resumeStep = 30 * time.Second

// resumeAway takes in the room of opts.Resume: it merges the edits made to the
// files while the host was away, connects as the host, applies the replayed log
// as the polling mode does, writes the files, and checkpoints, which has the
// relay drop its log. It sets opts to share the record's files.
func resumeAway(ctx context.Context, opts *Options) (*resumed, error) {
	h, err := openAway(ctx, KeptTextOptions{Project: opts.Project, Resume: opts.Resume}, opts.OnSkipped, opts.OnImageError)
	if err != nil {
		return nil, err
	}
	defer h.closeFiles()
	conn, err := h.dialAway(ctx, opts.Dial, opts.Header)
	if err != nil {
		return nil, err
	}
	r := &resumed{roomID: h.room, state: h.state, conn: conn}
	if err := r.takeIn(ctx, h); err != nil {
		_ = conn.Leave()
		return nil, err
	}
	r.state = h.state
	opts.File, opts.Server = h.state.Files[0].File, h.state.Origin
	opts.More = nil
	for _, file := range h.state.Files[1:] {
		opts.More = append(opts.More, file.File)
	}
	return r, nil
}

// openAway opens the record of a live room kept by the relay, with its files,
// after the edits made to them while the host was away are merged in.
func openAway(ctx context.Context, opts KeptTextOptions, onSkipped func(int), onImageError func(string, error)) (*keptTextHost, error) {
	h := &keptTextHost{client: &http.Client{Timeout: 10 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}, onSkipped: onSkipped, onImageError: onImageError, socket: true}
	if err := h.prepare(ctx, opts); err != nil {
		return nil, err
	}
	if !h.state.Socket {
		return nil, errors.New("this room is kept by polling; resume it with --keep-polling")
	}
	if err := h.openFiles(); err != nil {
		return nil, err
	}
	if err := h.restore(); err != nil {
		h.closeFiles()
		return nil, err
	}
	h.after = h.state.After
	return h, nil
}

// dialAway connects as the host, saying how far into the relay's log it is.
func (h *keptTextHost) dialAway(ctx context.Context, dial protocol.Dialer, header http.Header) (protocol.Conn, error) {
	if dial == nil {
		dial = protocol.DialWebSocket
	}
	header = header.Clone()
	if header == nil {
		header = http.Header{}
	}
	header.Set("Authorization", "Bearer "+h.state.HostToken)
	header.Set(protocol.KeepHeader, strconv.FormatInt(h.state.Keep, 10))
	header.Set(protocol.AfterHeader, strconv.FormatUint(h.after, 10))
	conn, err := dial(ctx, wsURL(h.state.Origin, h.room), protocol.HandshakeHeader(header, h.keys, true))
	if err != nil {
		return nil, err
	}
	if protocol.ConnVersion(conn) < 6 {
		_ = conn.Close()
		return nil, errors.New("the relay is too old to keep a room; it needs an update")
	}
	return conn, nil
}

func wsURL(origin, room string) string {
	return "ws" + strings.TrimPrefix(origin, "http") + "/api/rooms/" + room + "/ws"
}

// takeIn reads the replay, takes it in and checkpoints.
func (r *resumed) takeIn(ctx context.Context, h *keptTextHost) error {
	read, err := r.replay(ctx)
	if err != nil {
		return err
	}
	frame, err := h.intake(ctx, read)
	if err != nil {
		return err
	}
	if frame == nil {
		return errors.New("nothing to checkpoint")
	}
	if err := r.conn.Write(ctx, protocol.EncodeCheckpoint(read.Tail, frame)); err != nil {
		return err
	}
	return r.awaitCheckpoint(ctx, h)
}

// replay reads what the relay sends a returning host: the snapshot if the
// host holds less than the relay's cutoff, the entries after it, the tail.
func (r *resumed) replay(ctx context.Context) (read keptTextRead, err error) {
	for done := false; !done; {
		kind, payload, e := r.next(ctx)
		if e != nil {
			return read, e
		}
		switch kind {
		case protocol.KindReplay:
			read.Snapshot = payload
		case protocol.KindLogged:
			id, entry, ok := protocol.DecodeLogged(payload)
			if !ok {
				return read, errors.New("invalid log entry from the relay")
			}
			read.Entries = append(read.Entries, keptTextEntry{ID: id, Body: entry})
		case protocol.KindLogEnd:
			tail, ok := protocol.DecodeLogEnd(payload)
			if !ok {
				return read, errors.New("invalid log end from the relay")
			}
			read.Tail, done = tail, true
		}
	}
	return read, nil
}

// awaitCheckpoint waits for the relay's answer to the checkpoint.
func (r *resumed) awaitCheckpoint(ctx context.Context, h *keptTextHost) error {
	for {
		kind, payload, err := r.next(ctx)
		if err != nil {
			return err
		}
		if kind == textKind {
			if cutoff, _, ok := protocol.ParseCheckpoint(string(payload)); ok {
				h.checkpointed(cutoff)
				h.state.After = cutoff
				return saveKeptState(h.path, h.state)
			} else if string(payload) == protocol.CheckpointRefused {
				return errors.New("the relay refused the checkpoint")
			}
		}
	}
}

// textKind stands for a text message of the relay in next.
const textKind byte = 255

// next reads the relay's next message: its kind and payload, or textKind and
// the text. Entries that arrive while the host is not yet taking in are kept
// in late; live frames and kinds this version does not know are dropped.
func (r *resumed) next(ctx context.Context) (byte, []byte, error) {
	for {
		step, cancel := context.WithTimeout(ctx, resumeStep)
		data, err := r.conn.Read(step)
		cancel()
		var sig protocol.Signal
		if errors.As(err, &sig) {
			if seconds, _, ok := protocol.ParseKeep(string(sig)); ok {
				r.keep = seconds
			}
			return textKind, []byte(sig), nil
		}
		if err != nil {
			return 0, nil, err
		}
		kind, payload, ok := protocol.SplitKind(data)
		switch {
		case !ok:
		case kind == protocol.KindEntry:
			r.late = append(r.late, payload)
		case kind >= protocol.KindLogged && kind <= protocol.KindLogEnd:
			return kind, payload, nil
		}
	}
}

// closeLive ends a room kept by the relay, which only --close does: resuming
// one is Start's.
func closeLive(ctx context.Context, opts KeptTextOptions) error {
	if !opts.Close {
		return errors.New("this room is kept by the relay; resume it with pedit --resume")
	}
	h, err := openAway(ctx, opts, opts.OnSkipped, opts.OnImageError)
	if err != nil {
		return err
	}
	defer h.closeFiles()
	return h.closeAway(ctx, opts.Dial)
}

// takeInLate takes in the entries that came while the host was already here,
// which the relay passed on without keeping.
func (h *keptTextHost) takeInLate(ctx context.Context, late [][]byte) error {
	if len(late) == 0 {
		return nil
	}
	read := keptTextRead{Tail: h.after + uint64(len(late))}
	for i, body := range late {
		read.Entries = append(read.Entries, keptTextEntry{ID: h.after + uint64(i) + 1, Body: body})
	}
	if err := h.applyEntries(read, h.after); err != nil {
		return err
	}
	_, err := h.persist(ctx)
	return err
}

// closeAway takes in the room's edits, then ends the room on the relay. The
// relay ends only a room whose host is away, so the host leaves again once it
// has taken in the log, and asks. It then connects once more: a room that was
// ended turns it away.
func (h *keptTextHost) closeAway(ctx context.Context, dial protocol.Dialer) error {
	for attempt := 0; ; attempt++ {
		conn, err := h.dialAway(ctx, dial, nil)
		if roomClosed(err) {
			return os.Remove(h.path)
		}
		if err != nil {
			return err
		}
		if attempt == 3 {
			_ = conn.Leave()
			return errors.New("could not close the room: guests keep editing it")
		}
		r := &resumed{conn: conn}
		h.republish = true
		err = r.takeIn(ctx, h)
		if roomClosed(err) {
			return os.Remove(h.path)
		}
		if err == nil {
			err = h.takeInLate(ctx, r.late)
		}
		if err == nil && (h.imagesFailed || !h.nothingPending()) {
			err = errors.New("could not save everything to your files; the room is left open")
		}
		_ = conn.Leave()
		if err != nil {
			return err
		}
		time.Sleep(200 * time.Millisecond)
		tail := http.Header{"X-Pedit-Tail": {strconv.FormatUint(h.after, 10)}}
		if status, err := keptTextRequest(ctx, h.client, &h.state, h.room, "POST", "/close", nil, tail, &struct{}{}); err != nil && status != http.StatusConflict {
			return err
		}
	}
}

func roomClosed(err error) bool {
	var closed *protocol.CloseError
	return errors.As(err, &closed) && closed.Code == protocol.RoomClosed
}
