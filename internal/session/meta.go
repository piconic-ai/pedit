package session

import (
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/piconic-ai/pedit/internal/filewriter"
	"github.com/piconic-ai/pedit/internal/meta"
	"github.com/piconic-ai/pedit/internal/protocol"
	"github.com/reearth/ygo/crdt"
)

// metaDir is where a project keeps the metadata of its files, such as their
// comments (#121), relative to the project's directory.
const metaDir = ".pedit/meta"

// metaFile is the metadata of a shared file: a doc of its own, which the room
// shares as a file of format meta, saved under the project's .pedit/meta/.
// docs/design/comments.md has the design.
type metaFile struct {
	id   uint64
	path string // in the manifest: protocol.MetaPath of the file's
	name string // under the project's directory
	doc  *crdt.Doc

	project *os.Root
	client  *protocol.Client
	// tracker follows the anchors through the file's text; nil for a canvas,
	// whose anchors are node ids.
	tracker *meta.Tracker
	delay   time.Duration
	notices *notices

	// saving keeps saves in order from rendering to the writer, and lets
	// Stop wait for a save under way.
	saving sync.Mutex
	// beforeSchedule, when set, runs between rendering and scheduling a save;
	// tests set it.
	beforeSchedule func()

	mu    sync.Mutex
	timer *time.Timer
	file  *meta.File // as last read or saved, with the keys a newer pedit wrote
	// bound is the file's name, once its directory exists, and writer saves
	// to it once the file exists: a file nobody commented on is never
	// created.
	bound  *filewriter.BoundFile
	writer *filewriter.Writer
	// held is set once the file changed outside pedit, and stopped once the
	// session stops: from then on only Stop saves.
	held    bool
	stopped bool
}

// openMeta reads the metadata of f, if the session keeps metadata, and makes
// its doc. It returns why f offers no comments when it does not: a file
// outside the project, or metadata pedit cannot read, is left alone.
// s.filesMu must be held, or Start still running.
func (s *Session) openMeta(f *sharedFile) (*metaFile, string) {
	if s.project == nil {
		return nil, s.noProject
	}
	rel, ok := projectPath(s.project, f.file)
	if !ok {
		return nil, "it is outside the project, whose comments are kept in " + filepath.Join(s.project.Name(), metaDir)
	}
	if err := protocol.CheckPath(rel); err != nil {
		return nil, "its path in the project cannot name a file of comments: " + err.Error()
	}
	path := protocol.MetaPath(f.path)
	if err := s.fitsManifest(protocol.FileEntry{ID: s.nextID, Path: path, Format: protocol.FormatMeta}); err != nil {
		return nil, "its comments cannot be listed in the room: " + err.Error()
	}
	name := filepath.FromSlash(metaDir + "/" + rel + ".json")
	m := &metaFile{
		id:      s.nextID,
		path:    path,
		name:    name,
		doc:     crdt.New(),
		project: s.project,
		client:  s.Client,
		delay:   orDefault(s.opts.WriteDelay, time.Second),
		notices: newNotices(filepath.Join(s.project.Name(), name), s.opts.OnNotice, s.opts.OnError),
		file:    &meta.File{Path: rel},
	}
	if off := m.read(rel); off != "" {
		m.close()
		return nil, off
	}
	if _, ok := f.content.(*textContent); ok {
		m.tracker = meta.NewTracker(f.doc)
	}
	if state := s.resumed.metaOf(f.file); state != nil {
		// The doc its guests hold, as for a text file (newContent).
		if err := crdt.ApplyUpdateV1(m.doc, state, nil); err != nil {
			m.close()
			return nil, "its saved comments cannot be restored"
		}
		if m.tracker != nil {
			m.tracker.Learn(m.doc)
		}
	} else {
		meta.Load(m.doc, m.file, m.tracker)
	}
	// Every peer refuses comments larger: they could not take the state.
	if meta.DocSize(m.doc) > meta.MaxDocBytes {
		m.close()
		return nil, "its comments are too large to share"
	}
	if m.tracker != nil {
		f.doc.OnUpdate(func(_ []byte, _ any) { m.schedule() })
	}
	m.doc.OnUpdate(func(_ []byte, origin any) {
		if origin == s.Client {
			// Under the client's lock: where a guest's anchor is, before
			// an edit can delete its character.
			if m.tracker != nil {
				m.tracker.Learn(m.doc)
			}
			m.schedule()
		}
	})
	s.nextID++
	return m, ""
}

// orDefault is d, or def when d is zero.
func orDefault(d, def time.Duration) time.Duration {
	if d == 0 {
		return def
	}
	return d
}

// read reads the metadata file, if there is one, and opens it to be saved.
// It returns why the file offers no comments, if it cannot be read: a file
// over meta.MaxFileBytes is refused before it is read.
func (m *metaFile) read(rel string) string {
	bound, err := openMetaFile(m.project, m.name, false)
	if errors.Is(err, fs.ErrNotExist) {
		// No .pedit/meta/ yet: made with the first comment.
		return ""
	}
	if err != nil {
		return "cannot open " + m.name + ": " + err.Error()
	}
	m.bound = bound
	size, ok := bound.Size()
	if !ok {
		return ""
	}
	if size > meta.MaxFileBytes {
		return fmt.Sprintf("%s is larger than %d bytes, and is left as it is", m.name, meta.MaxFileBytes)
	}
	data, ok := bound.Read()
	if !ok {
		return "cannot read " + m.name
	}
	file, err := meta.Parse([]byte(data))
	if err != nil {
		return m.name + " cannot be read, and is left as it is: " + err.Error()
	}
	file.Path = rel
	m.file = file
	m.openWriter(data)
	return ""
}

// projectPath is file's path in project, if it is in it.
func projectPath(project *os.Root, file string) (string, bool) {
	rel, err := filepath.Rel(project.Name(), file)
	if err != nil || !filepath.IsLocal(rel) {
		return "", false
	}
	return filepath.ToSlash(rel), true
}

// openMetaFile binds name, a metadata file under the project's .pedit/meta/,
// creating its directories when create is set. Each directory on the way must
// be a real one: a symlink, even to elsewhere in the project, such as one a
// cloned repository holds, would have pedit write the comments there.
func openMetaFile(project *os.Root, name string, create bool) (*filewriter.BoundFile, error) {
	dir := project
	for _, part := range strings.Split(filepath.ToSlash(filepath.Dir(name)), "/") {
		next, err := openRealDir(dir, part, create)
		if dir != project {
			_ = dir.Close()
		}
		if err != nil {
			return nil, err
		}
		dir = next
	}
	defer dir.Close()
	return filewriter.OpenBoundIn(dir, filepath.Base(name))
}

// openRealDir opens the directory name in dir, making it when create is set,
// and refuses a symlink or anything swapped in for the directory meanwhile.
func openRealDir(dir *os.Root, name string, create bool) (*os.Root, error) {
	info, err := dir.Lstat(name)
	if errors.Is(err, fs.ErrNotExist) && create {
		// Only the host reads its comments: others on the computer do not
		// even learn which files have some.
		if err := dir.Mkdir(name, 0o700); err != nil && !errors.Is(err, fs.ErrExist) {
			return nil, err
		}
		info, err = dir.Lstat(name)
	}
	if err != nil {
		return nil, err
	}
	if !info.IsDir() {
		return nil, fmt.Errorf("%s is not a directory", filepath.Join(dir.Name(), name))
	}
	next, err := dir.OpenRoot(name)
	if err != nil {
		return nil, err
	}
	if opened, err := next.Stat("."); err != nil || !os.SameFile(info, opened) {
		_ = next.Close()
		return nil, fmt.Errorf("%s changed while pedit opened it", filepath.Join(dir.Name(), name))
	}
	return next, nil
}

// keepsComments tells whether file is under the .pedit/meta/ of project,
// which may be nil, where pedit writes itself: sharing such a file would give
// it two writers. Case does not count, as on macOS and Windows, and neither
// does a symlinked directory on the way to it.
func keepsComments(project *os.Root, file string) bool {
	if project == nil {
		return false
	}
	if rel, ok := projectPath(project, file); ok && inMetaDir(rel) {
		return true
	}
	dir, err1 := filepath.EvalSymlinks(filepath.Dir(file))
	root, err2 := filepath.EvalSymlinks(project.Name())
	if err1 != nil || err2 != nil {
		return false
	}
	rel, err := filepath.Rel(root, filepath.Join(dir, filepath.Base(file)))
	return err == nil && filepath.IsLocal(rel) && inMetaDir(filepath.ToSlash(rel))
}

// inMetaDir tells whether rel, a slash path in the project, is under
// .pedit/meta/, in any case.
func inMetaDir(rel string) bool {
	return strings.HasPrefix(strings.ToLower(rel)+"/", metaDir+"/")
}

// errKeepsComments refuses to share a file of .pedit/meta/.
var errKeepsComments = errors.New(metaDir + " keeps the comments of the project's files, which pedit writes itself")

// openProject opens the project's directory, if there is one. Comments are
// worth no file being shared: without the project there are none, and the
// reason says why.
func openProject(dir string) (*os.Root, string) {
	if dir == "" {
		return nil, ""
	}
	project, err := os.OpenRoot(dir)
	if err != nil {
		return nil, "cannot open the project: " + err.Error()
	}
	return project, ""
}

// startMeta shares the metadata of the first file, before the client
// connects.
func (s *Session) startMeta() {
	s.filesMu.Lock()
	defer s.filesMu.Unlock()
	s.addMeta(s.sharedFile)
	// Always listed, comments or not: comment-only and read-only links send
	// no awareness the host's could answer, and learn the file's name and
	// format from the list (#122).
	if err := s.Client.SetManifest(s.manifest()); err != nil {
		s.onError(err)
	}
}

// addMeta shares the metadata of f, if it has any to share; the caller then
// tells the room the new manifest. If f offers no comments, it tells why.
// s.filesMu must be held.
func (s *Session) addMeta(f *sharedFile) {
	m, off := s.openMeta(f)
	if m == nil {
		if off != "" {
			f.notices.send(Notice{Kind: CommentsOff, Reason: off})
		}
	} else {
		f.meta = m
		if err := s.Client.AddCommentsFile(m.id, m.doc, meta.CheckUpdate); err != nil {
			s.onError(err)
		}
		m.notices.start()
	}
}

// openWriter makes the writer that saves the file, whose bound is open,
// initial being what it holds.
func (m *metaFile) openWriter(initial string) {
	m.writer = filewriter.New(filepath.Join(m.project.Name(), m.name), initial, filewriter.Options{
		Bound: m.bound,
		// metaFile waits for the edits to settle; the writer just writes.
		Delay:            time.Millisecond,
		RetryDelay:       5 * m.delay,
		OnError:          m.notices.saveError,
		OnWritten:        m.notices.written,
		OnExternalChange: m.hold,
	})
}

// It reads no doc: it is called from the doc's update handler, under its
// lock.
func (m *metaFile) schedule() {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.held || m.stopped {
		return
	}
	if m.timer == nil {
		m.timer = time.AfterFunc(m.delay, func() {
			m.mu.Lock()
			m.timer = nil
			m.mu.Unlock()
			_ = m.saveNow(false)
		})
	}
}

// saveNow renders the metadata under the client's lock and saves it, waiting
// for the write when flush is set.
func (m *metaFile) saveNow(flush bool) error {
	m.saving.Lock()
	defer m.saving.Unlock()
	var out []byte
	var err error
	m.client.Do(func() { out, err = m.render() })
	return m.save(out, err, flush)
}

// render returns the metadata file as the docs have it now, or nil when
// there is nothing to save: no file, and no comments. The caller holds the
// client's lock, so no update changes the docs meanwhile.
func (m *metaFile) render() ([]byte, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.writer == nil && len(m.doc.GetMap(meta.CommentsKey).Keys()) == 0 {
		// Nobody commented: not worth reading the file's text.
		return nil, nil
	}
	m.file = meta.Read(m.doc, m.file, m.tracker)
	if m.writer == nil && len(m.file.Comments) == 0 {
		return nil, nil
	}
	return meta.Render(m.file)
}

// save writes out, which render returned, now when flush is set.
func (m *metaFile) save(out []byte, err error, flush bool) error {
	writer, err := m.writerFor(out, err, flush)
	if writer == nil {
		return err
	}
	if m.beforeSchedule != nil {
		m.beforeSchedule()
	}
	// Not under m.mu: a write that finds the file changed calls hold.
	writer.Schedule(string(out))
	if flush {
		return writer.Flush()
	}
	return nil
}

// writerFor returns the writer to save out with, creating the file's
// directory and the writer for the first save, or nil when there is nothing
// to save or it cannot be. Once Stop began, only its own saves (flush) are
// made.
func (m *metaFile) writerFor(out []byte, err error, flush bool) (*filewriter.Writer, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.held || m.stopped && !flush || out == nil && err == nil {
		return nil, nil
	}
	if err != nil {
		err = fmt.Errorf("the comments cannot be saved: %w", err)
		m.notices.saveError(err)
		return nil, err
	}
	if m.writer == nil {
		if err := m.create(); err != nil {
			m.notices.saveError(err)
			m.retry()
			return nil, err
		}
	}
	return m.writer, nil
}

// create makes the file's directory and the writer that creates the file,
// never over one that appeared meanwhile, such as one from Git. The caller
// holds m.mu.
func (m *metaFile) create() error {
	if m.bound == nil {
		bound, err := openMetaFile(m.project, m.name, true)
		if err != nil {
			return err
		}
		m.bound = bound
	}
	m.bound.CreateOnly()
	m.openWriter("")
	return nil
}

// retry tries a save that could not start again later, as the writer tries
// one that failed, unless saving stopped. The caller holds m.mu.
func (m *metaFile) retry() {
	if m.held || m.stopped || m.timer != nil {
		return
	}
	m.timer = time.AfterFunc(5*m.delay, func() {
		m.mu.Lock()
		m.timer = nil
		m.mu.Unlock()
		_ = m.saveNow(false)
	})
}

// hold stops saving the metadata file, which changed outside pedit: saving
// over it would lose that change, and pedit does not merge one.
func (m *metaFile) hold() {
	m.mu.Lock()
	if m.held {
		m.mu.Unlock()
		return
	}
	m.held = true
	if m.timer != nil {
		m.timer.Stop()
	}
	m.mu.Unlock()
	m.notices.send(Notice{Kind: CommentsHeld})
}

// stop schedules no more saves; Stop saves the metadata itself.
func (m *metaFile) stop() {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.stopped = true
	if m.timer != nil {
		m.timer.Stop()
	}
}

// finish saves the metadata once more, when the session stops: the client
// is gone, so nothing changes the docs meanwhile. A file held is not saved:
// the user was told.
func (m *metaFile) finish() error {
	m.mu.Lock()
	held := m.held
	m.mu.Unlock()
	m.saving.Lock()
	out, err := m.render()
	err = m.save(out, err, true)
	m.saving.Unlock()
	m.notices.stop()
	if held {
		return nil
	}
	if errors.Is(err, filewriter.ErrExternalChange) {
		err = errors.New("it changed outside pedit, and is left as it is")
	}
	if err != nil {
		return fmt.Errorf("could not save the comments to %s: %w", filepath.Join(m.project.Name(), m.name), err)
	}
	return nil
}

func (m *metaFile) close() {
	if m.tracker != nil {
		m.tracker.Close()
	}
	if m.bound != nil {
		_ = m.bound.Close()
	}
}
