package serve

import (
	"bytes"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"time"

	"github.com/piconic-ai/pedit/internal/merge"
	"github.com/reearth/ygo/crdt"
)

// The recovery state of a served file lives in the user's state directory, not
// beside the file (the lock is what lives there): the Yjs document, the text
// pedit last wrote to the file, and the generation that names the document. A
// restarted pedit serve resumes it, so a client that kept its copy merges
// into the same document instead of a new one. Like a kept room's record, it
// is trusted only against the file: text that pedit did not itself write last
// is merged as an external edit, never written back.
// StateVersion is the version of the state file's format, reported by
// `pedit --version --json`.
const StateVersion = 1

const (
	stateVersion  = StateVersion
	stateMaxAge   = 7 * 24 * time.Hour
	stateMaxBytes = 64 << 20
)

type stateRecord struct {
	Version    int
	Generation string
	Saved      time.Time
	// Written is the text pedit last wrote to the file, as the file has it.
	Written string
	// Pending, when set, is the text about to be written: the doc holds it, and
	// a crash may have left it in the file or not.
	Pending *string
	// Doc is the Yjs update of the whole document.
	Doc []byte
}

func newGeneration() string {
	b := make([]byte, 16)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}

// stateRoot is where states go: under StateDir when it is set, else pedit's
// config directory. It is empty when there is no safe place (not the temp directory).
func (o Options) stateRoot() string {
	if o.StateDir != "" {
		return filepath.Join(o.StateDir, "state")
	}
	cfg, err := os.UserConfigDir()
	if err != nil {
		return ""
	}
	return filepath.Join(cfg, "pedit", "serve", "state")
}

func (o Options) statePath(file string) string {
	dir := o.stateRoot()
	if dir == "" {
		return ""
	}
	return filepath.Join(dir, fmt.Sprintf("%x.json", sha256.Sum256([]byte(file))))
}

// readState returns the state at path, or nil when there is none that this
// pedit may use: unreadable, of another version, or older than seven days.
func readState(path string) *stateRecord {
	if path == "" {
		return nil
	}
	before, err := os.Lstat(path)
	if err != nil || !before.Mode().IsRegular() {
		return nil
	}
	f, err := os.Open(path)
	if err != nil {
		return nil
	}
	defer f.Close()
	// Judged on the handle that is read from, not on the name.
	if !stateTrusted(f, before) {
		return nil
	}
	raw, err := io.ReadAll(io.LimitReader(f, stateMaxBytes+1))
	var rec stateRecord
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.DisallowUnknownFields()
	if err != nil || len(raw) > stateMaxBytes || dec.Decode(&rec) != nil || dec.Decode(new(any)) != io.EOF {
		return nil
	}
	if rec.Version != stateVersion || rec.Generation == "" || time.Since(rec.Saved) > stateMaxAge {
		return nil
	}
	return &rec
}

func writeState(path string, rec stateRecord) error {
	if path == "" {
		return nil
	}
	raw, err := json.Marshal(rec)
	if err != nil || len(raw) > stateMaxBytes {
		return errors.New("serve state exceeded its limit")
	}
	dir := filepath.Dir(path)
	_, statErr := os.Stat(dir)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return err
	}
	if statErr != nil {
		if err := privateDir(dir); err != nil {
			return err
		}
	}
	tmp, err := os.CreateTemp(filepath.Dir(path), ".state-*")
	if err != nil {
		return err
	}
	defer os.Remove(tmp.Name())
	_, err = tmp.Write(raw)
	if err = errors.Join(err, tmp.Close()); err == nil {
		err = os.Rename(tmp.Name(), path)
	}
	return err
}

// seed makes the doc from the state if it still fits the file, else from the
// file alone, and sets the generation. A state whose document is not what it
// last wrote is discarded; a file that changed since is merged as an external
// edit, as a save made while pedit ran would be.
func (s *Server) seed(initial string) {
	s.doc = crdt.New()
	s.text = s.doc.GetText("content")
	if rec := readState(s.statePath); rec != nil && s.restore(rec, initial) {
		s.generation = rec.Generation
		return
	}
	s.doc = crdt.New()
	s.text = s.doc.GetText("content")
	s.doc.Transact(func(txn *crdt.Transaction) { s.text.Insert(txn, 0, s.normalize(initial), nil) })
	s.generation = newGeneration()
}

func (s *Server) restore(rec *stateRecord, initial string) (ok bool) {
	defer func() {
		if recover() != nil {
			ok = false
		}
	}()
	if len(rec.Doc) == 0 || crdt.ApplyUpdateV1(s.doc, rec.Doc, nil) != nil {
		return false
	}
	if pending := s.doc.PendingStats(); pending.Items != 0 || pending.DeleteRanges != 0 {
		return false
	}
	base, want := s.normalize(rec.Written), s.normalize(rec.Written)
	if rec.Pending != nil {
		want = s.normalize(*rec.Pending)
	}
	if s.text.ToString() != want {
		return false
	}
	// The file holds what pedit wrote, or what it was about to write (then the
	// doc is ahead of the file and is written again). Anything else is an
	// edit by someone else, to be merged from the text the editor started
	// from; with a write in doubt that text is not known, so start afresh.
	if rec.Pending != nil && initial != rec.Written && initial != *rec.Pending {
		return false
	}
	if initial != rec.Written && rec.Pending == nil {
		merge.ExternalEdit(s.doc, s.text, base, s.normalize(initial), &fileOrigin{})
	}
	return true
}

// saveState records the document with the text last written. A failure is
// reported and does not stop serving: the state only makes a restart smoother.
func (s *Server) saveState(written string, pending *string) {
	s.mu.Lock()
	doc := crdt.EncodeStateAsUpdateV1(s.doc, nil)
	s.mu.Unlock()
	rec := stateRecord{Version: stateVersion, Generation: s.generation, Saved: time.Now(), Written: written, Pending: pending, Doc: doc}
	if err := writeState(s.statePath, rec); err != nil {
		s.opts.OnError(fmt.Errorf("cannot save the recovery state: %w", err))
	}
}

// Generation names this document: a restart that resumed the state keeps it.
func (s *Server) Generation() string { return s.generation }

// forgetState removes the state of file, which no longer exists.
func forgetState(opts Options, file string) {
	if dir, err := filepath.EvalSymlinks(filepath.Dir(file)); err == nil {
		_ = os.Remove(opts.statePath(filepath.Join(dir, filepath.Base(file))))
	}
}
