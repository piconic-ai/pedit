package serve

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"time"
)

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
		return fmt.Sprintf("pid %d, app %q", h.PID, h.App)
	}
	return fmt.Sprintf("pid %d", h.PID)
}

// HeldError means another process is serving the file.
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

// acquire takes the file's lock, or returns a *HeldError naming its holder.
func acquire(file, app string) (release func(), err error) {
	path := lockPath(file)
	for range 5 {
		f, err := openLock(path)
		if err != nil {
			return nil, err
		}
		ok, err := lockFile(f)
		if err != nil {
			_ = f.Close()
			return nil, err
		}
		if !ok {
			_ = f.Close()
			return nil, &HeldError{File: file, Holder: readHolder(path)}
		}
		// The previous holder removes the file while it still holds the
		// lock: if what we locked is no longer at the path, lock again.
		info, serr := f.Stat()
		at, perr := os.Stat(path)
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
			return nil, err
		}
		return func() { unlockFile(f, path) }, nil
	}
	return nil, fmt.Errorf("cannot take the lock %s", path)
}

// readHolder reads who holds the lock. The holder writes its name right
// after locking, so an empty file is read again for a moment.
func readHolder(path string) holder {
	var h holder
	for range 20 {
		if b, err := os.ReadFile(path); err == nil && json.Unmarshal(b, &h) == nil && h.PID > 0 {
			return h
		}
		time.Sleep(5 * time.Millisecond)
	}
	return holder{}
}
