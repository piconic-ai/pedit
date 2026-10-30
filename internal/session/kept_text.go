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
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/piconic-ai/pedit/internal/filewriter"
	"github.com/piconic-ai/pedit/internal/protocol"
	"github.com/reearth/ygo/crdt"
)

type KeptTextOptions struct {
	File, Project, Server, Resume string
	Keep                          time.Duration
}
type keptTextState struct {
	File, Origin, Fragment, HostToken string
	Keep                              int64
	State                             []byte
	Text                              string
	Pending                           *string `json:",omitempty"`
	Initialized                       bool
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
	Tail uint64 `json:"tail"`
}

var keptTextRoomID = regexp.MustCompile(`^[A-Za-z0-9_-]{22}$`)

type keptTextHost struct {
	state      keptTextState
	room, path string
	client     *http.Client
	keys       *protocol.RoomKeys
	bound      *filewriter.BoundFile
	doc        *crdt.Doc
	meta       keptTextMeta
}

// RunKeptText keeps the relay open when the host leaves. Source changes made
// outside this session are refused rather than overwritten.
func RunKeptText(ctx context.Context, opts KeptTextOptions, ready func(string, int64, int64), leave func(int64)) (runErr error) {
	h := keptTextHost{client: &http.Client{Timeout: 10 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}}
	if e := h.prepare(ctx, opts); e != nil {
		return e
	}
	bound, e := filewriter.OpenBound(h.state.File)
	if e != nil {
		return errors.New("cannot open kept file")
	}
	defer bound.Close()
	h.bound, h.doc = bound, crdt.New()
	defer h.doc.Destroy()
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
	directory := filepath.Join(project, ".pedit")
	if e := os.MkdirAll(directory, 0700); e != nil {
		return errors.New("cannot create kept state directory")
	}
	if opts.Resume != "" {
		e = h.resume(opts, directory)
	} else {
		e = h.create(ctx, opts)
	}
	if e != nil {
		return e
	}
	h.path = filepath.Join(directory, h.room+".keep.json")
	digest := sha256.Sum256([]byte(h.state.HostToken))
	if !filepath.IsAbs(h.state.File) || filepath.Clean(h.state.File) != h.state.File || h.state.Keep <= 0 || base64.RawURLEncoding.EncodeToString(digest[:])[:22] != h.room {
		return errors.New("invalid saved kept state")
	}
	if opts.File != "" {
		file, e := filepath.Abs(opts.File)
		if e != nil || file != h.state.File {
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
	if e != nil || u.User != nil || u.RawQuery != "keep=1" || (u.Scheme != "http" && u.Scheme != "https") || !strings.HasPrefix(u.Path, "/r/") {
		return errors.New("invalid resume link")
	}
	h.room = strings.TrimPrefix(u.Path, "/r/")
	if !keptTextRoomID.MatchString(h.room) {
		return errors.New("invalid resume room")
	}
	if e := readKeptState(filepath.Join(directory, h.room+".keep.json"), &h.state); e != nil {
		return e
	}
	if opts.Resume != h.state.Origin+"/r/"+h.room+"?keep=1#"+h.state.Fragment || (opts.Server != "" && strings.TrimRight(opts.Server, "/") != h.state.Origin) {
		return errors.New("resume link differs from saved host state")
	}
	return nil
}

func (h *keptTextHost) create(ctx context.Context, opts KeptTextOptions) error {
	if opts.Keep <= 0 || opts.Keep%time.Second != 0 {
		return errors.New("invalid keep duration")
	}
	origin, e := url.Parse(strings.TrimRight(opts.Server, "/"))
	if e != nil || origin.User != nil || origin.Host == "" || origin.Path != "" || origin.RawQuery != "" || origin.Fragment != "" || (origin.Scheme != "https" && origin.Scheme != "http") {
		return errors.New("invalid kept server")
	}
	file, e := filepath.Abs(opts.File)
	if e != nil {
		return errors.New("invalid kept file")
	}
	input, e := os.Open(file)
	if e != nil {
		return errors.New("cannot read kept file")
	}
	data, e := io.ReadAll(io.LimitReader(input, protocol.MaxFrameBytes+1))
	input.Close()
	if e != nil || isCanvas(file) || len(data) > protocol.MaxFrameBytes || !utf8.Valid(data) {
		return errors.New("cannot read kept UTF-8 file")
	}
	r, e := createRoom(ctx, h.client, origin.String(), nil)
	if e != nil || !keptTextRoomID.MatchString(r.ID) {
		return errors.New("could not create kept room")
	}
	h.room = r.ID
	doc := crdt.New()
	defer doc.Destroy()
	text := doc.GetText("content")
	doc.Transact(func(tx *crdt.Transaction) { text.Insert(tx, 0, string(data), nil) })
	h.state = keptTextState{File: file, Origin: origin.String(), Fragment: protocol.GenerateEditSecret(), HostToken: r.HostToken, Keep: int64(opts.Keep / time.Second), State: crdt.EncodeStateAsUpdateV1(doc, nil), Text: string(data)}
	return nil
}

func (h *keptTextHost) restore() error {
	expected := h.state.Text
	if h.state.Pending != nil {
		expected = *h.state.Pending
	}
	if e := applyKeptText(h.doc, h.state.State); e != nil || !completeKeptText(h.doc) || h.doc.GetText("content").ToString() != expected {
		return errors.New("invalid saved kept document")
	}
	if _, e := protocol.SealKeptText(h.keys, h.state.State); e != nil {
		return e
	}
	if e := finishKeptWrite(h.path, &h.state, h.bound); e != nil {
		return e
	}
	return saveKeptState(h.path, h.state)
}

func (h *keptTextHost) connect(ctx context.Context) error {
	if !h.state.Initialized {
		frame, e := protocol.SealKeptText(h.keys, h.state.State)
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
	if _, e := keptTextRequest(ctx, h.client, &h.state, h.room, "GET", "", nil, nil, &read); e != nil {
		return e
	}
	if e := h.applyRead(read); e != nil {
		return e
	}
	encoded := crdt.EncodeStateAsUpdateV1(h.doc, nil)
	if bytes.Equal(encoded, h.state.State) && len(read.Entries) == 0 {
		return nil
	}
	next := h.doc.GetText("content").ToString()
	if !utf8.ValidString(next) {
		return errors.New("invalid kept UTF-8 text")
	}
	frame, e := protocol.SealKeptText(h.keys, encoded)
	if e != nil {
		return e
	}
	h.state.State, h.state.Pending = encoded, &next
	if e := saveKeptState(h.path, h.state); e != nil {
		return e
	}
	if e := finishKeptWrite(h.path, &h.state, h.bound); e != nil {
		return e
	}
	_, e = keptTextRequest(ctx, h.client, &h.state, h.room, "POST", "/checkpoint", frame, http.Header{"X-Pedit-Cutoff": {strconv.FormatUint(read.Tail, 10)}}, &h.meta)
	return e
}

func (h *keptTextHost) applyRead(read keptTextRead) error {
	if len(read.Entries) > 1000 {
		return errors.New("kept log exceeded limit")
	}
	if e := h.applyFrame(read.Snapshot); e != nil {
		return e
	}
	var previous uint64
	for _, entry := range read.Entries {
		if entry.ID <= previous || entry.ID > read.Tail {
			return errors.New("invalid kept log order")
		}
		previous = entry.ID
		if e := h.applyFrame(entry.Body); e != nil {
			return e
		}
	}
	if len(read.Entries) > 0 && previous != read.Tail {
		return errors.New("incomplete kept log")
	}
	if !completeKeptText(h.doc) {
		return errors.New("incomplete kept document update")
	}
	return nil
}
func (h *keptTextHost) applyFrame(frame []byte) error {
	update, e := protocol.OpenKeptText(h.keys, frame)
	if e != nil {
		return e
	}
	return applyKeptText(h.doc, update)
}

func applyKeptText(doc *crdt.Doc, update []byte) (err error) {
	defer func() {
		if recover() != nil {
			err = errors.New("invalid kept document update")
		}
	}()
	if len(update) == 0 || len(update) > protocol.MaxFrameBytes || crdt.ApplyUpdateV1(doc, update, nil) != nil {
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
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	if e != nil || len(raw) > 8*protocol.MaxFrameBytes || decoder.Decode(s) != nil || decoder.Decode(new(any)) != io.EOF {
		return errors.New("invalid kept host state")
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

func finishKeptWrite(path string, s *keptTextState, bound *filewriter.BoundFile) error {
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
	f, e := os.OpenFile(s.File, os.O_RDWR, 0)
	if e != nil {
		return errors.New("cannot sync kept file")
	}
	e = errors.Join(f.Sync(), f.Close(), syncKeptDirectory(filepath.Dir(s.File)))
	if current, ok := bound.Read(); e != nil || !ok || current != *s.Pending {
		return errors.New("kept file save uncertain")
	}
	s.Text = *s.Pending
	s.Pending = nil
	return saveKeptState(path, *s)
}
func syncKeptDirectory(path string) error {
	dir, e := os.Open(path)
	if e != nil {
		return e
	}
	defer dir.Close()
	return dir.Sync()
}
