package session

import (
	"errors"
	"path/filepath"
	"sync"
	"time"

	"github.com/piconic-ai/pedit/internal/meta"
	"github.com/piconic-ai/pedit/internal/protocol"
	"github.com/reearth/ygo/crdt"
)

// keepAway is the host's side of a room the relay keeps while the host is away
// (docs/design/rooms-away.md): it sends the relay snapshots of the files and
// writes the record --resume reads. resumeAway takes in the log.

// A snapshot is due after snapshotEntries changes, or snapshotEvery with
// changes. Tests change them before Start.
var (
	snapshotEntries = 200
	snapshotEvery   = 5 * time.Minute
)

type keepAway struct {
	s *Session
	// h holds the record, the keys and, as its files, the live docs.
	h       *keptTextHost
	files   []*sharedFile // in the record's order
	every   time.Duration
	entries int
	// resumed: the first connection came from resumeAway, which has just
	// checkpointed the state.
	resumed bool

	// recMu orders the record's changes and snapshots, which read it.
	recMu sync.Mutex

	mu      sync.Mutex
	changes int
	dirty   bool
	granted int64  // seconds the relay keeps the room, once it said so
	told    int64  // what OnKeep was last called with; -1 before
	after   uint64 // the last entry of the relay's log taken in
	logged  bool   // entries of the log were taken in since the last checkpoint
	skipped int
	kick    chan struct{}
	done    chan struct{}
	stopped sync.WaitGroup
}

// startAway makes the record of the room (or takes over the one resumeAway
// kept) and follows its docs. The session holds its files, and is not
// connected yet.
func (s *Session) startAway(hostToken, fragment string, res *resumed) error {
	if s.opts.Project == "" {
		return errors.New("--keep needs a project directory for the resume record")
	}
	project, err := filepath.Abs(s.opts.Project)
	if err != nil {
		return err
	}
	project = filepath.Clean(project)
	directory, err := keptTextDirectory(project)
	if err != nil {
		return err
	}
	a := &keepAway{s: s, every: snapshotEvery, entries: snapshotEntries, told: -1, kick: make(chan struct{}, 1), done: make(chan struct{})}
	h := &keptTextHost{room: s.roomID, keys: s.Client.Keys(), files: map[uint32]*keptTextDocument{}, project: s.project}
	h.dir, h.path = directory, filepath.Join(directory, s.roomID+".json")
	s.filesMu.Lock()
	a.files = s.files()
	s.filesMu.Unlock()
	if res != nil {
		h.state, a.after, a.resumed = res.state, res.state.After, true
		// The relay's word on the keep came before this connection was adopted.
		if a.granted = res.keep; a.granted == 0 {
			a.granted = res.state.Keep
		}
	} else if h.state, err = a.newRecord(project, fragment, hostToken); err != nil {
		return err
	}
	if len(h.state.Files) != len(a.files) {
		return errors.New("the files differ from the resume record")
	}
	for i, file := range h.state.Files {
		f := a.files[i]
		if file.File != f.file {
			return errors.New("the files differ from the resume record")
		}
		h.files[file.ID] = &keptTextDocument{doc: f.doc}
		a.follow(f.doc)
		if file.Meta != nil && f.meta != nil {
			h.files[file.Meta.ID] = &keptTextDocument{doc: f.meta.doc, root: protocol.KeptCommentsRoot}
			a.follow(f.meta.doc)
		}
	}
	a.h = h
	s.away = a
	a.stopped.Add(1)
	go a.loop()
	return nil
}

// newRecord lists the files a new kept room starts with.
func (a *keepAway) newRecord(project, fragment, hostToken string) (keptTextState, error) {
	state := keptTextState{Project: project, Origin: a.s.server, Fragment: fragment, HostToken: hostToken, Socket: true, Keep: int64(a.s.opts.Keep / time.Second)}
	for i, f := range a.files {
		path, err := keptPath(project, f.file, len(a.files) > 1)
		if err != nil {
			return state, err
		}
		if _, ok := f.content.(*textContent); !ok {
			return state, errors.New("--keep shares text files, not " + filepath.Base(f.file))
		}
		file := keptTextFileState{ID: uint32(i), Path: path, File: f.file}
		if f.meta != nil {
			file.Meta = &keptMetaState{ID: keptMetaIDBase + uint32(i), Name: filepath.ToSlash(f.meta.name)}
		}
		state.Files = append(state.Files, file)
	}
	return state, nil
}

func (a *keepAway) follow(doc *crdt.Doc) {
	doc.OnUpdate(func([]byte, any) {
		a.mu.Lock()
		a.changes++
		a.dirty = true
		full := a.changes >= a.entries
		a.mu.Unlock()
		if full {
			select {
			case a.kick <- struct{}{}:
			default:
			}
		}
	})
}

// loop sends a snapshot when enough changes were taken in, or enough time
// passed with changes.
func (a *keepAway) loop() {
	defer a.stopped.Done()
	ticker := time.NewTicker(a.every)
	defer ticker.Stop()
	for {
		select {
		case <-a.kick:
			a.snapshot()
		case <-ticker.C:
			a.mu.Lock()
			dirty := a.dirty
			a.mu.Unlock()
			if dirty {
				a.snapshot()
			}
		case <-a.done:
			return
		}
	}
}

// connected sends the first snapshot, so a drop never finds the room without
// one, or says that the relay cannot keep the room.
func (a *keepAway) connected() {
	if a.s.Client.Version() < 6 {
		a.tell(0)
		return
	}
	a.mu.Lock()
	skip := a.resumed
	a.resumed = false
	a.mu.Unlock()
	if !skip {
		a.snapshot()
	}
}

// tell reports the keep to OnKeep, unless it did already: the relay says it on every connection.
func (a *keepAway) tell(seconds int64) {
	a.mu.Lock()
	same := a.told == seconds
	a.told = seconds
	a.mu.Unlock()
	if !same {
		a.s.opts.OnKeep(seconds)
	}
}

// snapshot sends the relay the files as they are, and records them.
func (a *keepAway) snapshot() {
	a.recMu.Lock()
	frame, err := a.h.snapshot()
	a.recMu.Unlock()
	if err == nil && a.s.Client.SendMessage(protocol.WithKind(protocol.KindSnapshot, frame)) {
		a.mu.Lock()
		a.changes, a.dirty = 0, false
		a.mu.Unlock()
		err = a.saveRecord(false)
	}
	a.report(err)
}

// saveRecord writes the record with the files as they are now. A file whose
// disk is not what the doc holds yet (the writer is still at it) keeps its
// last state in the record, which has to be one the file can be checked
// against; leaving is the exception, with the files saved. It gives the
// room's deadline too, when the host is leaving.
func (a *keepAway) saveRecord(leaving bool) error {
	a.recMu.Lock()
	defer a.recMu.Unlock()
	a.mu.Lock()
	granted, after := a.granted, a.after
	a.mu.Unlock()
	if granted == 0 {
		return nil
	}
	state := a.h.state
	state.Files = append([]keptTextFileState{}, state.Files...)
	a.s.Client.Do(func() {
		for i := range state.Files {
			file := &state.Files[i]
			live := a.h.files[file.ID].doc
			text := live.GetText("content").ToString()
			if disk, ok := a.files[i].bound.Read(); ok && disk == text {
				file.State, file.Text, file.Pending = crdt.EncodeStateAsUpdateV1(live, nil), text, nil
			}
			if m := file.Meta; m != nil && a.h.files[m.ID] != nil {
				meta := *m
				meta.State, meta.Pending = crdt.EncodeStateAsUpdateV1(a.h.files[m.ID].doc, nil), nil
				meta.Text, _ = a.h.readKeptMeta(m)
				file.Meta = &meta
			}
		}
	})
	state.Keep, state.After, state.Initialized = granted, after, true
	// While the host is here the deadline is unknown: if it dies without
	// leaving, the relay starts a fresh keep period, so an old deadline would
	// wrongly mark the record as dead.
	state.Until = 0
	if leaving {
		state.Until = time.Now().Add(time.Duration(granted) * time.Second).UnixMilli()
	}
	a.h.state = state
	return saveKeptState(a.h.path, state)
}

// checkpoint tells the relay it can drop its log up to tail, which the live
// docs hold.
func (a *keepAway) checkpoint(tail uint64) {
	a.recMu.Lock()
	frame, err := a.h.snapshot()
	a.recMu.Unlock()
	if err == nil {
		a.s.Client.SendMessage(protocol.EncodeCheckpoint(tail, frame))
	}
	a.report(err)
}

// onText takes the relay's word on the keep and on checkpoints.
func (a *keepAway) onText(text string) {
	if seconds, _, ok := protocol.ParseKeep(text); ok {
		a.mu.Lock()
		first := a.granted == 0
		a.granted = seconds
		a.mu.Unlock()
		if first && seconds > 0 {
			a.report(a.saveRecord(false))
		}
		a.tell(seconds)
	} else if cutoff, _, ok := protocol.ParseCheckpoint(text); ok {
		a.mu.Lock()
		a.after, a.logged = cutoff, false
		a.mu.Unlock()
		a.report(a.saveRecord(false))
	} else if text == protocol.CheckpointRefused || text == protocol.LogFull {
		a.report(errors.New("the relay said: " + text))
	}
}

func (a *keepAway) report(err error) {
	if err != nil {
		a.s.opts.OnError(err)
	}
}

// onKind takes in the entries guests send while the host is here but has not
// been heard of yet (kind 1), and the log the relay replays to a host that
// dropped for so long that the room was kept without it (kinds 4 and 6): the
// host checkpoints once it has it.
func (a *keepAway) onKind(kind byte, payload []byte) {
	switch kind {
	case protocol.KindEntry:
		a.takeIn(payload)
	case protocol.KindLogged:
		id, entry, ok := protocol.DecodeLogged(payload)
		a.mu.Lock()
		fresh := ok && id > a.after
		if fresh {
			a.after, a.logged = id, true
		}
		a.mu.Unlock()
		if fresh {
			a.takeIn(entry)
		}
	case protocol.KindLogEnd:
		a.mu.Lock()
		logged := a.logged
		a.mu.Unlock()
		if tail, ok := protocol.DecodeLogEnd(payload); ok && logged {
			a.checkpoint(tail)
		}
	}
}

// takeIn applies an entry to the live doc it names, like a live update, if it
// passes the checks a kept room makes; any other is skipped and counted.
func (a *keepAway) takeIn(entry []byte) {
	id, update, err := protocol.OpenKeptFileUpdate(a.h.keys, entry)
	if err == nil {
		err = a.apply(id, update)
	}
	if err != nil {
		a.mu.Lock()
		a.skipped++
		skipped := a.skipped
		a.mu.Unlock()
		if a.s.opts.OnSkipped != nil {
			a.s.opts.OnSkipped(skipped)
		}
	}
}

func (a *keepAway) apply(id uint32, update []byte) error {
	d := a.h.files[id]
	if d == nil {
		return errors.New("an entry for a file the room does not have")
	}
	var err error
	a.s.Client.Do(func() {
		if d.root == protocol.KeptCommentsRoot {
			err = meta.CheckUpdate(d.doc, update)
		}
		// On a copy first: an update that leaves items waiting for others
		// that never come must not reach the file.
		candidate := crdt.New(crdt.WithGC(false))
		defer candidate.Destroy()
		if err == nil {
			err = crdt.ApplyUpdateV1(candidate, crdt.EncodeStateAsUpdateV1(d.doc, nil), nil)
		}
		if err == nil {
			err = d.apply(candidate, update)
		}
		if err == nil && !completeKeptText(candidate) {
			err = errors.New("incomplete kept update")
		}
		if err == nil {
			err = crdt.ApplyUpdateV1(d.doc, update, a.s.Client)
		}
	})
	return err
}

// leaving sends the last snapshot, before the session leaves the room.
func (a *keepAway) leaving() {
	close(a.done)
	a.stopped.Wait()
	a.snapshot()
}

// finish writes the record the host comes back by, once the files are saved.
func (a *keepAway) finish() error { return a.saveRecord(true) }

// KeptUntil is when the relay ends the room, if it keeps it now that the host
// has left, or the zero time if it does not.
func (s *Session) KeptUntil() time.Time {
	a := s.away
	if a == nil || s.Client.Status().Final() {
		return time.Time{}
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.granted == 0 {
		return time.Time{}
	}
	return time.Now().Add(time.Duration(a.granted) * time.Second)
}
