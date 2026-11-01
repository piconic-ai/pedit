package serve

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"
)

// maxAppLen caps the app name taken from a lock file, in bytes.
const maxAppLen = 64

// holder is what the lock file says about the process serving a file.
type holder struct {
	PID int    `json:"pid"`
	App string `json:"app,omitempty"`
}

func (h holder) String() string {
	switch {
	case h.PID == 0:
		return "another pedit serve"
	case h.App != "":
		return fmt.Sprintf("pid %d, app %q", h.PID, cleanApp(h.App))
	}
	return fmt.Sprintf("pid %d", h.PID)
}

// cleanApp makes a name read from a lock file fit for a message: at most
// maxAppLen bytes, valid UTF-8, no control or unprintable characters.
func cleanApp(s string) string {
	if len(s) > maxAppLen {
		s = s[:maxAppLen]
	}
	s = strings.ToValidUTF8(s, "")
	return strings.Map(func(r rune) rune {
		if r == utf8.RuneError || !unicode.IsPrint(r) {
			return -1
		}
		return r
	}, s)
}

// HeldError means another process is serving the file. The pid and app are
// labels read from the lock file, which anyone who can write the directory
// can forge: only the OS lock on it is the truth, and pedit never signals the
// pid. The app is capped and cleaned before it is shown.
type HeldError struct {
	File   string
	Holder holder
}

func (e *HeldError) Error() string {
	return fmt.Sprintf("%s is already served by %s", e.File, e.Holder)
}

// lockPath is the lock file beside the file. The OS advisory lock on it is
// what excludes a second server (it is released when the process ends, crash
// included, so a lock file left behind is stale by itself); the content only
// names the holder for the refusal message.
func lockPath(file string) string {
	return filepath.Join(filepath.Dir(file), "."+filepath.Base(file)+".pedit-lock")
}

// errNotLock is a lock path that holds something pedit did not make.
func errNotLock(path string) error {
	return fmt.Errorf("cannot take the lock: %s is not a lock file pedit made", path)
}

// acquire takes the file's lock, or returns a *HeldError naming its holder.
// The lock file is reached through a handle on the file's directory and never
// through a symlink; what is not a regular file of ours is left alone.
func acquire(file, app string) (release func(), err error) {
	path := lockPath(file)
	root, err := os.OpenRoot(filepath.Dir(file))
	if err != nil {
		return nil, err
	}
	name := filepath.Base(path)
	for range 5 {
		// Lstat first: the checks on the open file below are what count, but
		// this names a planted link without asking the OS to resolve it.
		if info, err := root.Lstat(name); err == nil && !info.Mode().IsRegular() {
			_ = root.Close()
			return nil, errNotLock(path)
		}
		f, err := openLock(root, name)
		if errors.Is(err, fs.ErrNotExist) {
			continue // removed by the previous holder as we created it
		}
		if err != nil {
			_ = root.Close()
			if isNotLock(err) {
				return nil, errNotLock(path)
			}
			return nil, err
		}
		if info, err := f.Stat(); err != nil || !ours(info) {
			_ = f.Close()
			_ = root.Close()
			return nil, errNotLock(path)
		}
		ok, err := lockFile(f)
		if err != nil {
			_ = f.Close()
			_ = root.Close()
			return nil, err
		}
		if !ok {
			_ = f.Close()
			h := readHolder(root, name)
			_ = root.Close()
			return nil, &HeldError{File: file, Holder: h}
		}
		// The previous holder removes the file while it still holds the
		// lock: if what we locked is no longer at the path, lock again.
		info, serr := f.Stat()
		at, perr := root.Lstat(name)
		if serr != nil || perr != nil || !os.SameFile(info, at) {
			_ = f.Close()
			continue
		}
		data, _ := json.Marshal(holder{PID: os.Getpid(), App: app})
		if err := f.Truncate(0); err == nil {
			_, err = f.WriteAt(data, 0)
		}
		if err != nil {
			_ = f.Close()
			_ = root.Close()
			return nil, err
		}
		return func() {
			unlockFile(f, root, name)
			_ = root.Close()
		}, nil
	}
	_ = root.Close()
	return nil, fmt.Errorf("cannot take the lock %s", path)
}

// readHolder reads who holds the lock, from a lock file that is ours and
// small. The holder writes its name right after locking, so an empty file is
// read again for a moment.
func readHolder(root *os.Root, name string) holder {
	var h holder
	for range 20 {
		if b := readLock(root, name); json.Unmarshal(b, &h) == nil && h.PID > 0 {
			h.App = cleanApp(h.App)
			return h
		}
		time.Sleep(5 * time.Millisecond)
	}
	return holder{}
}

func readLock(root *os.Root, name string) []byte {
	f, err := openLockRead(root, name)
	if err != nil {
		return nil
	}
	defer f.Close()
	if info, err := f.Stat(); err != nil || !ours(info) {
		return nil
	}
	b, _ := io.ReadAll(io.LimitReader(f, 4096))
	return b
}
