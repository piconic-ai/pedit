package protocol

import (
	"errors"
	"fmt"
	"time"

	"github.com/reearth/ygo/crdt"
	"github.com/reearth/ygo/encoding"
	ysync "github.com/reearth/ygo/sync"
)

// A room that shares several files keeps each in a Y.Doc of its own, synced
// like the Client's Doc but in FilesDoc messages that name the file. The
// Client's Doc is file 0, so a peer that knows nothing of files goes on
// editing it, and Awareness stays one for the room.

// fileDoc is a file's Y.Doc that the Client keeps in sync.
type fileDoc struct {
	doc    *crdt.Doc
	check  UpdateCheck
	unsub  func()
	synced bool

	// When the Client may next ask the room for what the check refused, and
	// the timer that asks then; under Client.applying.
	resyncAt    time.Time
	resyncTimer *time.Timer
}

// timeShare is the time checking and applying updates may still take, as of
// when it was last counted. Its zero value has a second in hand.
type timeShare struct {
	credit  time.Duration
	counted time.Time
	now     func() time.Time // time.Now when nil; tests set it
}

func (s *timeShare) clock() time.Time {
	if s.now == nil {
		return time.Now()
	}
	return s.now()
}

// UpdateCheck tells whether an update received for doc may be applied. It is
// called under the lock updates are applied under. An error that wraps
// ErrRetryLater refuses an update for now only: the Client asks the room for
// what it is missing again.
type UpdateCheck func(doc *crdt.Doc, update []byte) error

// ErrRetryLater marks an update refused for now: one that needs updates not
// received yet, or one that came while the checks had taken their share of
// the time. The Client sends the room a SyncStep1 for the file then, at most
// every resyncEvery, so an honest peer's updates come back whole, with
// everything the refused one needed.
var ErrRetryLater = errors.New("refused for now")

// Checking and applying the updates of checked files, all together, may take
// a quarter of the time, with up to a second in hand, so a peer flooding the
// room cannot keep the Client busy.
const (
	checkShare = 4
	checkBurst = time.Second
)

// resyncEvery spaces out the Client's asking again; tests shorten it.
var resyncEvery = 5 * time.Second

// AddFile keeps doc in sync with the room as the file with this ID, from 1
// up (file 0 is the Client's Doc): it sends
// the doc's state now if connected, and on every connection after. Messages
// about a file that was not added are dropped, so a peer only follows the
// files it added.
func (c *Client) AddFile(id uint64, doc *crdt.Doc) error {
	return c.AddCheckedFile(id, doc, nil)
}

// AddCheckedFile is AddFile for a doc whose updates, anyone in the room's,
// must pass check before they are applied; one that does not is dropped,
// and reported to OnError.
func (c *Client) AddCheckedFile(id uint64, doc *crdt.Doc, check UpdateCheck) error {
	if id == 0 || id > MaxFileID {
		return fmt.Errorf("invalid file id %d", id)
	}
	// Subscribed outside c.mu: an update in another goroutine holds the
	// doc's lock while it sends, which takes c.mu.
	f := &fileDoc{doc: doc, check: check}
	f.unsub = doc.OnUpdate(func(update []byte, origin any) {
		if origin == c {
			return
		}
		_ = c.sendFile(id, MessageSync, ysync.EncodeUpdate(update))
	})
	c.mu.Lock()
	err := func() error {
		if c.destroyed {
			return errors.New("client destroyed")
		}
		if _, ok := c.files[id]; ok {
			return fmt.Errorf("file %d added twice", id)
		}
		if c.files == nil {
			c.files = map[uint64]*fileDoc{}
		}
		c.files[id] = f
		return nil
	}()
	c.mu.Unlock()
	if err != nil {
		f.unsub()
		return err
	}
	c.syncFile(id, doc)
	return nil
}

// SetManifest tells the room which files it shares, now and to everyone
// who connects later. Only the host sends one.
func (c *Client) SetManifest(files []FileEntry) error {
	payload, err := EncodeManifest(files)
	if err != nil {
		return err
	}
	c.mu.Lock()
	c.manifest = payload
	c.mu.Unlock()
	c.send(MessageFiles, payload)
	return nil
}

// SendFileAttachment sends an attachment message about one file to everyone
// else in the room. Like every other frame, it is dropped while disconnected.
func (c *Client) SendFileAttachment(id uint64, a Attachment) error {
	payload, err := EncodeAttachment(a)
	if err != nil {
		return err
	}
	return c.sendFile(id, MessageAttachment, payload)
}

// SendFileCanvas sends a canvas message about one file to everyone else in
// the room. Like every other frame, it is dropped while disconnected.
func (c *Client) SendFileCanvas(id uint64, m CanvasMessage) error {
	payload, err := EncodeCanvas(m)
	if err != nil {
		return err
	}
	return c.sendFile(id, MessageCanvas, payload)
}

// FileStateFrameBytes is StateFrameBytes for a file's doc: the size on the
// wire of the frame that carries its whole state. A file whose state is over
// MaxFrameBytes cannot be shared.
func FileStateFrameBytes(id uint64, doc *crdt.Doc) int {
	return FrameBytes(len(fileStep2(id, doc)))
}

func fileStep2(id uint64, doc *crdt.Doc) []byte {
	enc := encoding.NewEncoder()
	enc.WriteVarUint(uint64(FilesDoc))
	enc.WriteVarUint(id)
	return append(enc.Bytes(), EncodeMessage(MessageSync, syncStep2(doc))...)
}

// syncFile sends a file's state to the room, as serve does for the Doc, if
// connected.
func (c *Client) syncFile(id uint64, doc *crdt.Doc) {
	c.mu.Lock()
	out := c.out
	c.mu.Unlock()
	if out == nil {
		return
	}
	step2 := fileStep2(id, doc)
	if FrameBytes(len(step2)) > MaxFrameBytes {
		out.fail(ErrFrameTooLarge)
		return
	}
	_ = c.sendFile(id, MessageSync, ysync.EncodeSyncStep1(doc))
	c.send(MessageFiles, step2)
}

// syncFiles sends the manifest and the state of every file, on connecting.
func (c *Client) syncFiles() {
	c.mu.Lock()
	manifest := c.manifest
	files := make(map[uint64]*crdt.Doc, len(c.files))
	for id, f := range c.files {
		files[id] = f.doc
	}
	c.mu.Unlock()
	if manifest != nil {
		c.send(MessageFiles, manifest)
	}
	for id, doc := range files {
		c.syncFile(id, doc)
	}
}

// sendManifest sends the manifest again, if this Client has one.
func (c *Client) sendManifest() {
	c.mu.Lock()
	manifest := c.manifest
	c.mu.Unlock()
	if manifest != nil {
		c.send(MessageFiles, manifest)
	}
}

func (c *Client) sendFile(id uint64, t MessageType, payload []byte) error {
	envelope, err := EncodeFileDoc(id, t, payload)
	if err != nil {
		return err
	}
	c.send(MessageFiles, envelope)
	return nil
}

func (c *Client) receiveFiles(payload []byte) error {
	m, err := DecodeFiles(payload)
	if errors.Is(err, ErrUnknownFilesKind) || errors.Is(err, ErrUnknownMessageType) {
		return nil
	}
	if err != nil {
		return err
	}
	if m.Kind == FilesManifest {
		if c.opts.OnManifest != nil {
			c.opts.OnManifest(m.Files)
		}
		return nil
	}
	switch m.Type {
	case MessageSync:
		return c.receiveFileSync(m.File, m.Payload)
	case MessageAttachment:
		a, err := DecodeAttachment(m.Payload)
		if errors.Is(err, ErrUnknownAttachmentKind) {
			return nil
		}
		if err != nil {
			return err
		}
		if c.opts.OnFileAttachment != nil {
			c.opts.OnFileAttachment(m.File, a)
		}
	case MessageCanvas:
		cm, err := DecodeCanvas(m.Payload)
		if errors.Is(err, ErrUnknownCanvasKind) {
			return nil
		}
		if err != nil {
			return err
		}
		if c.opts.OnFileCanvas != nil {
			c.opts.OnFileCanvas(m.File, cm)
		}
	}
	return nil
}

func (c *Client) receiveFileSync(id uint64, payload []byte) error {
	c.mu.Lock()
	f := c.files[id]
	c.mu.Unlock()
	if f == nil {
		return nil
	}
	c.applying.Lock()
	kind, reply, err := f.apply(payload, c, &c.checks)
	resync := errors.Is(err, ErrRetryLater) && c.askAgain(id, f)
	c.applying.Unlock()
	if resync {
		_ = c.sendFile(id, MessageSync, ysync.EncodeSyncStep1(f.doc))
	}
	if err != nil {
		return fmt.Errorf("file %d: %w", id, err)
	}
	if len(reply) > 0 {
		_ = c.sendFile(id, MessageSync, reply)
	}
	if kind == ysync.MsgSyncStep2 {
		c.mu.Lock()
		first := !f.synced
		f.synced = true
		c.mu.Unlock()
		if first && c.opts.OnFileSynced != nil {
			c.opts.OnFileSynced(id)
		}
	}
	return nil
}

// apply applies a sync message, after its check, if it has one, and returns
// its kind. A panic in ygo on a checked doc's message is an error: such a
// doc takes updates from anyone in the room, and the host's process is the
// session.
func (f *fileDoc) apply(payload []byte, origin any, share *timeShare) (kind int, reply []byte, err error) {
	kind, update, err := ysync.ReadSyncMessage(payload)
	if err != nil {
		return 0, nil, err
	}
	if f.check != nil {
		defer func() {
			if r := recover(); r != nil {
				reply, err = nil, fmt.Errorf("sync message makes ygo panic: %v", r)
			}
		}()
	}
	if f.check == nil || kind != ysync.MsgSyncStep2 && kind != ysync.MsgUpdate {
		reply, err = ysync.ApplySyncMessage(f.doc, payload, origin)
		return kind, reply, err
	}
	reply, err = share.take(func() ([]byte, error) {
		if err := f.check(f.doc, update); err != nil {
			return nil, err
		}
		return ysync.ApplySyncMessage(f.doc, payload, origin)
	})
	return kind, reply, err
}

// take checks and applies an update, in apply, unless that took its share
// of the time already. The time counted takes in what the doc's observers
// do with the update, such as placing the anchors of comments. The caller
// holds Client.applying.
func (s *timeShare) take(apply func() ([]byte, error)) ([]byte, error) {
	now := s.clock()
	if s.counted.IsZero() {
		s.credit = checkBurst
	} else {
		s.credit = min(checkBurst, s.credit+now.Sub(s.counted)/checkShare)
	}
	s.counted = now
	if s.credit <= 0 {
		return nil, fmt.Errorf("%w: checking updates took too long", ErrRetryLater)
	}
	defer func() {
		end := s.clock()
		s.credit -= end.Sub(now)
		s.counted = end
	}()
	return apply()
}

// askAgain has the Client ask the room for what a check refused for now:
// at once, telling the caller to, or once resyncEvery has passed since it
// last asked, so that an update refused while it waited is not left out.
// The caller holds Client.applying.
func (c *Client) askAgain(id uint64, f *fileDoc) bool {
	wait := f.resyncAt.Sub(c.checks.clock())
	if wait <= 0 {
		f.resyncAt = c.checks.clock().Add(resyncEvery)
		return true
	}
	if f.resyncTimer == nil {
		f.resyncTimer = time.AfterFunc(wait, func() {
			c.applying.Lock()
			f.resyncTimer = nil
			ask := c.askAgain(id, f)
			c.applying.Unlock()
			c.mu.Lock()
			destroyed := c.destroyed
			c.mu.Unlock()
			if ask && !destroyed {
				_ = c.sendFile(id, MessageSync, ysync.EncodeSyncStep1(f.doc))
			}
		})
	}
	return false
}

// unsubscribeFiles stops following every file's doc, on Destroy.
func (c *Client) unsubscribeFiles() {
	c.mu.Lock()
	files := c.files
	c.mu.Unlock()
	for _, f := range files {
		f.unsub()
	}
}
