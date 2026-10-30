package session

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/piconic-ai/pedit/internal/filewriter"
	"github.com/piconic-ai/pedit/internal/protocol"
	"github.com/reearth/ygo/crdt"
)

func isolateKeptUserConfig(t *testing.T) {
	t.Helper()
	dir := t.TempDir()
	t.Setenv("XDG_CONFIG_HOME", dir)
	if runtime.GOOS == "darwin" {
		t.Setenv("HOME", dir)
	}
}
func keptTestStatePath(t *testing.T, project, room string) string {
	t.Helper()
	config, e := os.UserConfigDir()
	if e != nil {
		t.Fatal(e)
	}
	project, e = filepath.Abs(project)
	if e != nil {
		t.Fatal(e)
	}
	digest := sha256.Sum256([]byte(filepath.Clean(project)))
	return filepath.Join(config, "pedit", "keep", hex.EncodeToString(digest[:])[:16], room+".json")
}
func keptFixFrames(t *testing.T) (*protocol.RoomKeys, []byte, []byte, []byte) {
	t.Helper()
	link, e := protocol.ParseFragment(protocol.GenerateEditSecret())
	if e != nil {
		t.Fatal(e)
	}
	keys, e := protocol.DeriveRoomKeys(link, "abcdefghijklmnopqrstuv")
	if e != nil {
		t.Fatal(e)
	}
	doc := crdt.New()
	defer doc.Destroy()
	text := doc.GetText("content")
	doc.Transact(func(tx *crdt.Transaction) { text.Insert(tx, 0, "base", nil) })
	baseline := crdt.EncodeStateAsUpdateV1(doc, nil)
	vector := doc.StateVector()
	doc.Transact(func(tx *crdt.Transaction) { text.Insert(tx, 4, " first", nil) })
	first := crdt.EncodeStateAsUpdateV1(doc, vector)
	vector = doc.StateVector()
	doc.Transact(func(tx *crdt.Transaction) { text.Insert(tx, 10, " second", nil) })
	return keys, baseline, first, crdt.EncodeStateAsUpdateV1(doc, vector)
}
func TestKeptTextSkipsInvalidEntryAndCheckpointsPastIt(t *testing.T) {
	for _, kind := range []string{"decrypt", "domain", "signature", "apply", "extra-root"} {
		t.Run(kind, func(t *testing.T) {
			keys, baseline, first, last := keptFixFrames(t)
			seal := func(update []byte) []byte {
				frame, e := protocol.SealKeptText(keys, update)
				if e != nil {
					t.Fatal(e)
				}
				return frame
			}
			bad := []byte{1}
			if kind == "extra-root" {
				extra := crdt.New()
				extraText := extra.GetText("unexpected")
				extra.Transact(func(tx *crdt.Transaction) { extraText.Insert(tx, 0, "poison", nil) })
				bad = seal(crdt.EncodeStateAsUpdateV1(extra, nil))
				extra.Destroy()
			}
			if kind == "apply" {
				bad = seal([]byte{1, 2, 3})
			}
			if kind == "domain" || kind == "signature" {
				message := append([]byte("pedit kept text v1\x00"), first...)
				signer := keys.Signer
				if kind == "domain" {
					message[0] ^= 1
				} else {
					signer = ed25519.NewKeyFromSeed(bytes.Repeat([]byte{99}, 32))
				}
				cipher, e := protocol.NewCipher(keys.FrameKey)
				if e != nil {
					t.Fatal(e)
				}
				bad = cipher.Encrypt(append(message, ed25519.Sign(signer, message)...))
			}
			dir := t.TempDir()
			file := filepath.Join(dir, "notes.md")
			if e := os.WriteFile(file, []byte("base"), 0600); e != nil {
				t.Fatal(e)
			}
			bound, e := filewriter.OpenBound(file)
			if e != nil {
				t.Fatal(e)
			}
			defer bound.Close()
			doc := crdt.New()
			if e := applyKeptText(doc, baseline); e != nil {
				t.Fatal(e)
			}
			read := keptTextRead{Snapshot: seal(baseline), Tail: 3}
			for i, frame := range [][]byte{seal(first), bad, seal(last)} {
				read.Entries = append(read.Entries, struct {
					ID   uint64 `json:"id"`
					Body []byte `json:"body"`
				}{uint64(i + 1), frame})
			}
			cutoff := uint64(0)
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.Method == http.MethodGet {
					json.NewEncoder(w).Encode(read)
					return
				}
				cutoff, _ = strconv.ParseUint(r.Header.Get("X-Pedit-Cutoff"), 10, 64)
				got, _ := os.ReadFile(file)
				if string(got) != "base first second" {
					t.Error("checkpoint preceded source save")
				}
				json.NewEncoder(w).Encode(map[string]int64{"keepSeconds": 60, "keepUntil": time.Now().Add(time.Minute).UnixMilli()})
			}))
			defer server.Close()
			h := keptTextHost{state: keptTextState{Origin: server.URL, Files: []keptTextFileState{{ID: 0, Path: filepath.Base(file), File: file, Text: "base", State: baseline}}}, path: filepath.Join(dir, "state.json"), room: "abcdefghijklmnopqrstuv", client: server.Client(), keys: keys, files: map[uint32]*keptTextDocument{0: {bound: bound, doc: doc}}}
			defer func() { h.files[0].doc.Destroy() }()
			var notices []int
			h.onSkipped = func(count int) { notices = append(notices, count) }
			if e := h.sync(context.Background()); e != nil {
				t.Fatalf("single %s entry poisoned room: %v", kind, e)
			}
			if cutoff != 3 {
				t.Fatalf("checkpoint stopped before skipped entry: %d", cutoff)
			}
			if h.skipped != 1 || len(notices) != 1 || notices[0] != 1 {
				t.Fatal("missing cumulative skipped status")
			}
			read.Snapshot = nil
			read.Entries = nil
			read.Cutoff = 3
			if e := h.sync(context.Background()); e != nil {
				t.Fatal(e)
			}
			if len(notices) != 1 {
				t.Fatal("unchanged poll repeated skipped status")
			}
			read.Tail = 4
			read.Entries = append(read.Entries, struct {
				ID   uint64 `json:"id"`
				Body []byte `json:"body"`
			}{4, bad})
			if e := h.sync(context.Background()); e != nil {
				t.Fatal(e)
			}
			if cutoff != 4 || h.skipped != 2 || len(notices) != 2 || notices[1] != 2 {
				t.Fatal("later invalid entry did not advance cumulative status and cutoff")
			}
			got, _ := os.ReadFile(file)
			if string(got) != "base first second" {
				t.Fatalf("valid edits lost: %q", got)
			}
		})
	}
}
func TestKeptTextStoresCredentialsOutsideProject(t *testing.T) {
	isolateKeptUserConfig(t)
	project := t.TempDir()
	file := filepath.Join(project, "notes.md")
	if e := os.WriteFile(file, []byte("base"), 0600); e != nil {
		t.Fatal(e)
	}
	token := base64.RawURLEncoding.EncodeToString(make([]byte, 32))
	digest := sha256.Sum256([]byte(token))
	room := base64.RawURLEncoding.EncodeToString(digest[:])[:22]
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		json.NewEncoder(w).Encode(map[string]string{"id": room, "hostToken": token})
	}))
	defer server.Close()
	h := keptTextHost{client: server.Client()}
	if e := h.prepare(context.Background(), KeptTextOptions{File: file, Project: project, Server: server.URL, Keep: time.Hour}); e != nil {
		t.Fatal(e)
	}
	want := keptTestStatePath(t, project, room)
	if h.path != want {
		t.Fatalf("credential file remains in project: %s", h.path)
	}
	h.files = map[uint32]*keptTextDocument{0: {doc: crdt.New()}}
	defer h.files[0].doc.Destroy()
	bound, e := filewriter.OpenBound(file)
	if e != nil {
		t.Fatal(e)
	}
	defer bound.Close()
	h.files[0].bound = bound
	if e := h.restore(); e != nil {
		t.Fatal(e)
	}
	info, e := os.Stat(want)
	if e != nil || info.Mode().Perm() != 0600 {
		t.Fatal("private resume record missing")
	}
	parent, e := os.Stat(filepath.Dir(want))
	if e != nil || parent.Mode().Perm() != 0700 {
		t.Fatal("resume directory must be0700")
	}
	if _, e := os.Stat(filepath.Join(project, ".pedit")); !os.IsNotExist(e) {
		t.Fatal("kept mode wrote under project")
	}
	var record map[string]any
	raw, e := os.ReadFile(want)
	if e != nil || json.Unmarshal(raw, &record) != nil || record["Project"] != project {
		t.Fatal("saved project binding missing")
	}
	resume := keptTextHost{client: server.Client()}
	if e := resume.prepare(context.Background(), KeptTextOptions{Project: project, Resume: h.state.Origin + "/r/" + room + "?keep=1#" + h.state.Fragment}); e != nil {
		t.Fatalf("resume from user config: %v", e)
	}
	h.state.Project = filepath.Join(project, "different")
	if e := saveKeptState(want, h.state); e != nil {
		t.Fatal(e)
	}
	if e := resume.prepare(context.Background(), KeptTextOptions{Project: project, Resume: h.state.Origin + "/r/" + room + "?keep=1#" + h.state.Fragment}); e == nil {
		t.Fatal("accepted a different saved project")
	}
}
func TestKeptTextRefusesLegacySecretBeforeNetworkOrNewState(t *testing.T) {
	isolateKeptUserConfig(t)
	project := t.TempDir()
	room := "abcdefghijklmnopqrstuv"
	legacy := filepath.Join(project, ".pedit", "another-room.keep.json")
	if e := os.Mkdir(filepath.Dir(legacy), 0700); e != nil {
		t.Fatal(e)
	}
	if e := os.WriteFile(legacy, []byte("legacy secret"), 0600); e != nil {
		t.Fatal(e)
	}
	calls := 0
	client := &http.Client{Transport: keepFixTransport(func(*http.Request) (*http.Response, error) { calls++; return nil, io.EOF })}
	h := keptTextHost{client: client}
	e := h.prepare(context.Background(), KeptTextOptions{Project: project, Resume: "https://example.test/r/" + room + "?keep=1#" + protocol.GenerateEditSecret()})
	if e == nil || !strings.Contains(e.Error(), legacy) || !strings.Contains(e.Error(), "contains the room key") {
		t.Fatalf("legacy secret not identified: %v", e)
	}
	if calls != 0 {
		t.Fatal("legacy resume reached network")
	}
	create := keptTextHost{client: client}
	if e := create.prepare(context.Background(), KeptTextOptions{Project: project, File: "missing.md", Server: "https://example.test", Keep: time.Hour}); e == nil || !strings.Contains(e.Error(), legacy) {
		t.Fatal("new keep ignored legacy room key")
	}
	if calls != 0 {
		t.Fatal("legacy refusal created network room")
	}
	if _, e := os.Stat(keptTestStatePath(t, project, room)); !os.IsNotExist(e) {
		t.Fatal("legacy refusal created new credentials")
	}
}

type keepFixTransport func(*http.Request) (*http.Response, error)

func (f keepFixTransport) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }

func TestKeptTextHostPollsFromLastTail(t *testing.T) {
	keys, baseline, first, _ := keptFixFrames(t)
	seal := func(raw []byte) []byte {
		frame, e := protocol.SealKeptText(keys, raw)
		if e != nil {
			t.Fatal(e)
		}
		return frame
	}
	dir := t.TempDir()
	file := filepath.Join(dir, "notes.md")
	if e := os.WriteFile(file, []byte("base"), 0600); e != nil {
		t.Fatal(e)
	}
	bound, e := filewriter.OpenBound(file)
	if e != nil {
		t.Fatal(e)
	}
	defer bound.Close()
	var queries, tags []string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			json.NewEncoder(w).Encode(map[string]int64{"keepSeconds": 60, "keepUntil": 1000000000000})
			return
		}
		queries = append(queries, r.URL.Query().Get("after"))
		tags = append(tags, r.Header.Get("If-None-Match"))
		w.Header().Set("ETag", `"snapshot-1"`)
		if len(queries) == 1 {
			json.NewEncoder(w).Encode(map[string]any{"snapshot": seal(baseline), "entries": []any{map[string]any{"id": 1, "body": seal(first)}}, "cutoff": 0, "tail": 1})
			return
		}
		json.NewEncoder(w).Encode(map[string]any{"entries": []any{}, "cutoff": 0, "tail": 1})
	}))
	defer server.Close()
	h := keptTextHost{state: keptTextState{Origin: server.URL, Files: []keptTextFileState{{ID: 0, Path: filepath.Base(file), File: file, Text: "base", State: baseline}}}, room: "abcdefghijklmnopqrstuv", path: filepath.Join(dir, "state.json"), client: server.Client(), keys: keys, files: map[uint32]*keptTextDocument{0: {bound: bound, doc: crdt.New()}}}
	defer func() { h.files[0].doc.Destroy() }()
	if e := applyKeptText(h.files[0].doc, baseline); e != nil {
		t.Fatal(e)
	}
	if e := h.sync(context.Background()); e != nil {
		t.Fatal(e)
	}
	if e := h.sync(context.Background()); e != nil {
		t.Fatalf("incremental poll without snapshot failed: %v", e)
	}
	if len(queries) != 2 || queries[0] != "0" || queries[1] != "1" || tags[1] != `"snapshot-1"` {
		t.Fatalf("polls redownloaded earlier log: after=%v tags=%v", queries, tags)
	}
}
func TestKeptTextAcceptsConditionalPollMetadata(t *testing.T) {
	client := &http.Client{Transport: keepFixTransport(func(r *http.Request) (*http.Response, error) {
		return &http.Response{StatusCode: 304, Body: io.NopCloser(strings.NewReader("")), Header: http.Header{"Etag": {`"snapshot-3"`}, "X-Pedit-Cutoff": {"2"}, "X-Pedit-Tail": {"3"}, "X-Pedit-Host-Away": {"true"}, "X-Pedit-Keep-Until": {"1000000000000"}}}, nil
	})}
	var read keptTextRead
	status, e := keptTextRequest(context.Background(), client, &keptTextState{Origin: "https://example.test"}, "abcdefghijklmnopqrstuv", "GET", "?after=3", nil, http.Header{"If-None-Match": {`"snapshot-3"`}}, &read)
	if e != nil || status != 304 {
		t.Fatalf("conditional status refused: %v", e)
	}
}

func TestKeptTextRetainsDependenciesAcrossSkippedEntry(t *testing.T) {
	keys, baseline, first, last := keptFixFrames(t)
	seal := func(raw []byte) []byte {
		frame, e := protocol.SealKeptText(keys, raw)
		if e != nil {
			t.Fatal(e)
		}
		return frame
	}
	h := keptTextHost{keys: keys, files: map[uint32]*keptTextDocument{0: {doc: crdt.New()}}, state: keptTextState{Files: []keptTextFileState{{ID: 0, Path: "notes.md"}}}}
	defer func() { h.files[0].doc.Destroy() }()
	read := keptTextRead{Snapshot: seal(baseline), Tail: 3}
	for i, frame := range [][]byte{seal(last), {1}, seal(first)} {
		read.Entries = append(read.Entries, struct {
			ID   uint64 `json:"id"`
			Body []byte `json:"body"`
		}{uint64(i + 1), frame})
	}
	if e := h.applyRead(read); e != nil {
		t.Fatal(e)
	}
	if h.files[0].doc.GetText("content").ToString() != "base first second" || h.skipped != 1 {
		t.Fatal("candidate clone lost pending dependency or counted valid out-of-order entry")
	}
}
func TestKeptTextInvalidSnapshotIsFatalAndIsolated(t *testing.T) {
	keys, baseline, _, _ := keptFixFrames(t)
	bad, e := protocol.SealKeptText(keys, []byte{1, 2, 3})
	if e != nil {
		t.Fatal(e)
	}
	h := keptTextHost{keys: keys, files: map[uint32]*keptTextDocument{0: {doc: crdt.New()}}, state: keptTextState{Files: []keptTextFileState{{ID: 0, Path: "notes.md"}}}}
	defer func() { h.files[0].doc.Destroy() }()
	if e := applyKeptText(h.files[0].doc, baseline); e != nil {
		t.Fatal(e)
	}
	if e := h.applyRead(keptTextRead{Snapshot: bad}); e == nil {
		t.Fatal("invalid snapshot was skipped")
	}
	if h.skipped != 0 || h.files[0].doc.GetText("content").ToString() != "base" {
		t.Fatal("invalid snapshot mutated live state")
	}
}
func TestKeptTextReloadsSnapshotWhenCutoffPassesCursor(t *testing.T) {
	keys, baseline, first, last := keptFixFrames(t)
	doc := crdt.New()
	defer doc.Destroy()
	if e := applyKeptText(doc, baseline); e != nil {
		t.Fatal(e)
	}
	for _, update := range [][]byte{first, last} {
		if e := applyKeptText(doc, update); e != nil {
			t.Fatal(e)
		}
	}
	snapshot, e := protocol.SealKeptText(keys, crdt.EncodeStateAsUpdateV1(doc, nil))
	if e != nil {
		t.Fatal(e)
	}
	h := keptTextHost{keys: keys, after: 1, files: map[uint32]*keptTextDocument{0: {doc: crdt.New()}}, state: keptTextState{Files: []keptTextFileState{{ID: 0, Path: "notes.md"}}}}
	defer func() { h.files[0].doc.Destroy() }()
	if e := applyKeptText(h.files[0].doc, baseline); e != nil {
		t.Fatal(e)
	}
	if e := h.applyRead(keptTextRead{Snapshot: snapshot, Cutoff: 3, Tail: 3}); e != nil {
		t.Fatal(e)
	}
	if h.files[0].doc.GetText("content").ToString() != "base first second" {
		t.Fatal("new snapshot did not fill compacted tail")
	}
	if e := h.applyRead(keptTextRead{Cutoff: 3, Tail: 3}); e == nil {
		t.Fatal("accepted compacted tail without required snapshot")
	}
}
func TestKeptTextRejectsMalformedConditionalMetadata(t *testing.T) {
	valid := http.Header{"Etag": {`"tag"`}, "X-Pedit-Cutoff": {"2"}, "X-Pedit-Tail": {"3"}, "X-Pedit-Host-Away": {"true"}, "X-Pedit-Keep-Until": {"1000000000000"}}
	for _, key := range []string{"ETag", "X-Pedit-Cutoff", "X-Pedit-Tail", "X-Pedit-Host-Away", "X-Pedit-Keep-Until"} {
		t.Run(key, func(t *testing.T) {
			headers := valid.Clone()
			headers.Del(key)
			client := &http.Client{Transport: keepFixTransport(func(*http.Request) (*http.Response, error) {
				return &http.Response{StatusCode: 304, Body: io.NopCloser(strings.NewReader("")), Header: headers}, nil
			})}
			var read keptTextRead
			if _, e := keptTextRequest(context.Background(), client, &keptTextState{Origin: "https://example.test"}, "abcdefghijklmnopqrstuv", "GET", "?after=3", nil, http.Header{"If-None-Match": {`"tag"`}}, &read); e == nil {
				t.Fatal("accepted missing conditional metadata")
			}
		})
	}
}

func TestKeptTextSkipsUnresolvableEntryAfterResolvingBatchDependencies(t *testing.T) {
	keys, baseline, first, last := keptFixFrames(t)
	orphan := crdt.New()
	defer orphan.Destroy()
	text := orphan.GetText("content")
	orphan.Transact(func(tx *crdt.Transaction) { text.Insert(tx, 0, "missing", nil) })
	vector := orphan.StateVector()
	orphan.Transact(func(tx *crdt.Transaction) { text.Insert(tx, 7, " dangling", nil) })
	dangling := crdt.EncodeStateAsUpdateV1(orphan, vector)
	seal := func(raw []byte) []byte {
		frame, e := protocol.SealKeptText(keys, raw)
		if e != nil {
			t.Fatal(e)
		}
		return frame
	}
	h := keptTextHost{keys: keys, files: map[uint32]*keptTextDocument{0: {doc: crdt.New()}}, state: keptTextState{Files: []keptTextFileState{{ID: 0, Path: "notes.md"}}}}
	defer func() { h.files[0].doc.Destroy() }()
	read := keptTextRead{Snapshot: seal(baseline), Tail: 3}
	for i, frame := range [][]byte{seal(last), seal(dangling), seal(first)} {
		read.Entries = append(read.Entries, struct {
			ID   uint64 `json:"id"`
			Body []byte `json:"body"`
		}{uint64(i + 1), frame})
	}
	if e := h.applyRead(read); e != nil {
		t.Fatalf("unresolved entry poisoned batch: %v", e)
	}
	if h.files[0].doc.GetText("content").ToString() != "base first second" || h.skipped != 1 || !completeKeptText(h.files[0].doc) {
		t.Fatal("lost valid out-of-order edits while skipping unresolvable entry")
	}
}

func TestKeptTextRejectsExtraRootSnapshot(t *testing.T) {
	keys, _, _, _ := keptFixFrames(t)
	doc := crdt.New()
	defer doc.Destroy()
	extraMap := doc.GetMap("extra")
	doc.Transact(func(tx *crdt.Transaction) { extraMap.Set(tx, "x", "poison") })
	frame, err := protocol.SealKeptText(keys, crdt.EncodeStateAsUpdateV1(doc, nil))
	if err != nil {
		t.Fatal(err)
	}
	h := keptTextHost{keys: keys, files: map[uint32]*keptTextDocument{0: {doc: crdt.New(crdt.WithGC(false))}}, state: keptTextState{Files: []keptTextFileState{{ID: 0, Path: "notes.md"}}}}
	defer func() { h.files[0].doc.Destroy() }()
	if err := h.applySnapshot(frame); err == nil {
		t.Fatal("extra root snapshot accepted")
	}
}

func TestKeptTextUpgradesLegacySnapshotFilenameOnce(t *testing.T) {
	for _, incomingName := range []string{"", "old-name.md"} {
		t.Run(incomingName, func(t *testing.T) {
			keys, baseline, _, _ := keptFixFrames(t)
			legacy, _ := protocol.SealKeptText(keys, baseline)
			if incomingName != "" {
				legacy, _ = protocol.SealKeptTextSnapshot(keys, incomingName, baseline)
			}
			dir := t.TempDir()
			file := filepath.Join(dir, "議事録.md")
			if err := os.WriteFile(file, []byte("base"), 0600); err != nil {
				t.Fatal(err)
			}
			bound, err := filewriter.OpenBound(file)
			if err != nil {
				t.Fatal(err)
			}
			defer bound.Close()
			checkpoints := 0
			client := &http.Client{Transport: keepFixTransport(func(r *http.Request) (*http.Response, error) {
				body := []byte(`{"keepSeconds":60,"keepUntil":1000000000000}`)
				if r.Method == http.MethodGet {
					body, _ = json.Marshal(map[string]any{"snapshot": legacy, "entries": []any{}, "tail": 0})
				} else {
					checkpoints++
					frame, _ := io.ReadAll(r.Body)
					name, raw, err := protocol.OpenKeptTextSnapshot(keys, frame)
					if err != nil || name != filepath.Base(file) || !bytes.Equal(raw, baseline) {
						t.Errorf("checkpoint metadata: %q %v", name, err)
					}
					if bytes.Contains(frame, []byte(filepath.Base(file))) {
						t.Error("filename sent in plaintext")
					}
					legacy = frame
				}
				return &http.Response{StatusCode: 200, Header: http.Header{}, Body: io.NopCloser(bytes.NewReader(body))}, nil
			})}
			h := keptTextHost{state: keptTextState{Origin: "https://example.test", Files: []keptTextFileState{{ID: 0, Path: filepath.Base(file), File: file, Text: "base", State: baseline}}}, path: filepath.Join(dir, "state.json"), room: "abcdefghijklmnopqrstuv", keys: keys, client: client, files: map[uint32]*keptTextDocument{0: {bound: bound, doc: crdt.New(crdt.WithGC(false))}}}
			defer func() { h.files[0].doc.Destroy() }()
			if err := applyKeptText(h.files[0].doc, baseline); err != nil {
				t.Fatal(err)
			}
			for range 2 {
				if err := h.sync(context.Background()); err != nil {
					t.Fatal(err)
				}
			}
			if checkpoints != 1 {
				t.Fatalf("legacy upgrade checkpoints=%d", checkpoints)
			}
		})
	}
}

func TestKeptTextInitializationIncludesEncryptedBasename(t *testing.T) {
	keys, baseline, _, _ := keptFixFrames(t)
	initialized := false
	h := keptTextHost{keys: keys, state: keptTextState{Origin: "https://example.test", Keep: 60, Files: []keptTextFileState{{ID: 0, Path: filepath.Base("/private/project/議事録.md"), File: "/private/project/議事録.md", State: baseline}}}, room: "abcdefghijklmnopqrstuv"}
	h.client = &http.Client{Transport: keepFixTransport(func(r *http.Request) (*http.Response, error) {
		if strings.HasSuffix(r.URL.Path, "/init") {
			initialized = true
			frame, _ := io.ReadAll(r.Body)
			name, raw, err := protocol.OpenKeptTextSnapshot(keys, frame)
			if err != nil || name != "議事録.md" || !bytes.Equal(raw, baseline) {
				t.Errorf("initial snapshot %q %v", name, err)
			}
			if strings.Contains(r.URL.String(), "議事録") || strings.Contains(r.Header.Get("X-Pedit-Filename"), "議事録") {
				t.Error("plaintext filename metadata")
			}
		}
		return &http.Response{StatusCode: 200, Header: http.Header{}, Body: io.NopCloser(strings.NewReader(`{"keepSeconds":60,"keepUntil":1000000000000}`))}, nil
	})}
	if err := h.connect(context.Background()); err != nil {
		t.Fatal(err)
	}
	if !initialized {
		t.Fatal("missing initialization")
	}
}

func finishTestKeptWrite(path string, state *keptTextState, bound *filewriter.BoundFile) error {
	h := keptTextHost{path: path, state: *state, files: map[uint32]*keptTextDocument{0: {bound: bound}}}
	err := h.finishWrites()
	*state = h.state
	return err
}
