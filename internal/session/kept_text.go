package session

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/piconic-ai/pedit/internal/filewriter"
	"github.com/piconic-ai/pedit/internal/merge"
	"github.com/piconic-ai/pedit/internal/protocol"
	"github.com/reearth/ygo/crdt"
)

type KeptTextOptions struct {
	File, Project, Server, Resume string
	More                          []string
	Keep                          time.Duration
	OnSkipped                     func(int)
}
type keptTextState struct {
	Project, Origin, Fragment, HostToken string
	Keep                                 int64
	Files                                []keptTextFileState
	Initialized                          bool
}
type keptTextFileState struct {
	ID         uint32
	Path, File string
	State      []byte
	Text       string
	Pending    *string `json:",omitempty"`
}
type keptTextDocument struct {
	doc   *crdt.Doc
	bound *filewriter.BoundFile
}
type keptTextMeta struct {
	Seconds int64 `json:"keepSeconds"`
	Until   int64 `json:"keepUntil"`
}
type keptTextRead struct {
	Snapshot []byte `json:"snapshot"`
	Entries  []struct {
		ID   uint64 `json:"id"`
		Body []byte `json:"body"`
	} `json:"entries"`
	Tail      uint64 `json:"tail"`
	Cutoff    uint64 `json:"cutoff"`
	HostAway  bool   `json:"hostAway"`
	KeepUntil int64  `json:"keepUntil"`
	ETag      string `json:"-"`
	Unchanged bool   `json:"-"`
}

var keptTextRoomID = regexp.MustCompile(`^[A-Za-z0-9_-]{22}$`)

type keptTextHost struct {
	snapshotNames map[uint32]string
	state         keptTextState
	room, path    string
	client        *http.Client
	keys          *protocol.RoomKeys
	files         map[uint32]*keptTextDocument
	meta          keptTextMeta
	after         uint64
	etag          string
	skipped       int
	onSkipped     func(int)
}

// RunKeptText keeps the relay open when the host leaves. Source changes made
// outside this session are refused rather than overwritten.
func RunKeptText(ctx context.Context, opts KeptTextOptions, ready func(string, int64, int64), leave func(int64)) (runErr error) {
	if runtime.GOOS == "windows" {
		return errors.New("--keep and --resume require Unix file permissions; Windows is not supported")
	}
	h := keptTextHost{client: &http.Client{Timeout: 10 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}, onSkipped: opts.OnSkipped}
	if e := h.prepare(ctx, opts); e != nil {
		return e
	}
	if e := h.openFiles(); e != nil {
		return e
	}
	defer h.closeFiles()
	if e := h.restore(); e != nil {
		return e
	}
	if e := h.connect(ctx); e != nil {
		return e
	}
	defer func() {
		away, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_, e := keptTextRequest(away, h.client, &h.state, h.room, "POST", "/away", nil, nil, &h.meta)
		if e != nil && runErr == nil {
			runErr = e
		}
		if e == nil && ctx.Err() != nil && leave != nil {
			leave(h.meta.Until)
		}
	}()
	h.state.Initialized = true
	if e := saveKeptState(h.path, h.state); e != nil {
		return e
	}
	if e := h.sync(ctx); e != nil {
		return e
	}
	if h.meta.Seconds <= 0 || h.meta.Seconds > h.state.Keep {
		return errors.New("invalid relay keep duration")
	}
	if ready != nil {
		ready(h.state.Origin+"/r/"+h.room+"?keep=1#"+h.state.Fragment, h.meta.Seconds, h.meta.Until)
	}
	ticker := time.NewTicker(500 * time.Millisecond)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return nil
		case <-ticker.C:
			if e := h.sync(ctx); e != nil && ctx.Err() == nil {
				return e
			}
		}
	}
}

func (h *keptTextHost) prepare(ctx context.Context, opts KeptTextOptions) error {
	project, e := filepath.Abs(opts.Project)
	if e != nil {
		return errors.New("invalid kept project")
	}
	project = filepath.Clean(project)
	if e := refuseLegacyKeptState(project); e != nil {
		return e
	}
	directory, e := keptTextDirectory(project)
	if e != nil {
		return e
	}
	if opts.Resume != "" {
		e = h.resume(opts, directory)
	} else {
		e = h.create(ctx, opts)
		h.state.Project = project
	}
	if e != nil {
		return e
	}
	h.path = filepath.Join(directory, h.room+".json")
	digest := sha256.Sum256([]byte(h.state.HostToken))
	if h.state.Project != project || h.state.Keep <= 0 ||
		base64.RawURLEncoding.EncodeToString(digest[:])[:22] != h.room {
		return errors.New("invalid saved kept state or project")
	}
	if len(h.state.Files) < 1 || len(h.state.Files) > 64 {
		return errors.New("invalid saved kept inventory")
	}
	if opts.File != "" {
		file, e := filepath.Abs(opts.File)
		if e != nil || file != h.state.Files[0].File {
			return errors.New("resume file differs from saved host state")
		}
	}
	link, e := protocol.ParseFragment(h.state.Fragment)
	if e != nil || link.Access != protocol.AccessEdit {
		return errors.New("invalid kept edit key")
	}
	h.keys, e = protocol.DeriveRoomKeys(link, h.room)
	if e != nil {
		return errors.New("invalid kept room keys")
	}
	return nil
}

func (h *keptTextHost) resume(opts KeptTextOptions, directory string) error {
	u, e := url.Parse(opts.Resume)
	if e != nil || u.User != nil || u.RawQuery != "keep=1" ||
		(u.Scheme != "http" && u.Scheme != "https") ||
		!strings.HasPrefix(u.Path, "/r/") {
		return errors.New("invalid resume link")
	}
	h.room = strings.TrimPrefix(u.Path, "/r/")
	if !keptTextRoomID.MatchString(h.room) {
		return errors.New("invalid resume room")
	}
	if e := readKeptState(filepath.Join(directory, h.room+".json"), &h.state); e != nil {
		return e
	}
	if opts.Resume != h.state.Origin+"/r/"+h.room+"?keep=1#"+h.state.Fragment ||
		(opts.Server != "" && strings.TrimRight(opts.Server, "/") != h.state.Origin) {
		return errors.New("resume link differs from saved host state")
	}
	return nil
}

func (h *keptTextHost) create(ctx context.Context, opts KeptTextOptions) error {
	if opts.Keep <= 0 || opts.Keep%time.Second != 0 {
		return errors.New("invalid keep duration")
	}
	origin, e := url.Parse(strings.TrimRight(opts.Server, "/"))
	if e != nil || origin.User != nil || origin.Host == "" || origin.Path != "" ||
		origin.RawQuery != "" || origin.Fragment != "" ||
		(origin.Scheme != "https" && origin.Scheme != "http") {
		return errors.New("invalid kept server")
	}
	files, e := prepareKeptFiles(opts)
	if e != nil {
		return e
	}
	r, e := createRoom(ctx, h.client, origin.String(), nil)
	if e != nil || !keptTextRoomID.MatchString(r.ID) {
		return errors.New("could not create kept room")
	}
	h.room = r.ID
	h.state = keptTextState{Files: files, Origin: origin.String(), Fragment: protocol.GenerateEditSecret(), HostToken: r.HostToken, Keep: int64(opts.Keep / time.Second)}
	return nil
}

func (h *keptTextHost) restore() error {
	for _, file := range h.state.Files {
		expected := file.Text
		if file.Pending != nil {
			expected = *file.Pending
		}
		doc := h.files[file.ID].doc
		if e := applyKeptText(doc, file.State); e != nil || !completeKeptText(doc) || doc.GetText("content").ToString() != expected {
			return errors.New("invalid saved kept document")
		}
	}
	if e := h.mergeLocalEdits(); e != nil {
		return e
	}
	if _, e := h.snapshot(); e != nil {
		return e
	}
	return h.finishWrites()
}

// mergeLocalEdits folds edits made to a source file while the host was away
// into its checkpoint document, as host edits, the way a live room merges a
// save from another editor. The relay log is applied later by sync, so both
// sides merge before the file is written and the log is cut. A file that
// cannot be read, is not valid UTF-8 or is too large is left alone, and
// finishWrites then refuses it as it always did.
func (h *keptTextHost) mergeLocalEdits() error {
	changed := false
	for i := range h.state.Files {
		file := &h.state.Files[i]
		expected := file.Text
		if file.Pending != nil {
			expected = *file.Pending
		}
		onDisk, ok := h.files[file.ID].bound.Read()
		if !ok || onDisk == file.Text || onDisk == expected || !utf8.ValidString(onDisk) || len(onDisk) > protocol.MaxFrameBytes {
			continue
		}
		doc := h.files[file.ID].doc
		merge.ExternalEdit(doc, doc.GetText("content"), expected, onDisk, nil)
		file.State, file.Text, file.Pending = crdt.EncodeStateAsUpdateV1(doc, nil), onDisk, nil
		changed = true
	}
	if !changed {
		return nil
	}
	return saveKeptState(h.path, h.state)
}

func (h *keptTextHost) connect(ctx context.Context) error {
	if !h.state.Initialized {
		frame, e := h.snapshot()
		if e != nil {
			return e
		}
		status, e := keptTextRequest(ctx, h.client, &h.state, h.room, "POST", "/init", frame, http.Header{"X-Pedit-Editor": {h.keys.EditAdmission}, "X-Pedit-Reader": {h.keys.ReadAdmission}, "X-Pedit-Keep-Seconds": {strconv.FormatInt(h.state.Keep, 10)}}, &h.meta)
		if e != nil && status != http.StatusConflict {
			return e
		}
	}
	_, e := keptTextRequest(ctx, h.client, &h.state, h.room, "POST", "/connect", nil, nil, &h.meta)
	return e
}

func (h *keptTextHost) sync(ctx context.Context) error {
	var read keptTextRead
	headers := http.Header{}
	if h.etag != "" {
		headers.Set("If-None-Match", h.etag)
	}
	action := "?after=" + strconv.FormatUint(h.after, 10)
	if _, e := keptTextRequest(ctx, h.client, &h.state, h.room, "GET", action, nil, headers, &read); e != nil {
		return e
	}
	if read.KeepUntil > 0 {
		h.meta.Until = read.KeepUntil
	}
	before := h.skipped
	if e := h.applyRead(read); e != nil {
		return e
	}
	h.etag = read.ETag
	if h.skipped != before && h.onSkipped != nil {
		h.onSkipped(h.skipped)
	}
	if (read.Unchanged || len(read.Entries) == 0) && h.unchanged() {
		h.after = read.Tail
		return nil
	}
	frame, e := h.snapshot()
	if e != nil {
		return e
	}
	for i := range h.state.Files {
		file := &h.state.Files[i]
		doc := h.files[file.ID].doc
		next := doc.GetText("content").ToString()
		if !utf8.ValidString(next) {
			return errors.New("invalid kept UTF-8 text")
		}
		file.State, file.Pending = crdt.EncodeStateAsUpdateV1(doc, nil), &next
	}
	if e := saveKeptState(h.path, h.state); e != nil {
		return e
	}
	if e := h.finishWrites(); e != nil {
		return e
	}
	_, e = keptTextRequest(ctx, h.client, &h.state, h.room, "POST", "/checkpoint", frame, http.Header{"X-Pedit-Cutoff": {strconv.FormatUint(read.Tail, 10)}}, &h.meta)
	if e == nil {
		h.after = read.Tail
		h.snapshotNames = map[uint32]string{}
		for _, file := range h.state.Files {
			h.snapshotNames[file.ID] = file.Path
		}
	}
	return e
}

func (h *keptTextHost) applyRead(read keptTextRead) error {
	if len(read.Entries) > 10000 || read.Cutoff > read.Tail || read.Tail < h.after {
		return errors.New("invalid kept log bounds")
	}
	if read.Unchanged {
		if read.Tail != h.after || read.Cutoff > h.after {
			return errors.New("invalid unchanged kept cursor")
		}
		return nil
	}
	previous := h.after
	if len(read.Snapshot) > 0 {
		if e := h.applySnapshot(read.Snapshot); e != nil {
			return e
		}
		previous = max(previous, read.Cutoff)
	} else if h.after == 0 || read.Cutoff > h.after {
		return errors.New("missing kept snapshot")
	}
	return h.applyEntries(read, previous)
}
func (h *keptTextHost) applyEntries(read keptTextRead, previous uint64) error {
	base := map[uint32][]byte{}
	accepted := map[uint32][][]byte{}
	for id, file := range h.files {
		base[id] = crdt.EncodeStateAsUpdateV1(file.doc, nil)
	}
	for _, entry := range read.Entries {
		if entry.ID <= previous || entry.ID > read.Tail {
			return errors.New("invalid kept log order")
		}
		previous = entry.ID
		id, update, e := protocol.OpenKeptFileUpdate(h.keys, entry.Body)
		file := h.files[id]
		if e != nil || file == nil {
			h.skipped++
			continue
		}
		if e := file.applyUpdate(update); e != nil {
			h.skipped++
		} else {
			accepted[id] = append(accepted[id], update)
		}
	}
	if previous != read.Tail {
		return errors.New("incomplete kept log")
	}
	for id, file := range h.files {
		skipped, e := file.pruneIncomplete(base[id], accepted[id])
		h.skipped += skipped
		if e != nil {
			return e
		}
	}
	return nil
}
func (h *keptTextHost) applySnapshot(frame []byte) error {
	files, e := protocol.OpenKeptBundle(h.keys, frame)
	if e != nil {
		return e
	}
	if len(files) != len(h.state.Files) {
		return errors.New("kept snapshot file inventory differs")
	}
	names := map[uint32]string{}
	for i, file := range files {
		local := h.state.Files[i]
		if file.ID != local.ID || (len(files) > 1 && file.Path != local.Path) {
			return errors.New("kept snapshot file inventory differs")
		}
		target := h.files[file.ID]
		if e := target.applyUpdate(file.Update); e != nil {
			return e
		}
		if !completeKeptText(target.doc) {
			return errors.New("incomplete kept snapshot")
		}
		names[file.ID] = file.Path
	}
	h.snapshotNames = names
	return nil
}

func (h *keptTextDocument) applyUpdate(update []byte) error {
	candidate := crdt.New(crdt.WithGC(false))
	e := crdt.ApplyUpdateV1(candidate, crdt.EncodeStateAsUpdateV1(h.doc, nil), nil)
	if e == nil {
		e = applyKeptText(candidate, update)
	}
	if e != nil {
		candidate.Destroy()
		return e
	}
	h.doc.Destroy()
	h.doc = candidate
	return nil
}

func (h *keptTextDocument) pruneIncomplete(base []byte, accepted [][]byte) (int, error) {
	skipped := 0
	for !completeKeptText(h.doc) {
		projection, e := crdt.EncodeStateFromSnapshot(h.doc, crdt.CaptureSnapshot(h.doc))
		if e != nil {
			return skipped, errors.New("cannot inspect incomplete kept updates")
		}
		complete := make([][]byte, 0, len(accepted))
		for _, frame := range accepted {
			if h.frameIntegrated(projection, frame) {
				complete = append(complete, frame)
			}
		}
		if len(complete) == len(accepted) {
			complete = nil
		}
		skipped += len(accepted) - len(complete)
		accepted = complete
		h.doc.Destroy()
		h.doc = crdt.New(crdt.WithGC(false))
		if e := applyKeptText(h.doc, base); e != nil {
			return skipped, e
		}
		for _, frame := range accepted {
			if e := h.applyUpdate(frame); e != nil {
				return skipped, e
			}
		}
	}
	return skipped, nil
}
func (h *keptTextDocument) frameIntegrated(projection, frame []byte) bool {
	candidate := crdt.New()
	defer candidate.Destroy()
	return crdt.ApplyUpdateV1(candidate, projection, nil) == nil &&
		applyKeptText(candidate, frame) == nil && completeKeptText(candidate)
}

func applyKeptText(doc *crdt.Doc, update []byte) (err error) {
	defer func() {
		if recover() != nil {
			err = errors.New("invalid kept document update")
		}
	}()
	if len(update) == 0 || len(update) > protocol.MaxFrameBytes ||
		protocol.ValidateKeptTextUpdate(update) != nil || crdt.ApplyUpdateV1(doc, update, nil) != nil {
		return errors.New("invalid kept document update")
	}

	return nil
}

func completeKeptText(doc *crdt.Doc) bool {
	pending := doc.PendingStats()
	return pending.Items == 0 && pending.DeleteRanges == 0
}

func keptTextRequest(ctx context.Context, client *http.Client, s *keptTextState, room, method, action string, body []byte, headers http.Header, result any) (int, error) {
	req, e := http.NewRequestWithContext(ctx, method, s.Origin+"/api/rooms/"+room+"/keep"+action, bytes.NewReader(body))
	if e != nil {
		return 0, errors.New("invalid kept request")
	}
	req.Header = headers.Clone()
	if req.Header == nil {
		req.Header = make(http.Header)
	}
	req.Header.Set("Authorization", "Bearer "+s.HostToken)
	response, e := client.Do(req)
	if e != nil {
		return 0, errors.New("kept request failed")
	}
	defer response.Body.Close()
	if read, ok := result.(*keptTextRead); ok {
		read.ETag = response.Header.Get("ETag")
		if response.StatusCode == http.StatusNotModified {
			return response.StatusCode, readKeptUnchanged(response, req.Header.Get("If-None-Match"), read)
		}
	}
	if response.StatusCode == http.StatusGone {
		return response.StatusCode, errors.New("kept room expired")
	}
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return response.StatusCode, fmt.Errorf("kept request refused (HTTP %d)", response.StatusCode)
	}
	raw, e := io.ReadAll(io.LimitReader(response.Body, 8*protocol.MaxFrameBytes+1))
	if e != nil || len(raw) > 8*protocol.MaxFrameBytes || json.Unmarshal(raw, result) != nil {
		return response.StatusCode, errors.New("invalid kept response")
	}
	return response.StatusCode, nil
}

func readKeptUnchanged(response *http.Response, etag string, read *keptTextRead) error {
	cutoff, e1 := strconv.ParseUint(response.Header.Get("X-Pedit-Cutoff"), 10, 64)
	tail, e2 := strconv.ParseUint(response.Header.Get("X-Pedit-Tail"), 10, 64)
	until, e3 := strconv.ParseInt(response.Header.Get("X-Pedit-Keep-Until"), 10, 64)
	away := response.Header.Get("X-Pedit-Host-Away")
	if etag == "" || read.ETag != etag || e1 != nil || e2 != nil || e3 != nil ||
		cutoff > tail || until <= 0 || (away != "true" && away != "false") {
		return errors.New("invalid unchanged kept metadata")
	}
	read.Cutoff, read.Tail, read.KeepUntil, read.HostAway, read.Unchanged = cutoff, tail, until, away == "true", true
	return nil
}

func keptTextDirectory(project string) (string, error) {
	config, e := os.UserConfigDir()
	if e != nil {
		return "", errors.New("cannot locate kept host state directory")
	}
	digest := sha256.Sum256([]byte(project))
	directory := filepath.Join(config, "pedit", "keep", fmt.Sprintf("%x", digest[:])[:16])
	if e := os.MkdirAll(directory, 0700); e != nil {
		return "", errors.New("cannot create kept host state directory")
	}
	return directory, nil
}
func refuseLegacyKeptState(project string) error {
	directory := filepath.Join(project, ".pedit")
	entries, e := os.ReadDir(directory)
	if os.IsNotExist(e) {
		return nil
	}
	if e != nil {
		return errors.New("cannot inspect legacy kept state directory")
	}
	for _, entry := range entries {
		name := entry.Name()
		if strings.HasSuffix(name, ".keep.json") {
			return fmt.Errorf("%s contains the room key; move it out of the project before continuing", filepath.Join(directory, name))
		}
	}
	return nil
}

func readKeptState(path string, s *keptTextState) error {
	before, e := os.Lstat(path)
	if e != nil || !before.Mode().IsRegular() || before.Mode().Perm() != 0600 {
		return errors.New("kept host state must be a private mode 0600 file")
	}
	f, e := os.Open(path)
	if e != nil {
		return errors.New("cannot open kept host state")
	}
	defer f.Close()
	info, e := f.Stat()
	if e != nil || !os.SameFile(before, info) {
		return errors.New("kept host state changed")
	}
	raw, e := io.ReadAll(io.LimitReader(f, 8*protocol.MaxFrameBytes+1))
	saved := struct {
		*keptTextState
		File    string
		State   []byte
		Text    string
		Pending *string
	}{keptTextState: s}
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	if e != nil || len(raw) > 8*protocol.MaxFrameBytes || decoder.Decode(&saved) != nil || decoder.Decode(new(any)) != io.EOF {
		return errors.New("invalid kept host state")
	}
	if len(s.Files) == 0 && saved.File != "" {
		s.Files = []keptTextFileState{{ID: 0, Path: filepath.Base(saved.File), File: saved.File, State: saved.State, Text: saved.Text, Pending: saved.Pending}}
	}
	return nil
}

func saveKeptState(path string, s keptTextState) error {
	raw, e := json.Marshal(s)
	if e != nil || len(raw) > 8*protocol.MaxFrameBytes {
		return errors.New("kept host state exceeded limit")
	}
	tmp, e := os.CreateTemp(filepath.Dir(path), ".keep-*")
	if e != nil {
		return errors.New("cannot prepare kept host state")
	}
	defer os.Remove(tmp.Name())
	if _, e = tmp.Write(raw); e == nil {
		e = tmp.Sync()
	}
	e = errors.Join(e, tmp.Close())
	if e == nil {
		e = os.Rename(tmp.Name(), path)
	}
	if e == nil {
		e = syncKeptDirectory(filepath.Dir(path))
	}
	if e != nil {
		return errors.New("cannot save kept host state")
	}
	return nil
}

func finishKeptWrite(s *keptTextFileState, bound *filewriter.BoundFile) error {
	text, ok := bound.Read()
	if !ok || (text != s.Text && (s.Pending == nil || text != *s.Pending)) {
		return errors.New("kept file changed outside pedit; original preserved")
	}
	if s.Pending == nil {
		return nil
	}
	if text != *s.Pending {
		if e := bound.Write(s.Text, *s.Pending); e != nil {
			return errors.New("kept file changed or could not be saved")
		}
	}

	if e := bound.Sync(); e != nil {
		return errors.New("kept file save uncertain")
	}
	if current, ok := bound.Read(); !ok || current != *s.Pending {
		return errors.New("kept file save uncertain")
	}

	s.Text = *s.Pending
	s.Pending = nil
	return nil
}
func syncKeptDirectory(path string) error {
	dir, e := os.Open(path)
	if e != nil {
		return e
	}
	defer dir.Close()
	return dir.Sync()
}
