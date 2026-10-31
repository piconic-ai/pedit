package session

import (
	"bytes"
	"cmp"
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
	"sort"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/piconic-ai/pedit/internal/filewriter"
	"github.com/piconic-ai/pedit/internal/merge"
	"github.com/piconic-ai/pedit/internal/meta"
	"github.com/piconic-ai/pedit/internal/protocol"
	"github.com/reearth/ygo/crdt"
)

// KeptTextOptions says which kept room CloseKept, or the resume of a session,
// is about.
type KeptTextOptions struct {
	File, Project, Resume string
	OnSkipped             func(int)
	// OnImageError reports an image a kept text refers to that could not be
	// saved beside its file (once per image and file).
	OnImageError func(path string, err error)
	// Dial connects to the relay, to take in a live room (kept_away_resume.go).
	Dial protocol.Dialer
}
type keptTextState struct {
	Project, Origin, Fragment, HostToken string
	Keep, Until                          int64 // Until: relay deadline in Unix ms; 0 if unknown
	Files                                []keptTextFileState
	Initialized                          bool
	// Socket marks the record of a live room kept by the relay while the host
	// is away (kept_away.go); a record without it is of the older kind of kept
	// room, which was taken in by polling over HTTP and can no longer be
	// resumed. After is the last entry of the relay's log this host took in.
	Socket bool   `json:",omitempty"`
	After  uint64 `json:",omitempty"`
}
type keptTextFileState struct {
	ID         uint32
	Path, File string
	State      []byte
	Text       string
	Pending    *string `json:",omitempty"`
	// Meta is the comments doc paired with the file, if its comments can be kept.
	Meta *keptMetaState `json:",omitempty"`
}
type keptTextDocument struct {
	doc   *crdt.Doc
	bound *filewriter.BoundFile
	// root is the doc's one root type: "content" (or unset) for a text file,
	// protocol.KeptCommentsRoot for the comments doc paired with one.
	root string
	// tracker follows the anchors of the comments paired with a text file
	// through every change to its text, so a position whose character a guest
	// deletes is still placed; paired is the comments doc's text file.
	tracker *meta.Tracker
	paired  *keptTextDocument
	// comments is the text file's comments doc.
	comments *keptTextDocument
}

// keptTextEntry is an entry of the relay's log.
type keptTextEntry struct {
	ID   uint64
	Body []byte
}

// keptTextRead is what the relay replays to a returning host: a snapshot if
// the host holds less than the cutoff, the entries after it, and the tail.
type keptTextRead struct {
	Snapshot []byte
	Entries  []keptTextEntry
	Tail     uint64
	Cutoff   uint64
}

var keptTextRoomID = regexp.MustCompile(`^[A-Za-z0-9_-]{22}$`)

type keptTextHost struct {
	state      keptTextState
	room, path string
	dir        string
	client     *http.Client
	keys       *protocol.RoomKeys
	files      map[uint32]*keptTextDocument
	project    *os.Root // set while a file has comments
	after      uint64
	skipped    int
	onSkipped  func(int)
	// Images pasted while the host was away are saved before each write.
	blobKeys     *protocol.BlobKeys
	imageClient  *http.Client // nil for the default
	onImageError func(path string, err error)
	imageErrors  map[string]bool
	imagesFailed bool // some image could not be saved at the last try
}

// CloseKept takes in the edits of a room kept by the relay, writes them to the
// files, and ends the room, which removes its link and its record. Source
// changes made outside this session are refused rather than overwritten.
func CloseKept(ctx context.Context, opts KeptTextOptions) error {
	if runtime.GOOS == "windows" {
		return errors.New("--keep and --resume require Unix file permissions; Windows is not supported")
	}
	h, err := openAway(opts)
	if err != nil {
		return err
	}
	defer h.closeFiles()
	return h.closeAway(ctx, opts.Dial)
}

func (h *keptTextHost) prepare(opts KeptTextOptions) error {
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
	if e := h.resume(opts, directory); e != nil {
		return e
	}
	h.dir, h.path = directory, filepath.Join(directory, h.room+".json")
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
	byID := keptTextRoomID.MatchString(opts.Resume)
	if byID {
		h.room = opts.Resume
	} else {
		u, e := url.Parse(opts.Resume)
		if e != nil || u.User != nil || u.RawQuery != "" ||
			(u.Scheme != "http" && u.Scheme != "https") ||
			!strings.HasPrefix(u.Path, "/r/") {
			return errors.New("invalid resume link")
		}
		h.room = strings.TrimPrefix(u.Path, "/r/")
		if !keptTextRoomID.MatchString(h.room) {
			return errors.New("invalid resume room")
		}
	}
	if e := readKeptState(filepath.Join(directory, h.room+".json"), &h.state); e != nil {
		return e
	}
	link := h.state.Origin + "/r/" + h.room
	if !byID && opts.Resume != link+"#"+h.state.Fragment {
		return errors.New("resume link differs from saved host state")
	}
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
		if m := file.Meta; m != nil {
			doc := h.files[m.ID]
			if e := doc.apply(doc.doc, m.State); e != nil || !completeKeptText(doc.doc) {
				return errors.New("invalid saved kept comments")
			}
		}
	}
	h.followComments()
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
		// With a write pending, an edit may have been made before or after it
		// landed: the base is ambiguous, so finishWrites refuses the file.
		if file.Pending != nil {
			continue
		}
		onDisk, ok := h.files[file.ID].bound.Read()
		if !ok || onDisk == file.Text || !utf8.ValidString(onDisk) || len(onDisk) > protocol.MaxFrameBytes {
			continue
		}
		doc := h.files[file.ID].doc
		merge.ExternalEdit(doc, doc.GetText("content"), file.Text, onDisk, nil)
		file.State, file.Text, file.Pending = crdt.EncodeStateAsUpdateV1(doc, nil), onDisk, nil
		changed = true
	}
	if !changed {
		return nil
	}
	return saveKeptState(h.path, h.state)
}

// intake takes in what the relay sent: it applies the entries, writes the
// files with their comments and images, and returns the snapshot to checkpoint
// at read.Tail.
func (h *keptTextHost) intake(ctx context.Context, read keptTextRead) ([]byte, error) {
	before := h.skipped
	if e := h.applyRead(read); e != nil {
		return nil, e
	}
	if h.skipped != before && h.onSkipped != nil {
		h.onSkipped(h.skipped)
	}
	return h.persist(ctx)
}

// persist journals the documents as they are, saves the images they refer to
// and the files, and returns the snapshot to checkpoint.
func (h *keptTextHost) persist(ctx context.Context) ([]byte, error) {
	frame, e := h.snapshot()
	if e != nil {
		return nil, e
	}
	for i := range h.state.Files {
		file := &h.state.Files[i]
		doc := h.files[file.ID].doc
		next := doc.GetText("content").ToString()
		if !utf8.ValidString(next) {
			return nil, errors.New("invalid kept UTF-8 text")
		}
		file.State, file.Pending = crdt.EncodeStateAsUpdateV1(doc, nil), &next
		if e := h.syncMeta(file); e != nil {
			return nil, e
		}
	}
	if e := h.journalAndSaveImages(ctx); e != nil {
		return nil, e
	}
	return frame, h.finishWrites()
}

// checkpointed notes that the relay holds the state and drops its log up to tail.
func (h *keptTextHost) checkpointed(tail uint64) { h.after = tail }

func (h *keptTextHost) applyRead(read keptTextRead) error {
	if len(read.Entries) > 10000 || read.Cutoff > read.Tail || read.Tail < h.after {
		return errors.New("invalid kept log bounds")
	}
	previous := h.after
	if len(read.Snapshot) > 0 {
		if e := h.applySnapshot(read.Snapshot); e != nil {
			return e
		}
		previous = max(previous, read.Cutoff)
	} else if read.Cutoff > h.after {
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
	expected := h.entries()
	if len(files) != len(expected) {
		return errors.New("kept snapshot file inventory differs")
	}
	for i, file := range files {
		local := expected[i]
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
	}
	return nil
}

func (h *keptTextDocument) applyUpdate(update []byte) error {
	candidate := crdt.New(crdt.WithGC(false))
	var e error
	if h.root == protocol.KeptCommentsRoot {
		// Anyone with the edit key may log an update: every peer checks the
		// comments by the same rules.
		e = meta.CheckUpdate(h.doc, update)
	}
	if e == nil {
		e = crdt.ApplyUpdateV1(candidate, crdt.EncodeStateAsUpdateV1(h.doc, nil), nil)
	}
	if e == nil {
		e = h.apply(candidate, update)
	}
	if e != nil {
		candidate.Destroy()
		return e
	}
	if h.tracker != nil {
		// The doc stays, so its tracker sees the change.
		candidate.Destroy()
		return crdt.ApplyUpdateV1(h.doc, update, nil)
	}
	h.doc.Destroy()
	h.doc = candidate
	if h.paired != nil && h.paired.tracker != nil {
		h.paired.tracker.Learn(h.doc)
	}
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
		if e := h.rebuild(base, accepted); e != nil {
			return skipped, e
		}
	}
	return skipped, nil
}

// rebuild makes the doc again from base and the accepted updates. A doc whose
// anchors are followed gets a tracker of its own, from the base on.
func (h *keptTextDocument) rebuild(base []byte, accepted [][]byte) error {
	h.doc.Destroy()
	h.doc = crdt.New(crdt.WithGC(false))
	followed := h.tracker != nil
	if followed {
		h.tracker.Close()
		h.tracker = nil
	}
	if e := h.apply(h.doc, base); e != nil {
		return e
	}
	if followed {
		h.tracker = meta.NewTracker(h.doc)
		h.tracker.Learn(h.comments.doc)
	}
	for _, frame := range accepted {
		if e := h.applyUpdate(frame); e != nil {
			return e
		}
		if followed {
			h.tracker.Learn(h.comments.doc)
		}
	}
	return nil
}
func (h *keptTextDocument) frameIntegrated(projection, frame []byte) bool {
	candidate := crdt.New()
	defer candidate.Destroy()
	return crdt.ApplyUpdateV1(candidate, projection, nil) == nil &&
		h.apply(candidate, frame) == nil && completeKeptText(candidate)
}

func applyKeptText(doc *crdt.Doc, update []byte) error {
	return applyKeptDoc(doc, update, "content")
}

func (h *keptTextDocument) apply(doc *crdt.Doc, update []byte) error {
	return applyKeptDoc(doc, update, cmp.Or(h.root, "content"))
}

func applyKeptDoc(doc *crdt.Doc, update []byte, root string) (err error) {
	defer func() {
		if recover() != nil {
			err = errors.New("invalid kept document update")
		}
	}()
	if len(update) == 0 || len(update) > protocol.MaxFrameBytes ||
		protocol.ValidateKeptDocUpdate(update, root) != nil || crdt.ApplyUpdateV1(doc, update, nil) != nil {
		return errors.New("invalid kept document update")
	}

	return nil
}

func completeKeptText(doc *crdt.Doc) bool {
	pending := doc.PendingStats()
	return pending.Items == 0 && pending.DeleteRanges == 0
}

// closeRequest asks the relay to end the room, naming the last entry of its
// log the host took in. It answers 409 when a guest edit has arrived since.
func closeRequest(ctx context.Context, client *http.Client, s *keptTextState, room string, tail uint64) (int, error) {
	req, e := http.NewRequestWithContext(ctx, "POST", s.Origin+"/api/rooms/"+room+"/keep/close", nil)
	if e != nil {
		return 0, errors.New("invalid kept request")
	}
	req.Header.Set("Authorization", "Bearer "+s.HostToken)
	req.Header.Set("X-Pedit-Tail", strconv.FormatUint(tail, 10))
	response, e := client.Do(req)
	if e != nil {
		return 0, errors.New("kept request failed")
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return response.StatusCode, fmt.Errorf("kept request refused (HTTP %d)", response.StatusCode)
	}
	return response.StatusCode, nil
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

func (s keptTextState) hasPending() bool {
	for _, file := range s.Files {
		if file.Pending != nil || (file.Meta != nil && file.Meta.Pending != nil) {
			return true
		}
	}
	return false
}

func (h *keptTextHost) nothingPending() bool { return !h.state.hasPending() }

// expiredGrace is how long after its deadline a room's record is kept, so a
// clock that runs a little fast does not lose one.
const expiredGrace = time.Hour

// PruneKept removes, without asking the relay, the records in project of rooms
// past their deadline (by more than expiredGrace) and of the older kind of kept
// room, which was taken in by polling and can no longer be resumed. A record
// with a write to finish stays. It tells notify how many it removed.
func PruneKept(project string, notify func(int)) error {
	project, e := filepath.Abs(project)
	if e != nil {
		return errors.New("invalid kept project")
	}
	directory, e := keptTextDirectory(filepath.Clean(project))
	if e != nil {
		return e
	}
	paths, _ := filepath.Glob(filepath.Join(directory, "*.json"))
	removed := 0
	for _, path := range paths {
		room := strings.TrimSuffix(filepath.Base(path), ".json")
		var s keptTextState
		if !keptTextRoomID.MatchString(room) || readKeptState(path, &s) != nil || s.hasPending() ||
			s.Socket && (s.Until <= 0 || s.Until >= time.Now().Add(-expiredGrace).UnixMilli()) {
			continue
		}
		if os.Remove(path) == nil {
			removed++
		}
	}
	if removed > 0 && notify != nil {
		notify(removed)
	}
	return nil
}

// KeptTextRecord summarizes a resume record of a project, without its secrets.
type KeptTextRecord struct {
	Room  string
	Paths []string // display paths of the shared files
	Files []string // their absolute paths on disk
	Until int64    // relay deadline in Unix ms; 0 if unknown
}

// ListKeptText returns the resume records of project, soonest deadline first.
// Records that cannot be parsed, and those of the older polling kind of kept
// room, are left out.
func ListKeptText(project string) ([]KeptTextRecord, error) {
	project, e := filepath.Abs(project)
	if e != nil {
		return nil, errors.New("invalid kept project")
	}
	directory, e := keptTextDirectory(filepath.Clean(project))
	if e != nil {
		return nil, e
	}
	paths, _ := filepath.Glob(filepath.Join(directory, "*.json"))
	var records []KeptTextRecord
	for _, path := range paths {
		room := strings.TrimSuffix(filepath.Base(path), ".json")
		var s keptTextState
		if !keptTextRoomID.MatchString(room) || readKeptState(path, &s) != nil || !s.Initialized || !s.Socket {
			continue
		}
		r := KeptTextRecord{Room: room, Until: s.Until}
		for _, f := range s.Files {
			r.Paths = append(r.Paths, f.Path)
			r.Files = append(r.Files, f.File)
		}
		records = append(records, r)
	}
	sort.SliceStable(records, func(i, j int) bool { return records[i].Until < records[j].Until })
	return records, nil
}
