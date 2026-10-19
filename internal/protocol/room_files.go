package protocol

import (
	"errors"
	"fmt"

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
	unsub  func()
	synced bool
}

// AddFile keeps doc in sync with the room as the file with this ID, from 1
// up (file 0 is the Client's Doc): it sends
// the doc's state now if connected, and on every connection after. Messages
// about a file that was not added are dropped, so a peer only follows the
// files it added.
func (c *Client) AddFile(id uint64, doc *crdt.Doc) error {
	if id == 0 || id > MaxFileID {
		return fmt.Errorf("invalid file id %d", id)
	}
	// Subscribed outside c.mu: an update in another goroutine holds the
	// doc's lock while it sends, which takes c.mu.
	f := &fileDoc{doc: doc}
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
	reply, err := ysync.ApplySyncMessage(f.doc, payload, c)
	c.applying.Unlock()
	if err != nil {
		return err
	}
	if len(reply) > 0 {
		_ = c.sendFile(id, MessageSync, reply)
	}
	if kind, _, err := ysync.ReadSyncMessage(payload); err == nil && kind == ysync.MsgSyncStep2 {
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

// unsubscribeFiles stops following every file's doc, on Destroy.
func (c *Client) unsubscribeFiles() {
	c.mu.Lock()
	files := c.files
	c.mu.Unlock()
	for _, f := range files {
		f.unsub()
	}
}
