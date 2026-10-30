package session

import (
	"path/filepath"
	"sync"
	"time"
	"unicode/utf8"

	"github.com/piconic-ai/pedit/internal/attach"
	"github.com/piconic-ai/pedit/internal/filewriter"
	"github.com/piconic-ai/pedit/internal/protocol"
	"github.com/reearth/ygo/crdt"
)

// sharedFile is one file of a session and its doc: the room's own doc for
// the first file, a doc of its own for each file added after (#113).
type sharedFile struct {
	// Writer saves the doc to the file.
	Writer *filewriter.Writer
	bound  *filewriter.BoundFile

	// id is the file's id in the room's manifest; 0 for the room's own doc.
	id uint64
	// file is the local path, and path the one the room shows.
	file string
	path string
	doc  *crdt.Doc

	content content
	// meta keeps the file's comments, or is nil when it offers none.
	meta        *metaFile
	attachments *attach.Attachments
	notices     *notices
	client      *protocol.Client
	sendCanvas  func(protocol.CanvasMessage) error
	onError     func(error)

	mu        sync.Mutex
	readTimer *time.Timer
	stopped   bool

	// syncing serializes syncs from disk, and lets Stop wait out one in flight.
	syncing sync.Mutex
	// invalidOnDisk is the invalid content last reported, so it is reported
	// once. Guarded by syncing.
	invalidOnDisk string
}

// entry is the file in the room's manifest.
func (f *sharedFile) entry() protocol.FileEntry {
	return protocol.FileEntry{ID: f.id, Path: f.path, Format: f.format()}
}

// format is the file's format in the room's manifest.
func (f *sharedFile) format() string {
	if _, ok := f.content.(*canvasContent); ok {
		return protocol.FormatCanvas
	}
	return protocol.FormatText
}

func (f *sharedFile) scheduleSyncFromDisk() {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.stopped {
		return
	}
	if f.readTimer != nil {
		f.readTimer.Stop()
	}
	f.readTimer = time.AfterFunc(50*time.Millisecond, func() {
		f.syncing.Lock()
		defer f.syncing.Unlock()
		f.mu.Lock()
		stopped := f.stopped
		f.mu.Unlock()
		if !stopped {
			f.syncFromDisk()
		}
	})
}

// close lets go of the file and its metadata, once the session is over.
func (f *sharedFile) close() error {
	if f.meta != nil {
		f.meta.close()
	}
	if f.bound != nil {
		return f.bound.Close()
	}
	return nil
}

// stop stops reading the file on changes; Stop then saves it once more.
func (f *sharedFile) stop() {
	f.notices.stop()
	f.mu.Lock()
	f.stopped = true
	if f.readTimer != nil {
		f.readTimer.Stop()
	}
	f.mu.Unlock()
}

// syncFromDisk merges the file's current content into the doc if it changed
// outside pedit, against what we last wrote. The caller must hold f.syncing.
func (f *sharedFile) syncFromDisk() {
	// Nobody edits while the host is away: nobody would save it. What
	// changed is merged once the host is back (Session.resumeFromDisk).
	if f.client != nil && f.client.Status().HostAway() {
		return
	}
	changed := false
	// Told after Rebase, so not under the writer's lock.
	var notice *Notice
	// Rebase drops any pending write, which predates the merge.
	f.Writer.Rebase(func(lastWritten string) string {
		onDisk, ok := settle(f.bound.Read, 30*time.Millisecond, 10)
		if !ok {
			return lastWritten
		}
		if onDisk == lastWritten {
			// The file holds what pedit knows. A write skipped meanwhile
			// (the file was invalid, or changed and changed back) is saved
			// now; Flush skips it if nothing differs.
			if f.invalidOnDisk != "" {
				notice = &Notice{Kind: HoldReleased}
			}
			changed = true
			f.invalidOnDisk = ""
			return lastWritten
		}
		err := errNotUTF8
		if utf8.ValidString(onDisk) {
			f.client.Do(func() { err = f.content.merge(lastWritten, onDisk) })
		}
		if err != nil {
			// Wait for it to be fixed: saving now would clobber whatever
			// someone is in the middle of writing.
			if onDisk != f.invalidOnDisk {
				f.invalidOnDisk = onDisk
				n := held(filepath.Base(f.file), err)
				notice = &n
			}
			return lastWritten
		}
		if f.invalidOnDisk != "" {
			notice = &Notice{Kind: HoldReleased}
		}
		f.invalidOnDisk = ""
		changed = true
		if f.attachments != nil {
			f.attachments.AllowLocalChanges(lastWritten, onDisk)
		}
		return onDisk
	})
	if notice != nil {
		f.notices.send(*notice)
	}
	if changed {
		// Remote edits made meanwhile are not on disk yet.
		f.Writer.Schedule(f.render())
	}
}

// render returns the file as the doc has it now, under the client's lock so
// remote updates cannot change the doc while it is read.
func (f *sharedFile) render() string {
	var out string
	f.client.Do(func() { out = f.content.render() })
	return out
}

// handleCanvas applies JSON someone edited by hand in the browser, and tells
// the room whether it did.
func (f *sharedFile) handleCanvas(m protocol.CanvasMessage) {
	c, ok := f.content.(*canvasContent)
	if !ok || m.Kind != protocol.CanvasEdit {
		return
	}
	var err error
	f.client.Do(func() { err = c.edit(m.ID, m.Base, m.Next) })
	reply := protocol.CanvasMessage{Kind: protocol.CanvasApplied, ID: m.ID}
	if err != nil {
		reply = protocol.CanvasMessage{Kind: protocol.CanvasRejected, ID: m.ID, Reason: truncate(err.Error(), maxRejectReason)}
	}
	if err := f.sendCanvas(reply); err != nil {
		f.onError(err)
	}
}
