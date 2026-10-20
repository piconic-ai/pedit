package session

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"unicode/utf8"

	"github.com/piconic-ai/pedit/internal/attach"
	"github.com/piconic-ai/pedit/internal/filewriter"
	"github.com/piconic-ai/pedit/internal/protocol"
	"github.com/reearth/ygo/crdt"
)

// MaxFiles is how many files one session shares, the first included.
const MaxFiles = 20

// openShared opens a file to share and reads it, checking first what makes
// it unfit: not a regular file, too large, or not UTF-8.
func openShared(file string) (*filewriter.BoundFile, string, error) {
	bound, err := filewriter.OpenBound(file)
	if err != nil {
		return nil, "", fmt.Errorf("cannot open %s: %w", file, err)
	}
	fail := func(err error) (*filewriter.BoundFile, string, error) {
		_ = bound.Close()
		return nil, "", err
	}
	// Before reading: a file far over the limit is turned away without loading
	// it, and before the UTF-8 check, which would scan all of it.
	if size, ok := bound.Size(); ok && !isCanvas(file) && protocol.FrameBytes(int(size)) > protocol.MaxFrameBytes {
		return fail(&TooLargeError{File: file, Size: int(size)})
	}
	initial, ok := bound.Read()
	if !ok {
		return fail(fmt.Errorf("cannot read %s", file))
	}
	if !utf8.ValidString(initial) {
		// Before sharing it: once edited, the bytes pedit cannot read would be
		// saved back as U+FFFD, and the file changed for good.
		return fail(fmt.Errorf("%s is not UTF-8 text. pedit shares UTF-8 only, and would replace the bytes it cannot read; convert the file first (for example, iconv -f SHIFT_JIS -t UTF-8)", file))
	}
	// On connecting, the room gets the whole state in one frame, which the
	// relay caps. Text takes at least its own size there. This covers a file
	// that grew since the size check above.
	if !isCanvas(file) && protocol.FrameBytes(len(initial)) > protocol.MaxFrameBytes {
		return fail(&TooLargeError{File: file, Size: len(initial)})
	}
	return bound, initial, nil
}

// newContent loads a file into doc, as text or as a canvas.
func newContent(doc *crdt.Doc, file, initial string) (content, error) {
	if isCanvas(file) {
		return newCanvasContent(doc, file, initial)
	}
	return newTextContent(doc, initial), nil
}

// tooLarge reports a file whose state does not fit the frame it is sent in.
func tooLarge(file, initial string, c content, frame int) error {
	e := &TooLargeError{File: file, Size: len(initial)}
	if _, ok := c.(*canvasContent); ok {
		e.Shared = frame
	}
	return e
}

// sharedPath is the path a room shows for file: relative to root, or its
// name alone when it is not inside root.
func sharedPath(root, file string) string {
	if root != "" {
		if rel, err := filepath.Rel(root, file); err == nil && filepath.IsLocal(rel) {
			return filepath.ToSlash(rel)
		}
	}
	return filepath.Base(file)
}

// AddFile shares another file in the room, in a Y.Doc of its own, and tells
// the room its new list of files. The host names every file: nothing in the
// room can add one. It fails, changing nothing, when the file cannot be
// shared, or is already.
func (s *Session) AddFile(file string) (protocol.FileEntry, error) {
	file, err := filepath.Abs(file)
	if err != nil {
		return protocol.FileEntry{}, err
	}
	s.filesMu.Lock()
	defer s.filesMu.Unlock()
	path, err := s.canShare(file)
	if err != nil {
		return protocol.FileEntry{}, err
	}

	bound, initial, err := openShared(file)
	if err != nil {
		return protocol.FileEntry{}, err
	}
	doc := crdt.New()
	c, err := newContent(doc, file, initial)
	if err != nil {
		_ = bound.Close()
		return protocol.FileEntry{}, err
	}
	id := s.nextID
	if frame := protocol.FileStateFrameBytes(id, doc); frame > protocol.MaxFrameBytes {
		_ = bound.Close()
		return protocol.FileEntry{}, tooLarge(file, initial, c, frame)
	}

	f := &sharedFile{
		id:      id,
		file:    file,
		path:    path,
		doc:     doc,
		bound:   bound,
		content: c,
		client:  s.Client,
		onError: s.opts.OnError,
		notices: newNotices(file, s.opts.OnNotice, s.opts.OnError),
		sendCanvas: func(m protocol.CanvasMessage) error {
			return s.Client.SendFileCanvas(id, m)
		},
	}
	f.Writer = filewriter.New(file, initial, filewriter.Options{
		Bound:            bound,
		Delay:            s.opts.WriteDelay,
		OnError:          f.notices.saveError,
		OnWritten:        f.notices.written,
		OnExternalChange: f.scheduleSyncFromDisk,
	})
	f.attachments = attach.New(attach.Options{
		File:            file,
		Root:            bound.Dir(),
		InitialDocument: initial,
		Server:          s.server,
		Room:            s.roomID,
		Header:          s.opts.Header,
		HTTPClient:      s.opts.HTTPClient,
		Keys:            s.blobKeys,
		Send:            func(a protocol.Attachment) error { return s.Client.SendFileAttachment(id, a) },
		OnSaved: func(saved string) {
			f.notices.imageSaved()
			if s.opts.OnSaved != nil {
				// Relative to the first file, as for the first file's images.
				dir := filepath.Dir(s.file)
				rel, err := filepath.Rel(dir, filepath.Join(filepath.Dir(file), filepath.FromSlash(saved)))
				if err != nil {
					rel = filepath.Join(filepath.Dir(file), filepath.FromSlash(saved))
				}
				s.opts.OnSaved(filepath.ToSlash(rel))
			}
		},
		OnSaveError: f.notices.imageError,
		OnError:     s.opts.OnError,
	})
	doc.OnUpdate(func(_ []byte, origin any) {
		// Both come in under the client's lock, so the doc can be read here.
		if origin == s.Client || origin == editOrigin {
			f.Writer.Schedule(f.content.render())
		}
	})
	if err := s.watchFile(f); err != nil {
		f.attachments.Close()
		_ = bound.Close()
		return protocol.FileEntry{}, err
	}
	s.added = append(s.added, f)
	s.nextID++
	if err := s.Client.AddFile(id, doc); err != nil {
		s.onError(err)
	}
	if err := s.Client.SetManifest(s.manifest()); err != nil {
		s.onError(err)
	}
	f.notices.start()
	return protocol.FileEntry{ID: id, Path: path, Format: f.format()}, nil
}

// canShare checks that file can be shared, and returns the path the room is
// to know it by. s.filesMu must be held.
func (s *Session) canShare(file string) (string, error) {
	if s.closed {
		return "", errors.New("the session has ended")
	}
	if s.roomID == "" {
		return "", errors.New("a joined room shares only the host's files")
	}
	files := s.files()
	if len(files) >= MaxFiles {
		return "", fmt.Errorf("a room shares up to %d files", MaxFiles)
	}
	path := sharedPath(s.opts.Root, file)
	if err := protocol.CheckPath(path); err != nil {
		return "", fmt.Errorf("%s cannot be shared under that name: %w", path, err)
	}
	info, err := os.Stat(file)
	if err != nil {
		return "", fmt.Errorf("cannot open %s: %w", file, err)
	}
	if err := alreadyShared(files, file, path, info); err != nil {
		return "", err
	}

	// Every file goes in the list the room gets, the first one too, which
	// Start does not check: one name it refuses would keep the room from
	// getting any list.
	format := protocol.FormatText
	if isCanvas(file) {
		format = protocol.FormatCanvas
	}
	if _, err := protocol.EncodeManifest(append(s.manifest(), protocol.FileEntry{ID: s.nextID, Path: path, Format: format})); err != nil {
		return "", fmt.Errorf("no other file can be shared with %s, whose name macOS or Windows would read differently: %w", s.path, err)
	}
	return path, nil
}

// alreadyShared fails when one of files is file, whose info is info, or is
// shared under a path that macOS or Windows would take for path.
func alreadyShared(files []*sharedFile, file, path string, info os.FileInfo) error {
	for _, f := range files {
		if same, err := os.Stat(f.file); err == nil && os.SameFile(info, same) || f.file == file {
			return fmt.Errorf("%s is already shared", path)
		}
		if protocol.PathKey(f.path) == protocol.PathKey(path) {
			// Two names macOS and Windows take for one, such as Notes.md and
			// notes.md: a guest there could not keep both.
			return fmt.Errorf("%s is already shared as %s", path, f.path)
		}
	}
	return nil
}

// Files lists the files the session shares, the first one first.
func (s *Session) Files() []protocol.FileEntry {
	s.filesMu.Lock()
	defer s.filesMu.Unlock()
	return s.manifest()
}

// manifest lists the room's files. The caller holds s.filesMu.
func (s *Session) manifest() []protocol.FileEntry {
	var out []protocol.FileEntry
	for _, f := range s.files() {
		out = append(out, protocol.FileEntry{ID: f.id, Path: f.path, Format: f.format()})
	}
	return out
}

// addedFile returns the file added with this id, if any.
func (s *Session) addedFile(id uint64) *sharedFile {
	s.filesMu.Lock()
	defer s.filesMu.Unlock()
	for _, f := range s.added {
		if f.id == id {
			return f
		}
	}
	return nil
}

func (s *Session) handleFileAttachment(id uint64, a protocol.Attachment) {
	if f := s.addedFile(id); f != nil {
		f.attachments.Handle(a)
	}
}

func (s *Session) handleFileCanvas(id uint64, m protocol.CanvasMessage) {
	if f := s.addedFile(id); f != nil {
		f.handleCanvas(m)
	}
}
