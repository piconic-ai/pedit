package session

import (
	"bytes"
	"errors"
	"strings"
	"sync"
	"time"

	"github.com/piconic-ai/pedit/internal/meta"
	"github.com/piconic-ai/pedit/internal/protocol"
	"github.com/reearth/ygo/crdt"
)

// keptGuest is a command line guest's side of a room kept while its host is
// away, as the browser's KeptAway is (packages/protocol/src/kept-away-client.ts,
// docs/design/comments-cli.md): its changes go to the relay as signed,
// encrypted entries, and what the relay logged is applied with the checks
// the host makes. An entry is pending until the relay sends it back with an
// id, which acknowledges it.
type keptGuest struct {
	s    *Session
	keys *protocol.RoomKeys

	mu sync.Mutex
	// after is the last log entry held, for the next connection.
	after    uint64
	hasAfter bool
	// relay holds, by file, a copy of what the relay holds: the snapshot
	// and the log since.
	relay map[uint32]*relayCopy
	// files lists the files of the snapshot, as the host's manifest would.
	files   []protocol.FileEntry
	pending []keptPending
	// replayed is closed after the first replay ends.
	replayed chan struct{}
	once     sync.Once
	// acked is closed, and made anew, whenever an entry is acknowledged.
	acked chan struct{}
}

type relayCopy struct {
	doc   *crdt.Doc
	roots []string
	check func(*crdt.Doc, []byte) error
}

type keptPending struct {
	body   []byte
	id     uint32
	update []byte
}

func newKeptGuest(s *Session, keys *protocol.RoomKeys) *keptGuest {
	return &keptGuest{s: s, keys: keys, relay: map[uint32]*relayCopy{}, replayed: make(chan struct{}), acked: make(chan struct{})}
}

// cursor is the last log entry held, if any, for the after parameter.
func (k *keptGuest) cursor() (uint64, bool) {
	k.mu.Lock()
	defer k.mu.Unlock()
	return k.after, k.hasAfter
}

// onKind takes a message of kind 4, 5 or 6 from the relay. It runs on the
// read loop.
func (k *keptGuest) onKind(kind byte, payload []byte) {
	var err error
	switch kind {
	case protocol.KindReplay:
		err = k.snapshot(payload)
	case protocol.KindLogged:
		err = k.logged(payload)
	case protocol.KindLogEnd:
		tail, ok := protocol.DecodeLogEnd(payload)
		if !ok {
			err = errors.New("invalid log end")
		} else {
			k.logEnd(tail)
		}
	}
	if err != nil {
		k.s.onError(err)
	}
}

// snapshot takes the host's snapshot of every file: the start of the docs,
// and the files they are.
func (k *keptGuest) snapshot(bundle []byte) error {
	files, err := protocol.OpenKeptBundle(k.keys, bundle)
	if err != nil {
		return err
	}
	listed := keptManifest(files)
	k.mu.Lock()
	k.files = listed
	k.relay = map[uint32]*relayCopy{}
	k.mu.Unlock()
	for i, f := range files {
		c := k.copyOf(f.ID, listed[i].Format)
		if err := applyChecked(c, f.Update); err != nil {
			k.s.onError(err)
		}
	}
	for id, doc := range k.s.keptDocs() {
		k.adopt(id, doc)
	}
	k.s.takeKeptManifest(listed)
	return nil
}

// keptManifest lists the files of a snapshot as the host's manifest does: a
// file whose path is the metadata path of another holds its comments.
func keptManifest(files []protocol.KeptFileSnapshot) []protocol.FileEntry {
	paths := map[string]bool{}
	for _, f := range files {
		paths[protocol.MetaPath(f.Path)] = true
	}
	out := make([]protocol.FileEntry, 0, len(files))
	for _, f := range files {
		format := protocol.FormatText
		switch {
		case paths[f.Path]:
			format = protocol.FormatMeta
		case strings.HasSuffix(strings.ToLower(f.Path), ".canvas"):
			format = protocol.FormatCanvas
		}
		out = append(out, protocol.FileEntry{ID: uint64(f.ID), Path: f.Path, Format: format})
	}
	return out
}

// copyOf is the copy of what the relay holds of a file, made when first
// needed, checked by the roots of its format.
func (k *keptGuest) copyOf(id uint32, format string) *relayCopy {
	k.mu.Lock()
	defer k.mu.Unlock()
	if c := k.relay[id]; c != nil {
		return c
	}
	c := &relayCopy{doc: crdt.New(crdt.WithGC(false)), roots: []string{"content"}}
	switch format {
	case protocol.FormatMeta:
		c.roots, c.check = []string{protocol.KeptCommentsRoot}, meta.CheckUpdate
	case protocol.FormatCanvas:
		c.roots = nil // not followed from the command line; kept for the cursor only
	}
	k.relay[id] = c
	return c
}

// formatOf is the format the snapshot lists a file in, or, for a file it
// does not list, text.
func (k *keptGuest) formatOf(id uint32) (string, bool) {
	k.mu.Lock()
	defer k.mu.Unlock()
	if k.files == nil {
		return protocol.FormatText, true
	}
	for _, f := range k.files {
		if f.ID == uint64(id) {
			return f.Format, true
		}
	}
	return "", false
}

// applyChecked applies an update to a copy if it holds under the checks the
// host makes of an entry: its roots, the comments' own checks, and nothing
// left waiting for items that never come.
func applyChecked(c *relayCopy, update []byte) error {
	if c.roots == nil {
		return nil
	}
	if c.check != nil {
		if err := c.check(c.doc, update); err != nil {
			return err
		}
	}
	candidate := crdt.New(crdt.WithGC(false))
	defer candidate.Destroy()
	if err := crdt.ApplyUpdateV1(candidate, crdt.EncodeStateAsUpdateV1(c.doc, nil), nil); err != nil {
		return err
	}
	if err := applyKeptDoc(candidate, update, c.roots...); err != nil {
		return err
	}
	if !completeKeptText(candidate) {
		return errors.New("incomplete kept update")
	}
	return crdt.ApplyUpdateV1(c.doc, update, nil)
}

// adopt brings a doc of the guest up to date with the relay's copy of its
// file, as the browser does with a file opened after the replay.
func (k *keptGuest) adopt(id uint32, doc *crdt.Doc) {
	k.mu.Lock()
	c := k.relay[id]
	k.mu.Unlock()
	if c == nil || c.roots == nil {
		return
	}
	state := crdt.EncodeStateAsUpdateV1(c.doc, nil)
	k.s.Client.Do(func() { _ = crdt.ApplyUpdateV1(doc, state, k.s.Client) })
}

// logged takes an entry of the log: the guest's own, which acknowledges it,
// or someone else's, applied if it holds.
func (k *keptGuest) logged(payload []byte) error {
	id, entry, ok := protocol.DecodeLogged(payload)
	if !ok {
		return errors.New("invalid logged entry")
	}
	k.mu.Lock()
	k.after, k.hasAfter = max(k.after, id), true
	own := -1
	for i, p := range k.pending {
		if bytes.Equal(p.body, entry) {
			own = i
		}
	}
	var mine keptPending
	if own >= 0 {
		mine = k.pending[own]
		k.pending = append(k.pending[:own], k.pending[own+1:]...)
		close(k.acked)
		k.acked = make(chan struct{})
	}
	k.mu.Unlock()
	if own >= 0 {
		format, _ := k.formatOf(mine.id)
		// Our own edit: it is in our doc, whatever the copy makes of it.
		_ = applyChecked(k.copyOf(mine.id, format), mine.update)
		return nil
	}
	file, update, err := protocol.OpenKeptFileUpdate(k.keys, entry)
	if err != nil {
		return err
	}
	format, listed := k.formatOf(file)
	if !listed {
		return errors.New("an entry for a file the room does not have")
	}
	if err := applyChecked(k.copyOf(file, format), update); err != nil {
		return err
	}
	if doc := k.s.keptDocs()[file]; doc != nil {
		k.s.Client.Do(func() { err = crdt.ApplyUpdateV1(doc, update, k.s.Client) })
	}
	return err
}

// logEnd ends a replay: the guest holds what the relay does. What its docs
// hold that the relay lacks, such as changes made while it was not
// connected, it sends as entries.
func (k *keptGuest) logEnd(tail uint64) {
	k.mu.Lock()
	k.after, k.hasAfter = max(k.after, tail), true
	k.pending = nil
	k.mu.Unlock()
	for id, doc := range k.s.keptDocs() {
		k.mu.Lock()
		c := k.relay[id]
		k.mu.Unlock()
		if c == nil || c.roots == nil || !lacks(c.doc, doc) {
			continue
		}
		k.send(uint64(id), crdt.EncodeStateAsUpdateV1(doc, c.doc.StateVector()))
	}
	k.once.Do(func() { close(k.replayed) })
}

// lacks tells whether relay lacks something doc holds: a struct, or a
// deletion.
func lacks(relay, doc *crdt.Doc) bool {
	has := relay.StateVector()
	for client, clock := range doc.StateVector() {
		if clock > has[client] {
			return true
		}
	}
	deleted := crdt.DeleteSetFromDoc(relay)
	mine := crdt.DeleteSetFromDoc(doc)
	for _, client := range mine.Clients() {
		for _, r := range mine.Ranges(client) {
			for clock := r.Clock; clock < r.Clock+r.Len; clock++ {
				if !deleted.Has(client, clock) {
					return true
				}
			}
		}
	}
	return false
}

// send seals an update of a doc as an entry and sends it, held until the
// relay logs it. Only editors write while the host is away.
func (k *keptGuest) send(id uint64, update []byte) {
	if k.keys.Access != protocol.AccessEdit || id > uint64(^uint32(0)) {
		return
	}
	body, err := protocol.SealKeptFileUpdate(k.keys, uint32(id), update)
	if err != nil {
		k.s.onError(err)
		return
	}
	k.mu.Lock()
	k.pending = append(k.pending, keptPending{body: body, id: uint32(id), update: update})
	k.mu.Unlock()
	k.s.Client.SendMessage(protocol.WithKind(protocol.KindEntry, body))
}

// settle lets go of what is held: the host is back and takes the state.
func (k *keptGuest) settle() {
	k.mu.Lock()
	defer k.mu.Unlock()
	k.relay = map[uint32]*relayCopy{}
	k.files = nil
	k.pending = nil
	k.hasAfter = false
	close(k.acked)
	k.acked = make(chan struct{})
}

// waitLogged waits until the relay logged every entry pending for file id,
// or deliveryWait passes.
func (k *keptGuest) waitLogged(id uint64) bool {
	give := time.NewTimer(deliveryWait)
	defer give.Stop()
	for {
		k.mu.Lock()
		waiting := false
		for _, p := range k.pending {
			waiting = waiting || uint64(p.id) == id
		}
		acked := k.acked
		k.mu.Unlock()
		if !waiting {
			return true
		}
		select {
		case <-acked:
		case <-give.C:
			return false
		}
	}
}

// keptDocs are the docs a joined session follows, by file: its first file,
// the files it mirrors, and their comments.
func (s *Session) keptDocs() map[uint32]*crdt.Doc {
	docs := map[uint32]*crdt.Doc{}
	s.filesMu.Lock()
	for _, f := range s.files() {
		docs[uint32(f.id)] = f.doc
	}
	s.filesMu.Unlock()
	for _, c := range s.guest.list() {
		docs[uint32(c.id)] = c.doc
	}
	return docs
}

// takeKeptManifest takes the files a kept room's snapshot lists as the
// host's manifest, and brings the comments docs it joins up to date with
// the relay's copies.
func (s *Session) takeKeptManifest(files []protocol.FileEntry) {
	s.takeManifest(files)
	s.guest.takeManifest(files)
	for _, c := range s.guest.list() {
		s.kept.adopt(uint32(c.id), c.doc)
		s.guest.synced(c.id)
	}
}

// orFirstFile is the host's state, or with no host (a room kept while it is
// away), the first file of the snapshot as a host's state names it: its
// path, and whether it is a canvas.
func (k *keptGuest) orFirstFile(host map[string]any) map[string]any {
	if host != nil {
		return host
	}
	k.mu.Lock()
	defer k.mu.Unlock()
	for _, f := range k.files {
		if f.ID == 0 {
			state := map[string]any{"file": f.Path}
			if f.Format == protocol.FormatCanvas {
				state["format"] = formatCanvas
			}
			return state
		}
	}
	return map[string]any{}
}
