package filewriter

import (
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"time"
)

// ErrNotRegular means the shared file was replaced by something that is not a
// regular file, such as a link or a directory, which pedit does not write through.
var ErrNotRegular = errors.New("not a regular file")

// BoundFile keeps the shared directory open for the lifetime of a session.
// Renaming a file within it is allowed; replacing it with a link is not.
type BoundFile struct {
	root *os.Root
	name string
	// calls are the calls that put a new file in place; tests replace them to
	// fail as a file system would.
	calls fsCalls
	// noExchange is set once the file system turned out unable to exchange;
	// Write then checks again and renames. Never reset.
	noExchange atomic.Bool
	// createOnly is set for a file pedit has yet to create, so that a file
	// appearing at the name is refused whatever it holds, even if empty or
	// unreadable. Write clears it once it has created the file.
	createOnly atomic.Bool
	hook       atomic.Pointer[func(Step)]
}

// fsCalls take only plain names, entries of the directory root holds. The
// platform ones work on a descriptor of that directory, closed by defer, so
// nothing is looked up outside it.
type fsCalls struct {
	exchange, noReplace, link, rename func(root *os.Root, a, b string) error
}

// Step is a point in Write that a test can stop at. Test-only.
type Step int

const (
	// StepTempWritten is after the new content is in its temporary file.
	StepTempWritten Step = iota + 1
	// StepBeforeReplace is just before the file is put in place. On the
	// create path it can be reached twice in one Write.
	StepBeforeReplace
	// StepExchanged is after the first exchange and after each restore
	// exchange.
	StepExchanged
	// StepRechecking is after the pause that precedes the second read. restore
	// reaches it too, where it reads again the file it moved aside, since an
	// editor may have opened that file while it sat under the name.
	StepRechecking
)

// SetTestHook makes Write call fn at each Step. It is for tests only; nil
// removes it.
func (f *BoundFile) SetTestHook(fn func(Step)) {
	if fn == nil {
		f.hook.Store(nil)
		return
	}
	f.hook.Store(&fn)
}

func (f *BoundFile) step(s Step) {
	if fn := f.hook.Load(); fn != nil {
		(*fn)(s)
	}
}

// lateWriteDelay is how long Write and restore wait before they read once more
// a file they moved aside: an editor whose open() found it under the name just
// before may truncate and write it a moment later.
var lateWriteDelay = 5 * time.Millisecond

// maxRestores bounds how often Write swaps back saves that keep landing.
const maxRestores = 3

// errReplaced means the file under a name was replaced between pedit's Lstat
// and its open.
var errReplaced = errors.New("replaced while pedit read it")

// ErrSaveOverwritten means a save made while pedit wrote the file was written
// into the file pedit's write replaced, and is lost; pedit's content is in
// place. Only where the file system cannot exchange two files.
var ErrSaveOverwritten = errors.New("a save made outside pedit while pedit wrote the file was lost: pedit's write replaced it. Save it again")

// KeptError means Write moved aside what was under the file's name and left
// it beside the file, under a temporary name, because it may be a save made
// outside pedit that Write could not put back.
type KeptError struct {
	// Name is the temporary name it is kept under, in the file's directory.
	Name string
	Err  error
}

func (e *KeptError) Error() string { return e.Err.Error() }
func (e *KeptError) Unwrap() error { return e.Err }

// landedError is a Write error after which the new content is in the file
// nonetheless.
type landedError struct{ err error }

func (e landedError) Error() string { return e.err.Error() }
func (e landedError) Unwrap() error { return e.err }

func (f *BoundFile) errNotRegular() error {
	return fmt.Errorf("shared file %s is %w", f.name, ErrNotRegular)
}

func OpenBound(path string) (*BoundFile, error) {
	root, err := os.OpenRoot(filepath.Dir(path))
	if err != nil {
		return nil, err
	}
	return bind(root, filepath.Base(path))
}

// OpenBoundIn is OpenBound for name, a path relative to dir. Its directory is
// opened through dir, so neither a link in name nor a directory moved or
// replaced since dir was opened can lead out of dir.
func OpenBoundIn(dir *os.Root, name string) (*BoundFile, error) {
	root, err := dir.OpenRoot(filepath.Dir(name))
	if err != nil {
		return nil, err
	}
	return bind(root, filepath.Base(name))
}

// bind binds the file name in root, which it closes on error.
func bind(root *os.Root, name string) (*BoundFile, error) {
	path := filepath.Join(root.Name(), name)
	f := &BoundFile{
		root: root,
		name: name,
		calls: fsCalls{
			exchange:  exchange,
			noReplace: renameNoReplace,
			link:      (*os.Root).Link,
			rename:    (*os.Root).Rename,
		},
	}
	if info, err := root.Lstat(f.name); err == nil && !info.Mode().IsRegular() {
		_ = root.Close()
		return nil, fmt.Errorf("shared file %s is %w", path, ErrNotRegular)
	} else if err != nil && !errors.Is(err, os.ErrNotExist) {
		_ = root.Close()
		return nil, err
	}
	return f, nil
}

func (f *BoundFile) Close() error { return f.root.Close() }

// Dir is the shared file's directory, as opened when the session started.
// It stays open until Close.
func (f *BoundFile) Dir() *os.Root { return f.root }

// CreateOnly makes Write refuse any file at the name, with ErrExternalChange,
// until Write has created the file itself.
func (f *BoundFile) CreateOnly() { f.createOnly.Store(true) }

func (f *BoundFile) Validate() error {
	info, err := f.root.Lstat(f.name)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	if !info.Mode().IsRegular() {
		return f.errNotRegular()
	}
	return nil
}

// Size is the size of the file at the name, when it is a regular file.
func (f *BoundFile) Size() (int64, bool) {
	info, err := f.root.Lstat(f.name)
	if err != nil || !info.Mode().IsRegular() {
		return 0, false
	}
	return info.Size(), true
}

// entry is what a name held when it was looked at.
type entry struct {
	info os.FileInfo
	// content is only meaningful when readable.
	content  string
	readable bool
}

func (e entry) regular() bool { return e.info.Mode().IsRegular() }

// same reports whether o is the file e is, with what it held. An unreadable
// file is compared by size and modification time instead.
func (e entry) same(o entry) bool {
	if e.regular() != o.regular() || !os.SameFile(e.info, o.info) {
		return false
	}
	if e.readable && o.readable {
		return e.content == o.content
	}
	return e.info.Size() == o.info.Size() && e.info.ModTime().Equal(o.info.ModTime())
}

// holds reports whether e is a regular file with the expected content. A file
// pedit cannot read counts as holding it.
func (e entry) holds(expected string) bool {
	return e.regular() && (!e.readable || e.content == expected)
}

// look inspects name without following a link, and reads it when it is a
// regular file pedit may read, returning the descriptor open. A file that
// is not regular, or not readable, comes back unread and with no descriptor.
func (f *BoundFile) look(name string) (entry, *os.File, error) {
	info, err := f.root.Lstat(name)
	if err != nil {
		return entry{}, nil, err
	}
	e := entry{info: info}
	if !e.regular() {
		return e, nil, nil
	}
	file, err := f.root.Open(name)
	if errors.Is(err, os.ErrPermission) {
		return e, nil, nil
	}
	if err != nil {
		return entry{}, nil, err
	}
	opened, err := file.Stat()
	if err != nil {
		_ = file.Close()
		return entry{}, nil, err
	}
	if !os.SameFile(info, opened) {
		_ = file.Close()
		return entry{}, nil, errReplaced
	}
	content, err := readAll(file)
	if err != nil {
		_ = file.Close()
		return entry{}, nil, err
	}
	e.content, e.readable = content, true
	return e, file, nil
}

// inspect is look without keeping the descriptor.
func (f *BoundFile) inspect(name string) (entry, error) {
	e, file, err := f.look(name)
	if file != nil {
		_ = file.Close()
	}
	return e, err
}

// Read verifies the opened descriptor against the entry inspected before open.
// Root prevents a raced link from escaping the anchored directory; SameFile
// rejects a raced link to another file inside it. The content comes back as
// it is on disk, which may not be UTF-8: callers check before taking it in.
func (f *BoundFile) Read() (string, bool) {
	e, err := f.inspect(f.name)
	if err != nil || !e.readable {
		return "", false
	}
	return e.content, true
}

// maxPresize caps the buffer readAll allocates up front from a file's size.
const maxPresize = 1 << 30

// readAll reads file from its start.
func readAll(file *os.File) (string, error) {
	if _, err := file.Seek(0, io.SeekStart); err != nil {
		return "", err
	}
	var b strings.Builder
	if info, err := file.Stat(); err == nil && info.Size() > 0 && info.Size() < maxPresize {
		b.Grow(int(info.Size()))
	}
	if _, err := io.Copy(&b, file); err != nil {
		return "", err
	}
	return b.String(), nil
}

// randomName is a name for a temporary file that nobody can predict.
func randomName() string {
	var random [16]byte
	_, _ = rand.Read(random[:])
	return ".pedit-" + hex.EncodeToString(random[:]) + ".tmp"
}

// kept is the path a file kept under tmpName can be found at.
func (f *BoundFile) kept(tmpName string) string {
	return filepath.Join(f.root.Name(), tmpName)
}

// Write replaces the file with content, but only while the file still holds
// expected. With exchange (Linux, macOS), a save made in between is left in
// place, and Write returns ErrExternalChange. Elsewhere it checks once more
// and reports a save written into the file it replaced. A file pedit cannot
// read counts as holding expected. A file that appears at a missing name is
// never replaced. Write must not run concurrently with itself; Writer.io
// serializes it.
func (f *BoundFile) Write(expected, content string) error {
	// An existing file keeps its permissions. A new one keeps those it is
	// created with below: 0600, restricted further by the umask.
	var mode os.FileMode
	existed := false
	if info, err := f.root.Lstat(f.name); err == nil {
		if !info.Mode().IsRegular() {
			return f.errNotRegular()
		}
		if f.createOnly.Load() {
			return ErrExternalChange
		}
		mode, existed = info.Mode().Perm(), true
	} else if !errors.Is(err, os.ErrNotExist) {
		return err
	}
	tmpName := randomName()
	tmp, err := f.root.OpenFile(tmpName, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if err != nil {
		return err
	}
	keep := false
	defer func() {
		if !keep {
			_ = f.root.Remove(tmpName)
		}
	}()
	_, err = tmp.WriteString(content)
	if err == nil && existed {
		// Never for a new file: chmod ignores the umask.
		err = tmp.Chmod(mode)
	}
	var written os.FileInfo
	if err == nil {
		// After the chmod, so it compares equal to the file once in place.
		written, err = tmp.Stat()
	}
	if err = errors.Join(err, tmp.Close()); err != nil {
		return err
	}
	f.step(StepTempWritten)

	// Exchange would move a planted link aside and rename would replace it;
	// refuse it instead, so the caller sees an error rather than a silent
	// replacement.
	if info, err := f.root.Lstat(f.name); errors.Is(err, os.ErrNotExist) {
		f.step(StepBeforeReplace)
		// A file created at the name meanwhile is not pedit's to replace,
		// even one that holds expected.
		if err := f.createChecked(tmpName); err != nil {
			return err
		}
		f.createOnly.Store(false)
		return nil
	} else if err != nil {
		return err
	} else if !info.Mode().IsRegular() {
		return f.errNotRegular()
	} else if !existed {
		// Missing at the first look: whatever is there now is someone else's.
		return ErrExternalChange
	}

	if f.noExchange.Load() {
		return f.renameChecked(expected, tmpName)
	}
	f.step(StepBeforeReplace)
	if err := f.calls.exchange(f.root, tmpName, f.name); err != nil {
		switch {
		case errors.Is(err, errUnsupported):
			f.noExchange.Store(true)
			return f.renameChecked(expected, tmpName)
		case errors.Is(err, os.ErrNotExist):
			return f.createChecked(tmpName)
		default:
			// Not known to mean unsupported (EPERM from a sandbox, say): rename
			// this time only.
			return f.renameChecked(expected, tmpName)
		}
	}
	f.step(StepExchanged)

	// What the exchange moved aside is under tmpName now. If it is still what
	// pedit expected, nobody saved in between.
	out, err := f.inspect(tmpName)
	if err == nil && out.holds(expected) {
		time.Sleep(lateWriteDelay)
		f.step(StepRechecking)
		var late entry
		late, err = f.inspect(tmpName)
		if err == nil && late.same(out) {
			return nil
		}
		out = late
	}
	if err != nil {
		keep = true
		return landedError{&KeptError{Name: tmpName, Err: fmt.Errorf("cannot check what pedit replaced in %s; it is kept in %s: %w", f.name, f.kept(tmpName), err)}}
	}
	keep, err = f.restore(tmpName, entry{info: written, content: content, readable: true}, out)
	return err
}

// restore puts back what an exchange moved aside to tmpName, which was not what
// Write expected. placed is what the exchange put under the file's name, and
// displaced what it moved aside. If the file changed again meanwhile, the
// newest save is the one that stays. keep reports whether a save is left
// under tmpName.
//
// The file pedit placed sat under the name until now, and an editor may have
// opened it there. So when it comes back unchanged, restore waits and reads it
// once more, as Write does, before it lets Write drop it: a write that lands
// in it late is a save, and goes back under the name.
func (f *BoundFile) restore(tmpName string, placed, displaced entry) (keep bool, err error) {
	cannotCheck := func(err error) (bool, error) {
		return true, &KeptError{Name: tmpName, Err: fmt.Errorf("%w: cannot check what pedit moved aside from %s; it is kept in %s: %w", ErrExternalChange, f.name, f.kept(tmpName), err)}
	}
	for range maxRestores {
		if err := f.calls.exchange(f.root, tmpName, f.name); err != nil {
			return true, &KeptError{Name: tmpName, Err: fmt.Errorf("%w: cannot put back a save of %s; it is kept in %s: %w", ErrExternalChange, f.name, f.kept(tmpName), err)}
		}
		f.step(StepExchanged)
		out, err := f.inspect(tmpName)
		if err != nil {
			return cannotCheck(err)
		}
		if out.same(placed) {
			time.Sleep(lateWriteDelay)
			f.step(StepRechecking)
			late, err := f.inspect(tmpName)
			if err != nil {
				return cannotCheck(err)
			}
			if late.same(out) {
				if !displaced.regular() {
					return false, f.errNotRegular()
				}
				return false, ErrExternalChange
			}
			out = late
		}
		// Another save landed meanwhile; swap again so the newest stays.
		placed, displaced = displaced, out
	}
	return true, &KeptError{Name: tmpName, Err: fmt.Errorf("%w: %s kept changing while pedit saved it; a save it moved aside is kept in %s", ErrExternalChange, f.name, f.kept(tmpName))}
}

// create puts the file under the file's name only if nothing is there. It
// returns os.ErrExist if something is, and os.ErrNotExist if tmpName is gone.
func (f *BoundFile) create(tmpName string) error {
	if err := f.calls.noReplace(f.root, tmpName, f.name); err == nil || errors.Is(err, os.ErrExist) || errors.Is(err, os.ErrNotExist) {
		return err
	}
	// A hard link fails the same way when the name exists (Windows, NFS);
	// Write's deferred Remove drops the temporary name.
	if err := f.calls.link(f.root, tmpName, f.name); err == nil || errors.Is(err, os.ErrExist) || errors.Is(err, os.ErrNotExist) {
		return err
	}
	if _, err := f.root.Lstat(f.name); err == nil {
		return os.ErrExist
	} else if !errors.Is(err, os.ErrNotExist) {
		return err
	}
	// No hard links either (FAT, exFAT); a file created in between is replaced.
	return f.calls.rename(f.root, tmpName, f.name)
}

// createChecked creates the file, or reports a change if something appeared
// at its name.
func (f *BoundFile) createChecked(tmpName string) error {
	if err := f.create(tmpName); !errors.Is(err, os.ErrExist) {
		return err
	}
	return ErrExternalChange
}

// renameChecked replaces the file by renaming over it where the file system
// cannot exchange. It checks that the file still holds expected first, and
// reports a save written into the replaced file afterwards.
func (f *BoundFile) renameChecked(expected, tmpName string) error {
	e, held, err := f.look(f.name)
	switch {
	case errors.Is(err, os.ErrNotExist):
		return f.createChecked(tmpName)
	case errors.Is(err, errReplaced):
		return ErrExternalChange
	case err != nil:
		return err
	}
	defer func() {
		if held != nil {
			_ = held.Close()
		}
	}()
	if !e.regular() {
		return f.errNotRegular()
	}
	if !e.holds(expected) {
		return ErrExternalChange
	}
	f.step(StepBeforeReplace)
	// Unlinking a name that is not there still takes the directory's lock, so
	// a rename already under way has landed by the Lstat below.
	_ = f.root.Remove(randomName())
	info, err := f.root.Lstat(f.name)
	switch {
	case errors.Is(err, os.ErrNotExist):
		return f.createChecked(tmpName)
	case err != nil:
		return err
	case !info.Mode().IsRegular():
		return f.errNotRegular()
	case !os.SameFile(info, e.info) || info.Size() != e.info.Size() || !info.ModTime().Equal(e.info.ModTime()):
		return ErrExternalChange
	}
	err = f.calls.rename(f.root, tmpName, f.name)
	if err != nil && held != nil {
		// Windows volumes without POSIX rename semantics (FAT, exFAT, some SMB
		// shares) refuse to replace an open file.
		_ = held.Close()
		held = nil
		err = f.calls.rename(f.root, tmpName, f.name)
	}
	if err != nil || held == nil {
		return err
	}
	// A save written into the replaced file after the check is lost.
	time.Sleep(lateWriteDelay)
	f.step(StepRechecking)
	if got, err := readAll(held); err == nil && got != e.content {
		return landedError{ErrSaveOverwritten}
	}
	return nil
}
