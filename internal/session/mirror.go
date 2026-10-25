package session

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sync/atomic"

	"github.com/piconic-ai/pedit/internal/filewriter"
	"github.com/piconic-ai/pedit/internal/protocol"
	"github.com/reearth/ygo/crdt"
)

// A guest from the command line mirrors each text file the room shares into
// the directory of its first copy, as each list arrives. The list comes from
// the room, and anyone in it can send one, so a path in it only names the
// copy (copyName): no directory is made, and no name is taken as the host
// gives it. A file is never written over.

// Why a file of the room is not mirrored.
var (
	errNotText = errors.New("it is a canvas, which only a browser can open; open the link in a browser")
	errTooMany = fmt.Errorf("a room mirrors up to %d files", MaxFiles)
	errBadID   = errors.New("its id is out of range")
)

// mirror is what a joined session needs to mirror the room's other files.
type mirror struct {
	dir string
	// root is dir, opened when joining: every copy is made through it.
	root *os.Root
	opts JoinOptions
	// started is set once the first copy is in place.
	started bool
	// done holds the ids seen, mirrored or not, so each is reported once.
	done map[uint64]bool
	// latest is the last list, kept until the first copy is in place.
	latest atomic.Pointer[[]protocol.FileEntry]
}

// takeManifest mirrors the room's files as the host lists them. It is called
// on the client's read loop, so the work goes to its own goroutine.
func (s *Session) takeManifest(files []protocol.FileEntry) {
	if s.mirror == nil {
		return
	}
	s.mirror.latest.Store(&files)
	go func() {
		s.mirrorMu.Lock()
		defer s.mirrorMu.Unlock()
		if !s.mirror.started {
			// The first copy is not in place yet: Join mirrors this list then.
			return
		}
		s.mirrorFiles(files)
	}()
}

// startMirror begins mirroring once the first copy is in place. The caller
// holds s.mirrorMu.
func (s *Session) startMirror() {
	s.mirror.started = true
	if latest := s.mirror.latest.Load(); latest != nil {
		s.mirrorFiles(*latest)
	}
}

// mirrorFiles mirrors the files of a list not seen before. The caller holds
// s.mirrorMu.
func (s *Session) mirrorFiles(files []protocol.FileEntry) {
	m := s.mirror
	for _, entry := range files {
		if entry.ID == 0 || m.done[entry.ID] {
			continue
		}
		m.done[entry.ID] = true
		path, err := s.mirrorFile(entry)
		if m.opts.OnMirrored != nil {
			m.opts.OnMirrored(entry.Path, path, err)
		}
	}
}

// mirrorFile makes the copy of entry and returns its path, also when it
// could not.
func (s *Session) mirrorFile(entry protocol.FileEntry) (string, error) {
	m := s.mirror
	name := copyName(entry.ID, entry.Path)
	file := filepath.Join(m.dir, name)
	if entry.ID > protocol.MaxFileID {
		// DecodeFiles refuses it; a list made by hand gets the same.
		return file, errBadID
	}
	if entry.Format != protocol.FormatText {
		return file, errNotText
	}
	s.filesMu.Lock()
	full := len(s.files()) >= MaxFiles
	closed := s.closed
	s.filesMu.Unlock()
	if closed {
		return file, errors.New("the session has ended")
	}
	if full {
		return file, errTooMany
	}

	if _, err := m.root.Lstat(name); err == nil {
		return file, &ErrFileExists{Path: file}
	} else if !errors.Is(err, os.ErrNotExist) {
		return file, err
	}
	bound, err := filewriter.OpenBoundIn(m.root, name)
	if err != nil {
		return file, err
	}
	// The copy is new: a file that appears at its name is never replaced.
	bound.CreateOnly()
	if err := bound.Write("", ""); err != nil {
		_ = bound.Close()
		return file, err
	}

	doc := crdt.New()
	f := &sharedFile{
		id:         entry.ID,
		file:       file,
		path:       entry.Path,
		doc:        doc,
		bound:      bound,
		content:    newTextContent(doc, ""),
		client:     s.Client,
		onError:    s.onError,
		notices:    newNotices(file, m.opts.OnNotice, s.onError),
		sendCanvas: func(c protocol.CanvasMessage) error { return s.Client.SendFileCanvas(entry.ID, c) },
	}
	w := filewriter.New(file, "", filewriter.Options{
		Bound:            bound,
		Delay:            m.opts.WriteDelay,
		OnError:          f.notices.saveError,
		OnWritten:        f.notices.written,
		OnExternalChange: f.scheduleSyncFromDisk,
	})
	doc.OnUpdate(func(_ []byte, origin any) {
		if origin != s.Client {
			return
		}
		f.mu.Lock()
		w := f.Writer
		f.mu.Unlock()
		if w != nil {
			w.Schedule(f.content.render())
		}
	})
	// Published under the client's lock, so no remote edit lands between it
	// and the doc being followed; the room's state arrives after.
	s.Client.Do(func() {
		f.mu.Lock()
		f.Writer = w
		f.mu.Unlock()
	})

	s.filesMu.Lock()
	if s.closed {
		// Stopped meanwhile: Stop saves only the files it found.
		s.filesMu.Unlock()
		_ = bound.Close()
		return file, errors.New("the session has ended")
	}
	if err := s.watchFile(f); err != nil {
		s.filesMu.Unlock()
		_ = bound.Close()
		return file, err
	}
	s.added = append(s.added, f)
	s.filesMu.Unlock()
	if err := s.Client.AddFile(entry.ID, doc); err != nil {
		s.onError(err)
	}
	f.notices.start()
	return file, nil
}
