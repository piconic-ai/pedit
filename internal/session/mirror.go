package session

import (
	"errors"
	"fmt"
	"os"
	"path"
	"path/filepath"
	"strings"

	"github.com/piconic-ai/pedit/internal/filewriter"
	"github.com/piconic-ai/pedit/internal/protocol"
	"github.com/reearth/ygo/crdt"
)

// A guest from the command line mirrors each text file the room shares into
// its directory, at the path the host lists, as each list arrives. The paths
// come from the room, so they are checked again here, as the host checked
// them (CheckPath, in DecodeFiles): a hostile host can list any. A file is
// never written over, and the tree is made through a handle on the directory,
// so a path cannot reach out of it.

// Why a file of the room is not mirrored.
var (
	errNotText    = errors.New("it is a canvas, which only a browser can open; open the link in a browser")
	errCollides   = errors.New("its name is taken by another file of the room on this computer")
	errFileExists = errors.New("a file of that name is already there; join from another directory")
	errTooMany    = fmt.Errorf("a room mirrors up to %d files", MaxFiles)
	errNotFresh   = errors.New("pedit copies the room's other files only into a new, empty directory; join again with -d and one")
)

// mirror is what a joined session needs to mirror the room's other files.
type mirror struct {
	dir  string
	root *os.Root
	// fresh is whether dir was new or empty when joining: the host names the
	// other files' paths, so they go only where nothing was.
	fresh bool
	opts  JoinOptions
	// keys are the PathKey of every mirrored file, and dirs of every
	// directory holding one: a new file must take neither.
	keys map[string]bool
	dirs map[string]bool
	// done holds the ids seen, mirrored or not, so each is reported once.
	done map[uint64]bool
	// latest is the last list, kept until the first file is in place.
	latest []protocol.FileEntry
}

// takeManifest mirrors the room's files as the host lists them. It is called
// on the client's read loop, so the work goes to its own goroutine.
func (s *Session) takeManifest(files []protocol.FileEntry) {
	go func() {
		s.mirrorMu.Lock()
		defer s.mirrorMu.Unlock()
		if s.mirror == nil || s.mirror.root == nil {
			// The first file is not in place yet: Join mirrors this list then.
			if s.mirror != nil {
				s.mirror.latest = files
			}
			return
		}
		s.mirrorFiles(files)
	}()
}

// startMirror begins mirroring once the first file is in place as name, in
// dir. The caller holds s.mirrorMu.
func (s *Session) startMirror(name string) error {
	root, err := os.OpenRoot(s.mirror.dir)
	if err != nil {
		return err
	}
	s.mirror.root = root
	s.mirror.keys[protocol.PathKey(name)] = true
	if s.mirror.latest != nil {
		s.mirrorFiles(s.mirror.latest)
	}
	return nil
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
		err := s.mirrorFile(entry)
		if m.opts.OnMirrored != nil {
			m.opts.OnMirrored(filepath.Join(m.dir, filepath.FromSlash(entry.Path)), err)
		}
	}
}

func (s *Session) mirrorFile(entry protocol.FileEntry) error {
	m := s.mirror
	// DecodeFiles checked the path; a list made by hand gets the same.
	if err := protocol.CheckPath(entry.Path); err != nil {
		return err
	}
	if entry.Format != protocol.FormatText {
		return errNotText
	}
	if !m.fresh {
		return errNotFresh
	}
	key := protocol.PathKey(entry.Path)
	if m.keys[key] || m.dirs[key] {
		return errCollides
	}
	parents := parentKeys(key)
	for _, p := range parents {
		if m.keys[p] {
			return errCollides
		}
	}
	s.filesMu.Lock()
	full := len(s.files()) >= MaxFiles
	closed := s.closed
	s.filesMu.Unlock()
	if closed {
		return errors.New("the session has ended")
	}
	if full {
		return errTooMany
	}

	if dir := path.Dir(entry.Path); dir != "." {
		// Through the handle: a link in the tree cannot lead out of it.
		if err := m.root.MkdirAll(filepath.FromSlash(dir), 0o700); err != nil {
			return err
		}
	}
	if _, err := m.root.Lstat(filepath.FromSlash(entry.Path)); err == nil {
		return errFileExists
	} else if !errors.Is(err, os.ErrNotExist) {
		return err
	}
	file := filepath.Join(m.dir, filepath.FromSlash(entry.Path))
	// Through the handle too: the directory's name may lead elsewhere by now.
	bound, err := filewriter.OpenBoundIn(m.root, filepath.FromSlash(entry.Path))
	if err != nil {
		return err
	}
	// The copy is new: a file that appears at its name is never replaced.
	bound.CreateOnly()
	if err := bound.Write("", ""); err != nil {
		_ = bound.Close()
		return err
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
		return errors.New("the session has ended")
	}
	if err := s.watchFile(f); err != nil {
		s.filesMu.Unlock()
		_ = bound.Close()
		return err
	}
	s.added = append(s.added, f)
	s.filesMu.Unlock()
	if err := s.Client.AddFile(entry.ID, doc); err != nil {
		s.onError(err)
	}
	m.keys[key] = true
	for _, p := range parents {
		m.dirs[p] = true
	}
	f.notices.start()
	return nil
}

// parentKeys are the keys of the directories a path key is in, outermost
// first: "a/b/c.md" is in "a" and "a/b".
func parentKeys(key string) []string {
	var out []string
	for i := strings.Index(key, "/"); i >= 0; {
		out = append(out, key[:i])
		next := strings.Index(key[i+1:], "/")
		if next < 0 {
			break
		}
		i += 1 + next
	}
	return out
}
