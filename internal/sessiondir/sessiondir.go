// Package sessiondir lets short commands reach a running pedit session on
// the same machine: a session registers a directory of its own under the
// user's configuration, and a command leaves a request there and waits for
// the answer (docs/design/comments-cli.md). Nothing in it names a path on
// disk or holds a key.
package sessiondir

import (
	"bytes"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"time"

	"github.com/fsnotify/fsnotify"
	"github.com/piconic-ai/pedit/internal/flock"
)

// Version is the version of the files this package writes and reads.
const Version = 1

// MaxRequestBytes bounds a request: a comment is at most 4,000 UTF-16 code
// units, which JSON writes in less.
const MaxRequestBytes = 64 << 10

// The names in a session's directory.
const (
	infoName = "session.json"
	lockName = "lock"
	reqDir   = "req"
	workDir  = "work"
	resDir   = "res"
)

// Info is what a session tells about itself, in session.json.
type Info struct {
	Version int      `json:"version"`
	PID     int      `json:"pid"`
	Room    string   `json:"room"`
	Access  string   `json:"access"`
	Project string   `json:"project,omitempty"`
	Name    string   `json:"name"`
	Files   []string `json:"files"`
}

// Request is what a command asks of a session.
type Request struct {
	Version int    `json:"version"`
	Op      string `json:"op"`
	File    string `json:"file"`
	Thread  string `json:"thread"`
	Message string `json:"message"`
	Body    string `json:"body"`
}

// The ops of a Request.
const (
	OpList    = "list"
	OpReply   = "reply"
	OpResolve = "resolve"
	OpReopen  = "reopen"
)

// Answer is a session's answer to a Request.
type Answer struct {
	Version   int      `json:"version"`
	OK        bool     `json:"ok"`
	Error     string   `json:"error,omitempty"`
	Message   string   `json:"message,omitempty"`
	Delivered *bool    `json:"delivered,omitempty"`
	Threads   []Thread `json:"threads,omitempty"`
}

// Thread is a comment thread as pedit comments list --json prints it.
type Thread struct {
	File     string    `json:"file"`
	Thread   string    `json:"thread"`
	Anchor   Anchor    `json:"anchor"`
	Quote    string    `json:"quote"`
	Resolved bool      `json:"resolved"`
	Messages []Message `json:"messages"`
}

// Anchor is the kind of place a thread is on, and the node's id for a
// canvas node.
type Anchor struct {
	Type string `json:"type"`
	ID   string `json:"id,omitempty"`
}

// Message is one comment of a Thread.
type Message struct {
	ID     string `json:"id"`
	Author string `json:"author"`
	Time   string `json:"time"`
	Body   string `json:"body"`
}

// Base is where sessions register: <UserConfigDir>/pedit/sessions.
func Base() (string, error) {
	config, err := os.UserConfigDir()
	if err != nil {
		return "", errors.New("cannot locate the user's configuration directory")
	}
	return filepath.Join(config, "pedit", "sessions"), nil
}

// Dir is the directory of a running session.
type Dir struct {
	ID   string
	path string
	lock *os.File

	mu      sync.Mutex
	watcher *fsnotify.Watcher
	done    chan struct{}
	working sync.WaitGroup
	closed  bool
}

// Register makes the directory of a session under base, private to the
// user, takes its lock and writes info.
func Register(base string, info Info) (*Dir, error) {
	if err := makePrivateDir(base); err != nil {
		return nil, fmt.Errorf("cannot make %s: %w", base, err)
	}
	id := randomID()
	path := filepath.Join(base, id)
	if err := os.Mkdir(path, 0o700); err != nil {
		return nil, err
	}
	d := &Dir{ID: id, path: path}
	fail := func(err error) (*Dir, error) {
		d.remove()
		return nil, err
	}
	if err := privateDir(path); err != nil {
		return fail(err)
	}
	lock, err := os.OpenFile(filepath.Join(path, lockName), os.O_RDWR|os.O_CREATE|os.O_EXCL, 0o600)
	if err != nil {
		return fail(err)
	}
	d.lock = lock
	if ok, err := flock.TryLock(lock); !ok || err != nil {
		return fail(fmt.Errorf("cannot lock %s: %v", lock.Name(), err))
	}
	for _, sub := range []string{reqDir, workDir, resDir} {
		if err := os.Mkdir(filepath.Join(path, sub), 0o700); err != nil {
			return fail(err)
		}
	}
	info.Version = Version
	data, err := json.Marshal(info)
	if err != nil {
		return fail(err)
	}
	if err := writeAtomic(path, infoName, data); err != nil {
		return fail(err)
	}
	return d, nil
}

// Serve hands each request left for the session to handle, each on a
// goroutine of its own, and writes its answer. A request is taken by moving
// it out of req/, so a command that gives up at the same time withdraws it
// or finds it taken, never both.
func (d *Dir) Serve(handle func(Request) Answer) error {
	w, err := fsnotify.NewWatcher()
	if err != nil {
		return err
	}
	if err := w.Add(filepath.Join(d.path, reqDir)); err != nil {
		_ = w.Close()
		return err
	}
	d.mu.Lock()
	d.watcher, d.done = w, make(chan struct{})
	d.mu.Unlock()
	go func() {
		defer close(d.done)
		d.takeAll(handle)
		for {
			select {
			case _, ok := <-w.Events:
				if !ok {
					return
				}
				d.takeAll(handle)
			case _, ok := <-w.Errors:
				if !ok {
					return
				}
				// An overflow drops events: read what is there.
				d.takeAll(handle)
			}
		}
	}()
	return nil
}

// takeAll takes every request in req/.
func (d *Dir) takeAll(handle func(Request) Answer) {
	entries, err := os.ReadDir(filepath.Join(d.path, reqDir))
	if err != nil {
		return
	}
	for _, e := range entries {
		name := e.Name()
		if !requestName(name) {
			continue
		}
		work := filepath.Join(d.path, workDir, name)
		if os.Rename(filepath.Join(d.path, reqDir, name), work) != nil {
			continue // withdrawn, or taken already
		}
		d.mu.Lock()
		if d.closed {
			d.mu.Unlock()
			_ = os.Remove(work)
			return
		}
		d.working.Add(1)
		d.mu.Unlock()
		go func() {
			defer d.working.Done()
			req, err := readRequest(work)
			var a Answer
			if err != nil {
				a = Answer{Error: "unreadable request: " + err.Error()}
			} else {
				a = handle(req)
			}
			a.Version = Version
			if data, err := json.Marshal(a); err == nil {
				_ = writeAtomic(filepath.Join(d.path, resDir), name, data)
			}
			_ = os.Remove(work)
		}()
	}
}

// Close stops serving, waits for the requests under way, and removes the
// directory.
func (d *Dir) Close() {
	d.mu.Lock()
	if d.closed {
		d.mu.Unlock()
		return
	}
	d.closed = true
	w, done := d.watcher, d.done
	d.mu.Unlock()
	if w != nil {
		_ = w.Close()
		<-done
	}
	d.working.Wait()
	// The commands waiting take their answers before the directory goes.
	for range 40 {
		if entries, err := os.ReadDir(filepath.Join(d.path, resDir)); err != nil || !hasAnswer(entries) {
			break
		}
		time.Sleep(50 * time.Millisecond)
	}
	d.remove()
}

func hasAnswer(entries []os.DirEntry) bool {
	for _, e := range entries {
		if requestName(e.Name()) {
			return true
		}
	}
	return false
}

func (d *Dir) remove() {
	if d.lock != nil {
		_ = d.lock.Close()
	}
	_ = os.RemoveAll(d.path)
}

// requestName is the name of a request a command left: <nonce>.json, not a
// temporary name.
func requestName(name string) bool {
	nonce, ok := strings.CutSuffix(name, ".json")
	if !ok || len(nonce) != 32 {
		return false
	}
	_, err := hex.DecodeString(nonce)
	return err == nil
}

// readRequest reads a request: a regular file, no link, of at most
// MaxRequestBytes, with exactly the keys of a Request, each once.
func readRequest(path string) (Request, error) {
	info, err := os.Lstat(path)
	if err != nil {
		return Request{}, err
	}
	if !info.Mode().IsRegular() || info.Size() > MaxRequestBytes {
		return Request{}, errors.New("not a request")
	}
	f, err := os.Open(path)
	if err != nil {
		return Request{}, err
	}
	defer f.Close()
	data, err := io.ReadAll(io.LimitReader(f, MaxRequestBytes+1))
	if err != nil || len(data) > MaxRequestBytes {
		return Request{}, errors.New("not a request")
	}
	return parseRequest(data)
}

var requestKeys = []string{"version", "op", "file", "thread", "message", "body"}

func parseRequest(data []byte) (Request, error) {
	if err := exactKeys(data, requestKeys); err != nil {
		return Request{}, err
	}
	var r Request
	dec := json.NewDecoder(bytes.NewReader(data))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&r); err != nil {
		return Request{}, err
	}
	if _, err := dec.Token(); err != io.EOF {
		return Request{}, errors.New("trailing data")
	}
	if r.Version != Version {
		return Request{}, fmt.Errorf("version %d, not %d", r.Version, Version)
	}
	if !slices.Contains([]string{OpList, OpReply, OpResolve, OpReopen}, r.Op) {
		return Request{}, fmt.Errorf("unknown op %q", r.Op)
	}
	return r, nil
}

// exactKeys refuses a JSON object with a key that is not one of keys, in
// any case, or one named twice: encoding/json would match a field in any
// case and take the last.
func exactKeys(data []byte, keys []string) error {
	dec := json.NewDecoder(bytes.NewReader(data))
	if t, err := dec.Token(); err != nil || t != json.Delim('{') {
		return errors.New("not a JSON object")
	}
	seen := map[string]bool{}
	for dec.More() {
		t, err := dec.Token()
		if err != nil {
			return err
		}
		k, _ := t.(string)
		if !slices.Contains(keys, k) || seen[k] {
			return fmt.Errorf("unexpected key %q", k)
		}
		seen[k] = true
		var skip json.RawMessage
		if err := dec.Decode(&skip); err != nil {
			return err
		}
	}
	return nil
}

// writeAtomic writes data to dir/name through a temporary name, so a
// reader never sees half of it.
func writeAtomic(dir, name string, data []byte) error {
	tmp, err := os.CreateTemp(dir, ".tmp-*")
	if err != nil {
		return err
	}
	defer os.Remove(tmp.Name())
	_, err = tmp.Write(data)
	if err = errors.Join(err, tmp.Close()); err != nil {
		return err
	}
	return os.Rename(tmp.Name(), filepath.Join(dir, name))
}

func randomID() string {
	var b [16]byte
	_, _ = rand.Read(b[:])
	return hex.EncodeToString(b[:])
}

// makePrivateDir makes dir and its parents, the last one private to the
// user, and refuses a dir that is not: another user must not reach it.
func makePrivateDir(dir string) error {
	if _, err := os.Lstat(dir); errors.Is(err, os.ErrNotExist) {
		if err := os.MkdirAll(filepath.Dir(dir), 0o700); err != nil {
			return err
		}
		if err := os.Mkdir(dir, 0o700); err != nil && !errors.Is(err, os.ErrExist) {
			return err
		}
		if err := privateDir(dir); err != nil {
			return err
		}
	}
	return checkPrivate(dir)
}

// Live is a session found running.
type Live struct {
	ID   string
	Info Info
	path string
}

// List lists the sessions running under base. The directory of a session
// whose lock is free ended without cleaning up, and is removed.
func List(base string) ([]Live, error) {
	entries, err := os.ReadDir(base)
	if errors.Is(err, os.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	if err := checkPrivate(base); err != nil {
		return nil, err
	}
	var out []Live
	for _, e := range entries {
		if !e.IsDir() || len(e.Name()) != 32 {
			continue
		}
		path := filepath.Join(base, e.Name())
		live, running := readLive(path)
		if !running {
			_ = os.RemoveAll(path)
			continue
		}
		if live != nil {
			live.ID = e.Name()
			out = append(out, *live)
		}
	}
	return out, nil
}

// readLive tells whether the session of path runs, by its lock, and what it
// says about itself.
func readLive(path string) (*Live, bool) {
	lock, err := os.OpenFile(filepath.Join(path, lockName), os.O_RDWR, 0)
	if errors.Is(err, os.ErrNotExist) {
		// Being made, or half removed: leave it to its session, unless old.
		info, err := os.Stat(path)
		return nil, err == nil && time.Since(info.ModTime()) < time.Minute
	}
	if err != nil {
		// Held open by its session where locks keep others out (Windows).
		return readInfo(path), true
	}
	ok, err := flock.TryLock(lock)
	_ = lock.Close()
	if ok || err != nil {
		return nil, !ok
	}
	return readInfo(path), true
}

func readInfo(path string) *Live {
	data, err := os.ReadFile(filepath.Join(path, infoName))
	if err != nil {
		return nil
	}
	var info Info
	if json.Unmarshal(data, &info) != nil || info.Version != Version {
		return nil
	}
	return &Live{Info: info, path: path}
}

// Errors of Call.
var (
	// ErrWithdrawn means the session did not take the request in time, and
	// it was withdrawn: nothing was done.
	ErrWithdrawn = errors.New("the session did not answer; nothing was done")
	// ErrUnknown means the session took the request but did not answer in
	// time: what it did is not known.
	ErrUnknown = errors.New("the session took the request but did not answer in time")
	// ErrGone means the session ended before it answered.
	ErrGone = errors.New("the session ended")
)

// Call leaves req for the session and waits up to wait for its answer.
func (l Live) Call(req Request, wait time.Duration) (Answer, error) {
	req.Version = Version
	data, err := json.Marshal(req)
	if err != nil {
		return Answer{}, err
	}
	if len(data) > MaxRequestBytes {
		return Answer{}, errors.New("the request is too large")
	}
	w, err := fsnotify.NewWatcher()
	if err != nil {
		return Answer{}, err
	}
	defer w.Close()
	res := filepath.Join(l.path, resDir)
	if err := w.Add(res); err != nil {
		return Answer{}, ErrGone
	}
	name := randomID() + ".json"
	if err := writeAtomic(filepath.Join(l.path, reqDir), name, data); err != nil {
		return Answer{}, ErrGone
	}
	return l.await(w, name, wait)
}

// await waits for the answer to the request name, and withdraws the request
// if none comes in time.
func (l Live) await(w *fsnotify.Watcher, name string, wait time.Duration) (Answer, error) {
	answer := filepath.Join(l.path, resDir, name)
	deadline := time.NewTimer(wait)
	defer deadline.Stop()
	for {
		if a, ok := readAnswer(answer); ok {
			_ = os.Remove(answer)
			return a, nil
		}
		select {
		case _, ok := <-w.Events:
			if !ok {
				return Answer{}, ErrGone
			}
		case <-w.Errors:
		case <-deadline.C:
			if a, ok := readAnswer(answer); ok {
				_ = os.Remove(answer)
				return a, nil
			}
			return Answer{}, l.withdraw(name)
		}
	}
}

// withdraw takes back a request the session has not taken: ErrWithdrawn
// when it could, ErrUnknown when the session had taken it.
func (l Live) withdraw(name string) error {
	withdrawn := filepath.Join(l.path, reqDir, ".withdrawn-"+name)
	if os.Rename(filepath.Join(l.path, reqDir, name), withdrawn) == nil {
		_ = os.Remove(withdrawn)
		return ErrWithdrawn
	}
	if _, err := os.Stat(l.path); err != nil {
		return ErrGone
	}
	return ErrUnknown
}

func readAnswer(path string) (Answer, bool) {
	data, err := os.ReadFile(path)
	if err != nil {
		return Answer{}, false
	}
	var a Answer
	if json.Unmarshal(data, &a) != nil || a.Version != Version {
		return Answer{Error: "the session's answer is unreadable"}, true
	}
	return a, true
}
