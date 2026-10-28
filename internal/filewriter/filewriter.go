// Package filewriter writes the shared document back to the host's file.
package filewriter

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

// WriteAtomic writes the file atomically: a temp file in the same directory,
// then rename over. Existing permissions are kept; new files are private
// (0600, restricted further by the process umask).
func WriteAtomic(path, content string) error {
	existing, _ := os.Stat(path)
	// Create exclusively under a fresh name. Opening a predictable path could
	// follow a link planted by someone who can write in this directory.
	tmp, err := os.CreateTemp(filepath.Dir(path), "."+filepath.Base(path)+".pedit-*.tmp")
	if err != nil {
		return err
	}
	defer os.Remove(tmp.Name())
	_, err = tmp.WriteString(content)
	if err == nil && existing != nil {
		// Set permissions through the open descriptor, not a second path lookup.
		err = tmp.Chmod(existing.Mode().Perm())
	}
	if err = errors.Join(err, tmp.Close()); err != nil {
		return err
	}
	return os.Rename(tmp.Name(), path)
}

// ReadFile reads path as text, replacing invalid UTF-8 like a text editor would.
// ok is false when the file cannot be read.
func ReadFile(path string) (content string, ok bool) {
	b, err := os.ReadFile(path)
	if err != nil {
		return "", false
	}
	return strings.ToValidUTF8(string(b), "�"), true
}

// Writer debounces writes of the latest content to a file. It skips writes when
// the content equals what is already on disk (as far as it knows), and refuses to
// clobber a file that someone else changed since its last write, also when the
// change lands while it writes: it calls OnExternalChange instead, so the
// change can be merged first.
type Writer struct {
	path             string
	bound            *BoundFile
	delay            time.Duration
	retryDelay       time.Duration
	onError          func(error)
	onWritten        func()
	onExternalChange func()

	mu      sync.Mutex // guards timer and pending
	timer   *time.Timer
	pending *string

	io          sync.Mutex // serializes disk access; guards lastWritten
	lastWritten string
	held        bool
}

type Options struct {
	Bound *BoundFile
	Delay time.Duration
	// Hold prevents all writes for the lifetime of this writer.
	Hold bool
	// RetryDelay is how long content whose write failed waits before it is
	// written again; five times Delay by default, so a failing disk is not
	// tried in a tight loop.
	RetryDelay time.Duration
	// OnError is called with each write that fails, retries included, and
	// with what a write that landed reports, such as ErrSaveOverwritten. A
	// write skipped for ErrExternalChange alone goes only to OnExternalChange.
	OnError func(error)
	// OnWritten is called after each write that lands, also one that
	// returns an error but left the content in the file.
	OnWritten        func()
	OnExternalChange func()
}

func New(path, initial string, opts Options) *Writer {
	w := &Writer{
		path:             path,
		bound:            opts.Bound,
		delay:            opts.Delay,
		retryDelay:       opts.RetryDelay,
		onError:          opts.OnError,
		onWritten:        opts.OnWritten,
		onExternalChange: opts.OnExternalChange,
		lastWritten:      initial,
		held:             opts.Hold,
	}
	if w.delay == 0 {
		w.delay = time.Second
	}
	if w.retryDelay == 0 {
		w.retryDelay = 5 * w.delay
	}
	if w.onError == nil {
		w.onError = func(error) {}
	}
	if w.onWritten == nil {
		w.onWritten = func() {}
	}
	if w.onExternalChange == nil {
		w.onExternalChange = func() {}
	}
	return w
}

// Schedule coalesces content for the next save without delaying a pending save.
func (w *Writer) Schedule(content string) {
	w.mu.Lock()
	defer w.mu.Unlock()
	w.pending = &content
	if !w.held && w.timer == nil {
		w.arm(w.delay)
	}
}

// arm (re)starts the timer that writes the pending content. Callers hold w.mu.
func (w *Writer) arm(delay time.Duration) {
	if w.timer != nil {
		w.timer.Stop()
	}
	w.timer = time.AfterFunc(delay, func() { _ = w.flush(true) })
}

// ErrExternalChange means the file changed outside pedit since the last write,
// so the write was skipped to avoid clobbering it.
var ErrExternalChange = errors.New("file changed outside pedit")

// ErrRecoveryHeld means recovery has not authorized saving the file.
var ErrRecoveryHeld = errors.New("recovery file is held")

// Flush writes any pending content now and returns once it is written. A
// write that fails is up to the caller: Flush leaves no retry behind.
func (w *Writer) Flush() error { return w.flush(false) }

// flush writes any pending content. With retry, as when the timer fires,
// content that fails to be written stays pending and is tried again after the
// retry delay, unless newer content was scheduled meanwhile, the file changed
// outside pedit, or the file was closed and can never be written again.
func (w *Writer) flush(retry bool) error {
	// Take io before the pending content, so flushes land in the order their
	// content was scheduled.
	w.io.Lock()
	defer w.io.Unlock()
	if w.held {
		return ErrRecoveryHeld
	}

	w.mu.Lock()
	if w.timer != nil {
		w.timer.Stop()
		w.timer = nil
	}
	pending := w.pending
	w.pending = nil
	w.mu.Unlock()

	if pending == nil || *pending == w.lastWritten {
		if w.bound != nil {
			return w.bound.Validate()
		}
		return nil
	}
	read := func() (string, bool) { return ReadFile(w.path) }
	if w.bound != nil {
		read = w.bound.Read
	}
	onDisk, ok := read()
	if ok && onDisk != w.lastWritten {
		w.onExternalChange()
		return ErrExternalChange
	}
	var err error
	if w.bound != nil {
		// Checks again, at the moment of replacing, against the same content.
		err = w.bound.Write(w.lastWritten, *pending)
	} else {
		err = WriteAtomic(w.path, *pending)
	}
	if err == nil {
		w.lastWritten = *pending
		w.onWritten()
		return nil
	}
	// A write that failed late may have left the content in place, such as
	// when a save it moved aside could not be put back. Merging that content
	// in again would repeat its edits, and writing it again is not needed.
	var landed landedError
	inPlace := errors.As(err, &landed)
	if !inPlace {
		onDisk, ok := read()
		inPlace = ok && onDisk == *pending
	}
	switch {
	case inPlace:
		w.lastWritten = *pending
		w.onWritten()
	case retry && !errors.Is(err, ErrExternalChange) && !errors.Is(err, os.ErrClosed):
		// A change outside pedit is merged first, which schedules the
		// write again; a closed file can never be written.
		w.mu.Lock()
		if w.pending == nil {
			w.pending = pending
			w.arm(w.retryDelay)
		}
		w.mu.Unlock()
	}
	if err != ErrExternalChange {
		// It says more, such as where a save is kept.
		w.onError(err)
	}
	if errors.Is(err, ErrExternalChange) {
		w.onExternalChange()
	}
	return err
}

// LastWritten returns the content last written to (or read from) the file.
func (w *Writer) LastWritten() string {
	w.io.Lock()
	defer w.io.Unlock()
	return w.lastWritten
}

// Rebase runs fn with exclusive access to the file and sets the known on-disk
// content to what fn returns. fn is given the content last written.
//
// When that content changes, any pending content is dropped: it was computed
// before the change and would clobber it. Schedule the merged content afterwards.
func (w *Writer) Rebase(fn func(lastWritten string) string) {
	w.io.Lock()
	defer w.io.Unlock()
	next := fn(w.lastWritten)
	if next == w.lastWritten {
		return
	}
	w.lastWritten = next
	w.mu.Lock()
	defer w.mu.Unlock()
	w.pending = nil
	if w.timer != nil {
		w.timer.Stop()
		w.timer = nil
	}
}
