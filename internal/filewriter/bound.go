package filewriter

import (
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
)

// BoundFile keeps the shared directory open for the lifetime of a session.
// Renaming a file within it is allowed; replacing it with a link is not.
type BoundFile struct {
	root *os.Root
	name string
}

func OpenBound(path string) (*BoundFile, error) {
	root, err := os.OpenRoot(filepath.Dir(path))
	if err != nil {
		return nil, err
	}
	f := &BoundFile{root: root, name: filepath.Base(path)}
	if info, err := root.Lstat(f.name); err == nil && !info.Mode().IsRegular() {
		_ = root.Close()
		return nil, fmt.Errorf("shared file %s is not a regular file", path)
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

func (f *BoundFile) Validate() error {
	info, err := f.root.Lstat(f.name)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	if !info.Mode().IsRegular() {
		return fmt.Errorf("shared file %s is not a regular file", f.name)
	}
	return nil
}

// Read verifies the opened descriptor against the entry inspected before open.
// Root prevents a raced link from escaping the anchored directory; SameFile
// rejects a raced link to another file inside it. The content comes back as
// it is on disk, which may not be UTF-8: callers check before taking it in.
func (f *BoundFile) Read() (string, bool) {
	before, err := f.root.Lstat(f.name)
	if err != nil || !before.Mode().IsRegular() {
		return "", false
	}
	opened, err := f.root.Open(f.name)
	if err != nil {
		return "", false
	}
	defer opened.Close()
	after, err := opened.Stat()
	if err != nil || !after.Mode().IsRegular() || !os.SameFile(before, after) {
		return "", false
	}
	b, err := io.ReadAll(opened)
	if err != nil {
		return "", false
	}
	return string(b), true
}

func (f *BoundFile) Write(content string) error {
	var mode os.FileMode = 0o600
	if info, err := f.root.Lstat(f.name); err == nil {
		if !info.Mode().IsRegular() {
			return fmt.Errorf("shared file %s is not a regular file", f.name)
		}
		mode = info.Mode().Perm()
	} else if !errors.Is(err, os.ErrNotExist) {
		return err
	}
	var random [16]byte
	if _, err := rand.Read(random[:]); err != nil {
		return err
	}
	tmpName := ".pedit-" + hex.EncodeToString(random[:]) + ".tmp"
	tmp, err := f.root.OpenFile(tmpName, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if err != nil {
		return err
	}
	defer f.root.Remove(tmpName)
	_, err = tmp.WriteString(content)
	if err == nil {
		err = tmp.Chmod(mode)
	}
	if err = errors.Join(err, tmp.Close()); err != nil {
		return err
	}
	// Rename replaces a planted link rather than writing through it. Refuse it
	// anyway so a changed target is visible to the caller as an error.
	if info, err := f.root.Lstat(f.name); err == nil && !info.Mode().IsRegular() {
		return fmt.Errorf("shared file %s is not a regular file", f.name)
	} else if err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	return f.root.Rename(tmpName, f.name)
}
