package session

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"

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

// takeInRead takes in a replay as the resume does: the host applies it and
// writes its files, then the relay confirms the checkpoint it sends.
func takeInRead(t *testing.T, h *keptTextHost, read keptTextRead) []byte {
	t.Helper()
	frame, err := h.intake(context.Background(), read)
	if err != nil {
		t.Fatal(err)
	}
	h.checkpointed(read.Tail)
	return frame
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
				read.Entries = append(read.Entries, keptTextEntry{ID: uint64(i + 1), Body: frame})
			}
			h := keptTextHost{state: keptTextState{Origin: "https://example.test", Files: []keptTextFileState{{ID: 0, Path: filepath.Base(file), File: file, Text: "base", State: baseline}}}, path: filepath.Join(dir, "state.json"), room: "abcdefghijklmnopqrstuv", keys: keys, files: map[uint32]*keptTextDocument{0: {bound: bound, doc: doc}}}
			defer func() { h.files[0].doc.Destroy() }()
			var notices []int
			h.onSkipped = func(count int) { notices = append(notices, count) }
			frame, e := h.intake(context.Background(), read)
			if e != nil {
				t.Fatalf("single %s entry poisoned room: %v", kind, e)
			}
			// The checkpoint frame is only returned once the source is saved.
			if got, _ := os.ReadFile(file); frame == nil || string(got) != "base first second" {
				t.Fatalf("checkpoint frame preceded source save: %q", got)
			}
			h.checkpointed(read.Tail)
			if h.after != 3 {
				t.Fatalf("checkpoint stopped before skipped entry: %d", h.after)
			}
			if h.skipped != 1 || len(notices) != 1 || notices[0] != 1 {
				t.Fatal("missing cumulative skipped status")
			}
			takeInRead(t, &h, keptTextRead{Cutoff: 3, Tail: 3})
			if len(notices) != 1 {
				t.Fatal("a replay without new entries repeated skipped status")
			}
			takeInRead(t, &h, keptTextRead{Cutoff: 3, Tail: 4, Entries: []keptTextEntry{{ID: 4, Body: bad}}})
			if h.after != 4 || h.skipped != 2 || len(notices) != 2 || notices[1] != 2 {
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
	room, want, link := pruneRecord(t, project, "https://example.test", 1, 1, nil)
	h := keptTextHost{}
	if e := h.prepare(KeptTextOptions{Project: project, Resume: link}); e != nil {
		t.Fatal(e)
	}
	if h.path != want {
		t.Fatalf("credential file remains in project: %s", h.path)
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
	for _, resume := range []string{link, room} {
		if e := (&keptTextHost{}).prepare(KeptTextOptions{Project: project, Resume: resume}); e != nil {
			t.Fatalf("resume %q from user config: %v", resume, e)
		}
	}
	h.state.Project = filepath.Join(project, "different")
	if e := saveKeptState(want, h.state); e != nil {
		t.Fatal(e)
	}
	if e := (&keptTextHost{}).prepare(KeptTextOptions{Project: project, Resume: link}); e == nil {
		t.Fatal("accepted a different saved project")
	}
}
func TestKeptTextRefusesLegacySecretBeforeAnyState(t *testing.T) {
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
	e := (&keptTextHost{}).prepare(KeptTextOptions{Project: project, Resume: "https://example.test/r/" + room + "#" + protocol.GenerateEditSecret()})
	if e == nil || !strings.Contains(e.Error(), legacy) || !strings.Contains(e.Error(), "contains the room key") {
		t.Fatalf("legacy secret not identified: %v", e)
	}
	if _, e := os.Stat(keptTestStatePath(t, project, room)); !os.IsNotExist(e) {
		t.Fatal("legacy refusal created new credentials")
	}
}

type keepFixTransport func(*http.Request) (*http.Response, error)

func (f keepFixTransport) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }

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
		read.Entries = append(read.Entries, keptTextEntry{ID: uint64(i + 1), Body: frame})
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
		read.Entries = append(read.Entries, keptTextEntry{ID: uint64(i + 1), Body: frame})
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

// A relay may hold a snapshot from before the files were named; what the host
// checkpoints in its place names the file, encrypted.
func TestKeptTextCheckpointCarriesTheEncryptedBasename(t *testing.T) {
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
			h := keptTextHost{state: keptTextState{Origin: "https://example.test", Files: []keptTextFileState{{ID: 0, Path: filepath.Base(file), File: file, Text: "base", State: baseline}}}, path: filepath.Join(dir, "state.json"), room: "abcdefghijklmnopqrstuv", keys: keys, files: map[uint32]*keptTextDocument{0: {bound: bound, doc: crdt.New(crdt.WithGC(false))}}}
			defer func() { h.files[0].doc.Destroy() }()
			if err := applyKeptText(h.files[0].doc, baseline); err != nil {
				t.Fatal(err)
			}
			frame := takeInRead(t, &h, keptTextRead{Snapshot: legacy})
			name, raw, err := protocol.OpenKeptTextSnapshot(keys, frame)
			if err != nil || name != filepath.Base(file) || !bytes.Equal(raw, baseline) {
				t.Fatalf("checkpoint metadata: %q %v", name, err)
			}
			if bytes.Contains(frame, []byte(filepath.Base(file))) {
				t.Error("filename sent in plaintext")
			}
		})
	}
}

func finishTestKeptWrite(path string, state *keptTextState, bound *filewriter.BoundFile) error {
	h := keptTextHost{path: path, state: *state, files: map[uint32]*keptTextDocument{0: {bound: bound}}}
	err := h.finishWrites()
	*state = h.state
	return err
}
