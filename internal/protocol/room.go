package protocol

import (
	"context"
	"errors"
	"fmt"
	"math/rand/v2"
	"net/http"
	"sync"
	"time"

	"github.com/reearth/ygo/awareness"
	"github.com/reearth/ygo/crdt"
	"github.com/reearth/ygo/encoding"
	ysync "github.com/reearth/ygo/sync"
)

// Status is the connection state of a Client. StatusClosed is final: the host
// ended the session. So is StatusFull: the room had no place for us. So is
// StatusMaintenance: the relay closed, and Resume picks the session up again
// once it is back. So are
// StatusClientOutdated and StatusServerOutdated: the server speaks an older or
// newer protocol version. So is StatusTooLarge: a frame we had to send was over
// MaxFrameBytes, the most the relay takes. So is StatusExpired: the room
// reached the relay's time limit. StatusBusy is not: the relay turned
// us away for now, and the Client tries again later than after a drop. Nor is
// StatusWaiting: we are connected, but the host dropped and the relay waits
// for it to come back; nobody edits meanwhile.
type Status string

// errDestroyed ends the connection loop when the Client was destroyed mid-dial.
var errDestroyed = errors.New("client destroyed")

const (
	StatusConnecting   Status = "connecting"
	StatusConnected    Status = "connected"
	StatusWaiting      Status = "waiting"
	StatusDisconnected Status = "disconnected"
	StatusBusy         Status = "busy"
	StatusClosed       Status = "closed"
	StatusFull         Status = "full"
	StatusMaintenance  Status = "maintenance"

	StatusClientOutdated Status = "client-outdated"
	StatusServerOutdated Status = "server-outdated"

	StatusTooLarge Status = "too-large"
	StatusExpired  Status = "expired"
)

// finalStatus maps the close codes that end a Client for good to its status.
var finalStatus = map[int]Status{
	RoomClosed:       StatusClosed,
	RoomFull:         StatusFull,
	RelayMaintenance: StatusMaintenance,
	ClientOutdated:   StatusClientOutdated,
	ServerOutdated:   StatusServerOutdated,
	MessageTooBig:    StatusTooLarge,
	RoomExpired:      StatusExpired,
}

// finalOf maps what ended a connection to the status that ends the Client for
// good, if any.
func finalOf(err error) (Status, bool) {
	if errors.Is(err, ErrFrameTooLarge) {
		return StatusTooLarge, true
	}
	st, ok := finalStatus[closeCode(err)]
	return st, ok
}

// Final reports whether a Client stays in s for good and no longer reconnects.
func (s Status) Final() bool {
	switch s {
	case StatusClosed, StatusFull, StatusMaintenance, StatusClientOutdated, StatusServerOutdated, StatusTooLarge, StatusExpired:
		return true
	}
	return false
}

type ClientOptions struct {
	// URL is the WebSocket URL of the room. It must never contain the key.
	URL string
	// RoomID is the id of the room, which its keys are bound to (access.go).
	RoomID string
	// Key is an edit secret, the link of an editor; Link, when set, is the
	// link the Client joins with instead, of any access.
	Key       []byte
	Link      *LinkSecrets
	Doc       *crdt.Doc
	Awareness *awareness.Awareness
	// Header holds extra handshake headers.
	Header http.Header
	// Host is set for the room's host, which tells the relay when it leaves
	// on purpose (HostLeft) rather than dropping.
	Host       bool
	Dial       Dialer
	MinBackoff time.Duration
	MaxBackoff time.Duration
	// BusyBackoff is the least a busy relay is waited out before trying again.
	BusyBackoff time.Duration
	// Messages and Bytes are what the relay lets one connection send;
	// RelayMessages and RelayBytes when zero. The Client paces what it sends
	// to stay within them.
	Messages Rate
	Bytes    Rate
	OnStatus func(Status)
	OnError  func(error)
	// OnSynced is called once, on the connection's read loop, when the first
	// SyncStep2 from a peer has been applied: the doc now holds what the room
	// had. Return quickly.
	OnSynced func()
	// OnAttachment is called with each attachment message from the room, on
	// the connection's read loop: return quickly.
	OnAttachment func(Attachment)
	// OnCanvas is called with each canvas message from the room, on the
	// connection's read loop: return quickly.
	OnCanvas func(CanvasMessage)

	// In a room that shares several files (room_files.go), these are called
	// on the connection's read loop too: return quickly. OnManifest gets
	// each list of the room's files. OnFileSynced is called once per added
	// file, when the first SyncStep2 for it has been applied.
	// OnFileAttachment and OnFileCanvas get the messages about one file.
	OnManifest       func([]FileEntry)
	OnFileSynced     func(id uint64)
	OnFileAttachment func(id uint64, a Attachment)
	OnFileCanvas     func(id uint64, m CanvasMessage)
}

// Client keeps a Doc and Awareness in sync with every other peer in a room.
//
// The server is a dumb relay, so the peers run a symmetric protocol: on connect a
// peer sends SyncStep1 (to pull what it is missing), its full state as SyncStep2
// (to push what others are missing) and its awareness state. Every peer answers
// SyncStep1 with SyncStep2. All frames are end-to-end encrypted.
//
// What a peer may change follows from its link (access.go): editors sign
// their frames with the editors' key, commenters with the commenters' key,
// and readers sign nothing. Every peer applies a frame only as far as the
// key that signed it allows, and a Client sends only what its own access
// lets others apply.
//
// Changes applied from the room carry the Client as their origin.
type Client struct {
	opts   ClientOptions
	keys   *RoomKeys
	cipher *Cipher
	doc    *crdt.Doc
	aw     *awareness.Awareness

	// applying serializes applying remote updates with Do.
	applying sync.Mutex
	// checks is the time checked files' updates may take; under applying.
	checks timeShare

	// sendMu numbers frames in the order they are queued: receivers drop
	// one numbered below one they already have.
	sendMu sync.Mutex
	sent   uint64
	guard  replayGuard

	mu        sync.Mutex
	status    Status
	out       *outbox
	started   bool
	destroyed bool
	synced    bool
	timeLimit time.Duration
	unsubs    []func()
	files     map[uint64]*fileDoc
	manifest  []byte // the encoded FilesManifest, when this Client set one

	ctx    context.Context
	cancel context.CancelFunc
	done   chan struct{}
}

func NewClient(opts ClientOptions) (*Client, error) {
	link := LinkSecrets{Access: AccessEdit, Edit: opts.Key}
	if opts.Link != nil {
		link = *opts.Link
	}
	keys, err := DeriveRoomKeys(link, opts.RoomID)
	if err != nil {
		return nil, err
	}
	cipher, err := NewCipher(keys.FrameKey)
	if err != nil {
		return nil, err
	}
	opts.Header = opts.Header.Clone()
	if opts.Header == nil {
		opts.Header = http.Header{}
	}
	opts.Header.Set("Sec-WebSocket-Protocol", SocketProtocol+", "+AdmissionProtocolPrefix+keys.ReadAdmission)
	if opts.Dial == nil {
		opts.Dial = DialWebSocket
	}
	if opts.MinBackoff == 0 {
		opts.MinBackoff = 500 * time.Millisecond
	}
	if opts.MaxBackoff == 0 {
		opts.MaxBackoff = 30 * time.Second
	}
	if opts.BusyBackoff == 0 {
		opts.BusyBackoff = 10 * time.Second
	}
	ctx, cancel := context.WithCancel(context.Background())
	c := &Client{
		opts:   opts,
		keys:   keys,
		cipher: cipher,
		doc:    opts.Doc,
		aw:     opts.Awareness,
		status: StatusDisconnected,
		ctx:    ctx,
		cancel: cancel,
		done:   make(chan struct{}),
	}
	c.guard.self = newSender()
	c.unsubs = []func(){
		c.doc.OnUpdate(c.handleDocUpdate),
		c.aw.OnUpdate(c.handleAwarenessUpdate),
		c.aw.OnChange(c.handleAwarenessChange),
	}
	return c, nil
}

// Keys returns what the Client's link gives in its room.
func (c *Client) Keys() *RoomKeys { return c.keys }

// edits tells whether the Client's link lets it edit the file, as only
// editors may.
func (c *Client) edits() bool { return c.keys.Access == AccessEdit }

// Status returns the current connection state.
func (c *Client) Status() Status {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.status
}

// TimeLimit is the relay's time limit for a room, as it said on closing an
// expired one, or 0 when it did not say.
func (c *Client) TimeLimit() time.Duration {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.timeLimit
}

func (c *Client) setTimeLimit(reason string) {
	seconds, _ := ParseExpiredReason(reason)
	c.mu.Lock()
	c.timeLimit = time.Duration(seconds) * time.Second
	c.mu.Unlock()
}

// Connect starts connecting (and reconnecting) in the background.
func (c *Client) Connect() {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.started || c.destroyed {
		return
	}
	c.started = true
	go c.run(c.done)
}

// Resume connects again after the Client stopped on a final status, such as a
// relay closed for maintenance, into the same room. It does nothing while the
// Client is still running, before Connect, or once destroyed.
func (c *Client) Resume() {
	c.mu.Lock()
	defer c.mu.Unlock()
	if !c.started || c.destroyed {
		return
	}
	select {
	case <-c.done:
	default:
		return
	}
	c.done = make(chan struct{})
	go c.run(c.done)
}

// Do runs fn while no remote update is being applied, so fn can read the
// document and then change it without a remote edit slipping in between.
func (c *Client) Do(fn func()) {
	c.applying.Lock()
	defer c.applying.Unlock()
	fn()
}

func (c *Client) isDestroyed() bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.destroyed
}

// Destroy announces departure, closes the connection and stops reconnecting.
func (c *Client) Destroy() {
	c.mu.Lock()
	if c.destroyed {
		c.mu.Unlock()
		return
	}
	c.mu.Unlock()

	// Queued on the current connection by handleAwarenessUpdate.
	c.aw.SetLocalState(nil)

	c.mu.Lock()
	c.destroyed = true
	out := c.out
	c.out = nil
	started := c.started
	done := c.done
	c.mu.Unlock()

	for _, unsub := range c.unsubs {
		unsub()
	}
	c.unsubscribeFiles()
	if out != nil {
		out.drain()
		// Before the read is cancelled: that closes the connection at once,
		// without the code that tells the relay the host left on purpose.
		if c.opts.Host {
			_ = out.conn.Leave()
		} else {
			_ = out.conn.Close()
		}
	}
	c.cancel()
	if started {
		<-done
	}
	c.setStatus(StatusDisconnected)
}

func (c *Client) run(done chan struct{}) {
	defer close(done)
	attempts := 0
	for {
		c.setStatus(StatusConnecting)
		conn, err := c.opts.Dial(c.ctx, c.opts.URL, c.opts.Header)
		if err == nil {
			attempts = 0
			err = c.serve(conn)
		}
		if c.ctx.Err() != nil || errors.Is(err, errDestroyed) || c.isDestroyed() {
			return
		}
		c.dropRemoteAwareness()
		if st, ok := finalOf(err); ok {
			if st == StatusExpired {
				c.setTimeLimit(closeReason(err))
			}
			c.setStatus(st)
			return
		}
		backoff := min(c.opts.MaxBackoff, c.opts.MinBackoff<<min(attempts, 16))
		if closeCode(err) == RelayBusy {
			c.setStatus(StatusBusy)
			backoff = max(backoff, c.opts.BusyBackoff)
		} else {
			c.onError(err)
			c.setStatus(StatusDisconnected)
		}
		delay := time.Duration(float64(backoff) * (0.5 + rand.Float64()/2))
		attempts++
		select {
		case <-time.After(delay):
		case <-c.ctx.Done():
			return
		}
	}
}

// serve runs one connection until it fails.
func (c *Client) serve(conn Conn) error {
	out := newOutbox(conn, newPacer(c.opts.Messages, c.opts.Bytes, time.Now))
	c.mu.Lock()
	if c.destroyed {
		c.mu.Unlock()
		out.stop()
		_ = conn.Close()
		return errDestroyed
	}
	c.out = out
	c.mu.Unlock()

	// The whole state goes to the room on connecting, from a peer that may
	// write it. When it does not fit a frame, send nothing: a SyncStep1
	// alone would have every peer answer with a state as large, which they
	// could not send either.
	var step2 []byte
	if c.edits() {
		step2 = syncStep2(c.doc)
	}
	if FrameBytes(len(step2)) > MaxFrameBytes {
		out.fail(ErrFrameTooLarge)
	} else {
		c.setStatus(StatusConnected)
		c.send(MessageSync, ysync.EncodeSyncStep1(c.doc))
		if c.edits() {
			c.send(MessageSync, step2)
			c.sendAwareness([]uint64{c.aw.ClientID()})
		}
		c.syncFiles()
	}

	for {
		data, err := conn.Read(c.ctx)
		var sig Signal
		if errors.As(err, &sig) {
			c.relaySignal(sig)
			continue
		}
		if err != nil {
			c.mu.Lock()
			if c.out == out {
				c.out = nil
			}
			c.mu.Unlock()
			out.stop()
			_ = conn.Close()
			if failed := out.failure(); failed != nil {
				return failed
			}
			return err
		}
		if err := c.receive(data); err != nil {
			c.onError(err)
		}
	}
}

// relaySignal takes the relay's own word on the host.
func (c *Client) relaySignal(sig Signal) {
	c.mu.Lock()
	status := c.status
	c.mu.Unlock()
	switch {
	case sig == HostAway && status == StatusConnected:
		c.setStatus(StatusWaiting)
	case sig == HostBack && status == StatusWaiting:
		c.setStatus(StatusConnected)
	}
}

// receive decrypts a frame, checks its signature, takes it once, and
// applies its message as far as the access it speaks for allows.
func (c *Client) receive(data []byte) error {
	plaintext, err := c.cipher.Decrypt(data)
	if err != nil {
		return err
	}
	from, counter, signed, err := DecodeFrame(plaintext)
	if err != nil {
		return err
	}
	if !c.guard.foreign(from) {
		return ErrReplayedFrame
	}
	access, message, err := c.keys.openMessage(plaintext[:frameHeaderBytes], signed)
	if err != nil {
		return err
	}
	if access != AccessRead && !c.guard.accept(access, from, counter) {
		return ErrReplayedFrame
	}
	t, payload, err := DecodeMessage(message)
	if errors.Is(err, ErrUnknownMessageType) {
		// A newer peer may send message types we do not know yet; a signed
		// message inside another is one of those.
		return nil
	}
	if err != nil {
		return err
	}
	switch t {
	case MessageFiles:
		return c.receiveFiles(access, payload)
	case MessageAttachment:
		return c.receiveAttachment(access, payload)
	case MessageCanvas:
		return c.receiveCanvas(access, payload)
	case MessageSync:
		return c.receiveSync(access, payload)
	}
	return c.receiveAwareness(access, payload)
}

func (c *Client) receiveAttachment(access Access, payload []byte) error {
	a, err := DecodeAttachment(payload)
	if errors.Is(err, ErrUnknownAttachmentKind) {
		return nil
	}
	if err != nil {
		return err
	}
	if err := allowAttachment(a, access); err != nil {
		return err
	}
	if c.opts.OnAttachment != nil {
		c.opts.OnAttachment(a)
	}
	return nil
}

func (c *Client) receiveCanvas(access Access, payload []byte) error {
	if err := editorsOnly("a canvas message", access); err != nil {
		return err
	}
	m, err := DecodeCanvas(payload)
	if errors.Is(err, ErrUnknownCanvasKind) {
		return nil
	}
	if err != nil {
		return err
	}
	if c.opts.OnCanvas != nil {
		c.opts.OnCanvas(m)
	}
	return nil
}

func (c *Client) receiveSync(access Access, payload []byte) error {
	if err := allowSync(payload, access == AccessEdit, access); err != nil {
		return err
	}
	c.applying.Lock()
	reply, err := applySync(c.doc, payload, c)
	c.applying.Unlock()
	if err != nil {
		return err
	}
	if len(reply) > 0 && c.edits() {
		c.send(MessageSync, reply)
	}
	if kind, _, err := ysync.ReadSyncMessage(payload); err == nil && kind == ysync.MsgSyncStep2 {
		c.markSynced()
	}
	return nil
}

// applySync applies a sync message to doc, and turns a panic in ygo into an
// error: anyone in the room may send a SyncStep1, and the host's process is
// the session.
func applySync(doc *crdt.Doc, payload []byte, origin any) (reply []byte, err error) {
	defer func() {
		if r := recover(); r != nil {
			reply, err = nil, fmt.Errorf("sync message makes ygo panic: %v", r)
		}
	}()
	return ysync.ApplySyncMessage(doc, payload, origin)
}

func (c *Client) receiveAwareness(access Access, payload []byte) error {
	if err := editorsOnly("awareness", access); err != nil {
		return err
	}
	update, err := encoding.NewDecoder(payload).ReadVarBytes()
	if err != nil {
		return err
	}
	return c.aw.ApplyUpdate(update, c)
}

// markSynced reports the first full state received from a peer, once.
func (c *Client) markSynced() {
	c.mu.Lock()
	first := !c.synced
	c.synced = true
	c.mu.Unlock()
	if first && c.opts.OnSynced != nil {
		c.opts.OnSynced()
	}
}

// StateFrameBytes is the size on the wire of the frame that carries doc's
// whole state, which a Client sends on connecting and, as a diff, in answer
// to a peer's SyncStep1. A doc whose state is over MaxFrameBytes cannot be shared.
func StateFrameBytes(doc *crdt.Doc) int { return FrameBytes(len(syncStep2(doc))) }

func syncStep2(doc *crdt.Doc) []byte {
	enc := encoding.NewEncoder()
	enc.WriteVarUint(ysync.MsgSyncStep2)
	enc.WriteVarBytes(doc.EncodeStateAsUpdate())
	return enc.Bytes()
}

func (c *Client) handleDocUpdate(update []byte, origin any) {
	if origin == c || !c.edits() {
		return
	}
	c.send(MessageSync, ysync.EncodeUpdate(update))
}

func (c *Client) handleAwarenessUpdate(ev awareness.UpdateEvent) {
	if ev.Origin == c || !c.edits() {
		return
	}
	ids := append(append(append([]uint64{}, ev.Added...), ev.Updated...), ev.Removed...)
	c.sendAwareness(ids)
}

// Someone new showed up: tell them about us right away instead of waiting for the
// periodic awareness renewal, and which files the room shares.
func (c *Client) handleAwarenessChange(ev awareness.ChangeEvent) {
	if ev.Origin == c && len(ev.Added) > 0 && c.edits() {
		c.sendAwareness([]uint64{c.aw.ClientID()})
		c.sendManifest()
	}
}

func (c *Client) dropRemoteAwareness() {
	// Every remote client counts as expired after a zero timeout; the local one never does.
	// Unlike removeAwarenessStates in the TS client, RemoveExpired takes no origin, so
	// handleAwarenessUpdate tries to broadcast the removals too; send drops them since
	// we are disconnected.
	c.aw.RemoveExpired(0)
}

// SendAttachment sends an attachment message to everyone else in the room.
// Like every other frame, it is dropped while disconnected; retrying is up to
// the caller.
func (c *Client) SendAttachment(a Attachment) error {
	payload, err := EncodeAttachment(a)
	if err != nil {
		return err
	}
	c.send(MessageAttachment, payload)
	return nil
}

// SendCanvas sends a canvas message to everyone else in the room. Like every
// other frame, it is dropped while disconnected.
func (c *Client) SendCanvas(m CanvasMessage) error {
	payload, err := EncodeCanvas(m)
	if err != nil {
		return err
	}
	c.send(MessageCanvas, payload)
	return nil
}

func (c *Client) sendAwareness(ids []uint64) {
	enc := encoding.NewEncoder()
	enc.WriteVarBytes(c.aw.EncodeUpdate(ids))
	c.send(MessageAwareness, enc.Bytes())
}

// send queues a frame on the current connection, or drops it while
// disconnected: the handshake on reconnect carries everything that was missed.
func (c *Client) send(t MessageType, payload []byte) {
	c.mu.Lock()
	out := c.out
	c.mu.Unlock()
	if out == nil {
		return
	}
	if FrameBytes(len(payload)) > MaxFrameBytes {
		// The relay would close us with MessageTooBig, and the same frame
		// would go again on every reconnect: give the connection up instead.
		out.fail(ErrFrameTooLarge)
		return
	}
	c.sendMu.Lock()
	defer c.sendMu.Unlock()
	c.sent++
	message := EncodeMessage(t, payload)
	if c.keys.Signer != nil {
		header := EncodeFrame(c.guard.self, c.sent, nil)
		message = signMessage(c.keys.Signer, c.keys.Access, header, message)
	}
	out.push(c.cipher.Encrypt(EncodeFrame(c.guard.self, c.sent, message)))
}

func (c *Client) setStatus(s Status) {
	c.mu.Lock()
	if c.status == s {
		c.mu.Unlock()
		return
	}
	c.status = s
	c.mu.Unlock()
	if c.opts.OnStatus != nil {
		c.opts.OnStatus(s)
	}
}

func (c *Client) onError(err error) {
	if err != nil && c.opts.OnError != nil {
		c.opts.OnError(err)
	}
}

// outbox writes frames to a connection in order, without blocking the
// sender, and paces them within the relay's rates.
type outbox struct {
	conn   Conn
	pace   *pacer
	mu     sync.Mutex
	queue  [][]byte
	closed bool
	failed error // why this side gave the connection up
	wake   chan struct{}
	// quit is closed when the frames still queued are dropped.
	quit     chan struct{}
	quitOnce sync.Once
	done     chan struct{}
}

func newOutbox(conn Conn, pace *pacer) *outbox {
	o := &outbox{conn: conn, pace: pace, wake: make(chan struct{}, 1), quit: make(chan struct{}), done: make(chan struct{})}
	go o.loop()
	return o
}

func (o *outbox) quitNow() { o.quitOnce.Do(func() { close(o.quit) }) }

func (o *outbox) push(frame []byte) {
	o.mu.Lock()
	if o.closed {
		o.mu.Unlock()
		return
	}
	o.queue = append(o.queue, frame)
	o.mu.Unlock()
	o.signal()
}

func (o *outbox) signal() {
	select {
	case o.wake <- struct{}{}:
	default:
	}
}

// fail gives the connection up: queued frames are dropped, and the loop
// closes the connection, which ends the read loop. It never blocks: send
// calls it from inside doc transactions.
func (o *outbox) fail(err error) {
	o.mu.Lock()
	if o.failed == nil {
		o.failed = err
	}
	o.closed = true
	o.queue = nil
	o.mu.Unlock()
	o.quitNow()
	o.signal()
}

// failure is why this side gave the connection up, if it did.
func (o *outbox) failure() error {
	o.mu.Lock()
	defer o.mu.Unlock()
	return o.failed
}

func (o *outbox) loop() {
	defer close(o.done)
	for {
		o.mu.Lock()
		queue := o.queue
		o.queue = nil
		closed, failed := o.closed, o.failed
		o.mu.Unlock()
		if failed != nil {
			_ = o.conn.Close()
			return
		}
		for _, frame := range queue {
			if !o.wait(o.pace.take(len(frame))) {
				return
			}
			if err := o.conn.Write(context.Background(), frame); err != nil {
				o.mu.Lock()
				o.closed = true
				o.queue = nil
				o.mu.Unlock()
				// The read loop may never hear of it (a connection dropped
				// without a close reaching us), so end the connection, and
				// with it the read loop. Not a failure: a close the relay
				// sent first still says why the connection ended.
				_ = o.conn.Close()
				return
			}
		}
		if closed && len(queue) == 0 {
			return
		}
		if len(queue) == 0 {
			<-o.wake
		}
	}
}

// wait waits d before the next frame, unless the queue is dropped meanwhile,
// and tells whether to go on. Draining waits too: going over the allowance
// would close the connection before the edits still queued reach the room.
func (o *outbox) wait(d time.Duration) bool {
	if d <= 0 {
		return true
	}
	timer := time.NewTimer(d)
	defer timer.Stop()
	select {
	case <-timer.C:
		return true
	case <-o.quit:
		// Given up: close the connection, which ends the read loop.
		if o.failure() != nil {
			_ = o.conn.Close()
		}
		return false
	}
}

// drain stops accepting frames and waits (for a while) until the queued ones are written.
func (o *outbox) drain() {
	o.mu.Lock()
	o.closed = true
	o.mu.Unlock()
	o.signal()
	select {
	case <-o.done:
	case <-time.After(5 * time.Second):
	}
}

// stop discards queued frames without waiting.
func (o *outbox) stop() {
	o.mu.Lock()
	o.closed = true
	o.queue = nil
	o.mu.Unlock()
	o.quitNow()
	o.signal()
}
