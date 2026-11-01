package serve

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
)

// holder is what the lock file says about the process serving a file.
type holder struct {
	PID int    `json:"pid"`
	App string `json:"app,omitempty"`
}

func (h holder) String() string {
	if h.App != "" {
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

// lockPath is the lock file beside the file: a lock file rather than flock,
// so it also names the holder, and a crash leaves it behind with a dead pid,
// which the next pedit serve takes over.
func lockPath(file string) string {
	return filepath.Join(filepath.Dir(file), "."+filepath.Base(file)+".pedit-lock")
}

// acquire takes the file's lock, or returns a *HeldError naming its holder.
func acquire(file, app string) (release func(), err error) {
	path := lockPath(file)
	data, _ := json.Marshal(holder{PID: os.Getpid(), App: app})
	for range 3 {
		f, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
		if err == nil {
			_, werr := f.Write(data)
			if cerr := f.Close(); werr == nil {
				werr = cerr
			}
			if werr != nil {
				_ = os.Remove(path)
				return nil, werr
			}
			return func() { _ = os.Remove(path) }, nil
		}
		if !errors.Is(err, os.ErrExist) {
			return nil, err
		}
		var h holder
		if b, err := os.ReadFile(path); err == nil && json.Unmarshal(b, &h) == nil && pidAlive(h.PID) {
			return nil, &HeldError{File: file, Holder: h}
		}
		// Dead holder, or a lock that was never filled in: take it over.
		// Two takers racing here may both remove and one then fails to
		// create; the loop lets that one see the winner.
		_ = os.Remove(path)
	}
	return nil, fmt.Errorf("cannot take the lock %s", path)
}
