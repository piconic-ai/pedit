package session

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/piconic-ai/pedit/internal/protocol"
	"github.com/piconic-ai/pedit/internal/protocol/prototest"
	"github.com/reearth/ygo/crdt"
)

// awayRoom is a relay speaking version 6 that records what the host sends,
// answers its checkpoints, and replays a log to a returning host.
type awayRoom struct {
	t       *testing.T
	server  *httptest.Server
	relay   *prototest.Scripted
	project string
	file    string
	token   string
	id      string

	mu   sync.Mutex
	msgs [][]byte
	// tail is what the relay answers to a checkpoint; replay is queued for
	// the next connection.
	tail   uint64
	replay [][]byte
	// onCheckpoint runs before the answer, to send what arrives meanwhile.
	onCheckpoint func(*prototest.ScriptConn)
	keep         string
}

func newAwayRoom(t *testing.T, content string) *awayRoom {
	t.Helper()
	isolateKeptUserConfig(t)
	a := &awayRoom{t: t, token: "host-token-for-an-away-room", relay: &prototest.Scripted{}, keep: "keep 60 0"}
	digest := sha256.Sum256([]byte(a.token))
	a.id = base64.RawURLEncoding.EncodeToString(digest[:])[:22]
	a.server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusCreated)
		_ = json.NewEncoder(w).Encode(map[string]string{"id": a.id, "hostToken": a.token})
	}))
	t.Cleanup(a.server.Close)
	a.project = t.TempDir()
	a.file = filepath.Join(a.project, "notes.md")
	if err := os.WriteFile(a.file, []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}
	a.relay.OnDial = func(c *prototest.ScriptConn) {
		a.mu.Lock()
		replay := a.replay
		a.replay = nil
		a.mu.Unlock()
		if c.Header.Get(protocol.KeepHeader) != "" && c.Subprotocol() == "pedit-v6" {
			c.Say(a.keep)
		}
		for _, m := range replay {
			c.Push(m)
		}
		go a.watch(c)
	}
	return a
}

// watch records what the host writes and answers its checkpoints.
func (a *awayRoom) watch(c *prototest.ScriptConn) {
	for m := range c.Sent {
		a.mu.Lock()
		a.msgs = append(a.msgs, m)
		tail, hook := a.tail, a.onCheckpoint
		a.mu.Unlock()
		if m[0] == protocol.KindCheckpoint {
			if hook != nil {
				hook(c)
			}
			c.Say(fmt.Sprintf("checkpoint %d %d", binary.BigEndian.Uint64(m[1:9]), tail))
		}
	}
}

func (a *awayRoom) options() Options {
	return Options{
		File: a.file, Project: a.project, Server: a.server.URL, WriteDelay: 10 * time.Millisecond,
		Dial: a.relay.Dial, OnError: func(err error) { a.t.Log("error:", err) },
	}
}

// script sets what the relay answers to a checkpoint and replays to the next connection.
func (a *awayRoom) script(tail uint64, replay ...[]byte) {
	a.mu.Lock()
	defer a.mu.Unlock()
	a.tail, a.replay = tail, replay
}

// sent lists the messages of a kind the host wrote.
func (a *awayRoom) sent(kind byte) [][]byte {
	a.mu.Lock()
	defer a.mu.Unlock()
	var out [][]byte
	for _, m := range a.msgs {
		if m[0] == kind {
			out = append(out, m[1:])
		}
	}
	return out
}

func (a *awayRoom) waitSent(kind byte, n int) {
	a.t.Helper()
	prototest.WaitFor(a.t, wait, func() bool { return len(a.sent(kind)) >= n }, fmt.Sprintf("%d messages of kind %d", n, kind))
}

func (a *awayRoom) record() keptTextState {
	a.t.Helper()
	var s keptTextState
	if err := readKeptState(keptTestStatePath(a.t, a.project, a.id), &s); err != nil {
		a.t.Fatal(err)
	}
	return s
}

// bundleText is the text of file 0 of a kind 2 or kind 5 payload.
func bundleText(t *testing.T, keys *protocol.RoomKeys, payload []byte) string {
	t.Helper()
	files, err := protocol.OpenKeptBundle(keys, payload)
	if err != nil {
		t.Fatal(err)
	}
	doc := crdt.New()
	defer doc.Destroy()
	if err := crdt.ApplyUpdateV1(doc, files[0].Update, nil); err != nil {
		t.Fatal(err)
	}
	return doc.GetText("content").ToString()
}

// guestDoc is a guest's copy of file 0 from a bundle, which makes entries.
type guestDoc struct {
	t    *testing.T
	keys *protocol.RoomKeys
	doc  *crdt.Doc
}

func newGuestDoc(t *testing.T, keys *protocol.RoomKeys, bundle []byte) *guestDoc {
	t.Helper()
	files, err := protocol.OpenKeptBundle(keys, bundle)
	if err != nil {
		t.Fatal(err)
	}
	doc := crdt.New()
	if err := crdt.ApplyUpdateV1(doc, files[0].Update, nil); err != nil {
		t.Fatal(err)
	}
	return &guestDoc{t, keys, doc}
}

// insert makes the entry of inserting s at index.
func (g *guestDoc) insert(index int, s string) []byte {
	g.t.Helper()
	before := g.doc.StateVector()
	text := g.doc.GetText("content")
	g.doc.Transact(func(tx *crdt.Transaction) { text.Insert(tx, index, s, nil) })
	entry, err := protocol.SealKeptFileUpdate(g.keys, 0, crdt.EncodeStateAsUpdateV1(g.doc, before))
	if err != nil {
		g.t.Fatal(err)
	}
	return entry
}

func readText(t *testing.T, path string) string {
	t.Helper()
	b, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}

func TestKeepAsksTheRelayAndSnapshotsRightAfterConnecting(t *testing.T) {
	a := newAwayRoom(t, "notes\n")
	var kept atomic.Int64
	opts := a.options()
	opts.Keep = 7 * 24 * time.Hour
	opts.OnKeep = func(seconds int64) { kept.Store(seconds) }
	s, err := Start(context.Background(), opts)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = s.Stop() })

	a.waitSent(protocol.KindSnapshot, 1)
	conn := a.relay.Conns()[0]
	if got := conn.Header.Get(protocol.KeepHeader); got != "604800" {
		t.Fatalf("%s = %q", protocol.KeepHeader, got)
	}
	if got := conn.Header.Get(protocol.AfterHeader); got != "0" {
		t.Fatalf("%s = %q", protocol.AfterHeader, got)
	}
	if !strings.Contains(conn.Header.Get("Sec-WebSocket-Protocol"), "pedit-v6, pedit-v5") {
		t.Fatalf("offered %q", conn.Header.Get("Sec-WebSocket-Protocol"))
	}
	// The relay clamps the keep, and the session says so.
	prototest.WaitFor(t, wait, func() bool { return kept.Load() == 60 }, "the clamped keep")
	if got := bundleText(t, s.Client.Keys(), a.sent(protocol.KindSnapshot)[0]); got != "notes\n" {
		t.Fatalf("snapshot holds %q", got)
	}
	// The record, which --resume reads.
	prototest.WaitFor(t, wait, func() bool { _, err := os.Stat(keptTestStatePath(t, a.project, a.id)); return err == nil }, "the record")
	rec := a.record()
	if !rec.Socket || !rec.Initialized || rec.Keep != 60 || rec.Origin != a.server.URL || rec.HostToken != a.token ||
		rec.Fragment == "" || len(rec.Files) != 1 || rec.Files[0].File != a.file || rec.Files[0].Path != "notes.md" || rec.Files[0].Text != "notes\n" {
		t.Fatalf("record = %+v", rec)
	}
	if strings.Contains(a.server.URL, rec.Fragment) {
		t.Fatal("the key went to the server")
	}
}

func TestSnapshotsAfter200EntriesAndEntriesAreTakenInLikeLiveUpdates(t *testing.T) {
	a := newAwayRoom(t, "notes\n")
	opts := a.options()
	opts.Keep = time.Hour
	s, err := Start(context.Background(), opts)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = s.Stop() })
	a.waitSent(protocol.KindSnapshot, 1)
	conn := a.relay.Conns()[0]
	guest := newGuestDoc(t, s.Client.Keys(), a.sent(protocol.KindSnapshot)[0])
	// A guest that has not heard that the host is here yet sends entries.
	for i := 0; i < 199; i++ {
		conn.Push(protocol.WithKind(protocol.KindEntry, guest.insert(0, "x")))
	}
	prototest.WaitFor(t, wait, func() bool { return readText(t, a.file) == strings.Repeat("x", 199)+"notes\n" }, "199 entries in the file")
	if n := len(a.sent(protocol.KindSnapshot)); n != 1 {
		t.Fatalf("%d snapshots after 199 entries", n)
	}
	conn.Push(protocol.WithKind(protocol.KindEntry, guest.insert(0, "y")))
	a.waitSent(protocol.KindSnapshot, 2)
	snapshots := a.sent(protocol.KindSnapshot)
	if got := bundleText(t, s.Client.Keys(), snapshots[len(snapshots)-1]); got != "y"+strings.Repeat("x", 199)+"notes\n" {
		t.Fatalf("snapshot holds %d bytes of text", len(got))
	}
}

func TestSnapshotsAfterAWhileWithChangesOnly(t *testing.T) {
	old := snapshotEvery
	snapshotEvery = 150 * time.Millisecond
	t.Cleanup(func() { snapshotEvery = old })
	a := newAwayRoom(t, "notes\n")
	opts := a.options()
	opts.Keep = time.Hour
	s, err := Start(context.Background(), opts)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = s.Stop() })
	a.waitSent(protocol.KindSnapshot, 1)
	time.Sleep(500 * time.Millisecond)
	if n := len(a.sent(protocol.KindSnapshot)); n != 1 {
		t.Fatalf("%d snapshots without changes", n)
	}
	guest := newGuestDoc(t, s.Client.Keys(), a.sent(protocol.KindSnapshot)[0])
	a.relay.Conns()[0].Push(protocol.WithKind(protocol.KindEntry, guest.insert(0, "late ")))
	a.waitSent(protocol.KindSnapshot, 2)
}

func TestInvalidEntriesAreSkippedAndCounted(t *testing.T) {
	a := newAwayRoom(t, "notes\n")
	var skipped atomic.Int64
	opts := a.options()
	opts.Keep = time.Hour
	opts.OnSkipped = func(n int) { skipped.Store(int64(n)) }
	s, err := Start(context.Background(), opts)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = s.Stop() })
	a.waitSent(protocol.KindSnapshot, 1)
	conn := a.relay.Conns()[0]
	conn.Push(protocol.WithKind(protocol.KindEntry, []byte("not an entry")))
	other, err := protocol.SealKeptFileUpdate(s.Client.Keys(), 7, []byte{0, 0})
	if err != nil {
		t.Fatal(err)
	}
	conn.Push(protocol.WithKind(protocol.KindEntry, other))
	prototest.WaitFor(t, wait, func() bool { return skipped.Load() == 2 }, "two skipped entries")
	if readText(t, a.file) != "notes\n" {
		t.Fatal("the file changed")
	}
}

func TestCtrlCSendsTheLastSnapshotAndLeavesWithHostLeft(t *testing.T) {
	a := newAwayRoom(t, "notes\n")
	opts := a.options()
	opts.Keep = time.Hour
	s, err := Start(context.Background(), opts)
	if err != nil {
		t.Fatal(err)
	}
	a.waitSent(protocol.KindSnapshot, 1)
	prototest.WaitFor(t, wait, func() bool { return !s.KeptUntil().IsZero() }, "the relay's word on the keep")
	conn := a.relay.Conns()[0]
	guest := newGuestDoc(t, s.Client.Keys(), a.sent(protocol.KindSnapshot)[0])
	conn.Push(protocol.WithKind(protocol.KindEntry, guest.insert(5, " by a guest")))
	prototest.WaitFor(t, wait, func() bool { return readText(t, a.file) == "notes by a guest\n" }, "the entry in the file")

	if err := s.Stop(); err != nil {
		t.Fatal(err)
	}
	snapshots := a.sent(protocol.KindSnapshot)
	if got := bundleText(t, s.Client.Keys(), snapshots[len(snapshots)-1]); got != "notes by a guest\n" {
		t.Fatalf("last snapshot holds %q", got)
	}
	if !conn.Left() {
		t.Fatal("the host did not leave on purpose")
	}
	rec := a.record()
	if rec.Files[0].Text != "notes by a guest\n" || rec.Files[0].Pending != nil || rec.Until <= time.Now().UnixMilli() {
		t.Fatalf("record = %+v", rec)
	}
	doc := crdt.New()
	if err := crdt.ApplyUpdateV1(doc, rec.Files[0].State, nil); err != nil || doc.GetText("content").ToString() != rec.Files[0].Text {
		t.Fatal("the record's state is not its text")
	}
	if s.KeptUntil().Before(time.Now()) {
		t.Fatal("KeptUntil is not in the future")
	}
}

func TestWithoutKeepTheSessionIsAsBefore(t *testing.T) {
	a := newAwayRoom(t, "notes\n")
	s, err := Start(context.Background(), a.options())
	if err != nil {
		t.Fatal(err)
	}
	prototest.WaitFor(t, wait, func() bool { return s.Client.Status() == protocol.StatusConnected }, "connected")
	conn := a.relay.Conns()[0]
	if conn.Header.Get(protocol.KeepHeader) != "" || conn.Header.Get(protocol.AfterHeader) != "" {
		t.Fatal("asked for a keep")
	}
	if err := s.Stop(); err != nil {
		t.Fatal(err)
	}
	for _, m := range a.sent(protocol.KindSnapshot) {
		t.Fatalf("sent a snapshot %d bytes long", len(m))
	}
	if !s.KeptUntil().IsZero() {
		t.Fatal("KeptUntil without a keep")
	}
	if _, err := os.Stat(keptTestStatePath(t, a.project, a.id)); err == nil {
		t.Fatal("wrote a record")
	}
	if !conn.Left() {
		t.Fatal("did not leave")
	}
}

func TestAVersion5RelayCannotKeepTheRoom(t *testing.T) {
	a := newAwayRoom(t, "notes\n")
	a.relay.Subprotocol = "pedit-v5"
	var kept atomic.Int64
	kept.Store(-1)
	opts := a.options()
	opts.Keep = time.Hour
	opts.OnKeep = func(seconds int64) { kept.Store(seconds) }
	s, err := Start(context.Background(), opts)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = s.Stop() })
	prototest.WaitFor(t, wait, func() bool { return kept.Load() == 0 }, "the news that the relay cannot keep")
	time.Sleep(100 * time.Millisecond)
	a.mu.Lock()
	msgs := append([][]byte{}, a.msgs...)
	a.mu.Unlock()
	for _, m := range msgs {
		if m[0] == protocol.KindSnapshot && len(m) > 100 {
			// A bare version 5 frame may start with any byte; it is no bundle.
			if _, err := protocol.OpenKeptBundle(s.Client.Keys(), m[1:]); err == nil {
				t.Fatal("sent a snapshot to a version 5 relay")
			}
		}
	}
	if err := s.Stop(); err != nil {
		t.Fatal(err)
	}
	if !s.KeptUntil().IsZero() {
		t.Fatal("KeptUntil with a version 5 relay")
	}
}

// keepAndLeave shares the file with a keep, lets a guest add an entry, and
// leaves. It returns the record's keys and the guest's doc.
func keepAndLeave(t *testing.T, a *awayRoom) (*protocol.RoomKeys, *guestDoc) {
	t.Helper()
	opts := a.options()
	opts.Keep = time.Hour
	s, err := Start(context.Background(), opts)
	if err != nil {
		t.Fatal(err)
	}
	a.waitSent(protocol.KindSnapshot, 1)
	prototest.WaitFor(t, wait, func() bool { return !s.KeptUntil().IsZero() }, "the keep")
	guest := newGuestDoc(t, s.Client.Keys(), a.sent(protocol.KindSnapshot)[0])
	keys := s.Client.Keys()
	if err := s.Stop(); err != nil {
		t.Fatal(err)
	}
	a.mu.Lock()
	a.msgs = nil
	a.mu.Unlock()
	return keys, guest
}

func TestResumeTakesInTheLogAfterMergingLocalEditsAndCheckpoints(t *testing.T) {
	a := newAwayRoom(t, "one\ntwo\n")
	keys, guest := keepAndLeave(t, a)
	// While the host was away a guest edited, and the host did in its editor.
	first := guest.insert(0, "guest ")
	second := guest.insert(0, "again ")
	if err := os.WriteFile(a.file, []byte("one\ntwo\nhost\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	invalid := []byte("not an entry")
	a.script(3, protocol.EncodeLogged(1, first), protocol.EncodeLogged(2, invalid), protocol.EncodeLogged(3, second), protocol.EncodeLogEnd(3))
	// An entry that arrives between the replay and the checkpoint.
	late := newGuestDoc(t, keys, mustSnapshot(t, a)) // a guest that holds the old state
	lateEntry := late.insert(8, "late\n")
	a.mu.Lock()
	a.onCheckpoint = func(c *prototest.ScriptConn) { c.Push(protocol.WithKind(protocol.KindEntry, lateEntry)) }
	a.mu.Unlock()

	var skipped atomic.Int64
	var kept atomic.Int64
	opts := a.options()
	opts.Resume = a.id
	opts.File, opts.Server = "", ""
	opts.OnSkipped = func(n int) { skipped.Store(int64(n)) }
	opts.OnKeep = func(seconds int64) { kept.Store(seconds) }
	s, err := Start(context.Background(), opts)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = s.Stop() })

	conns := a.relay.Conns()
	conn := conns[len(conns)-1]
	if got := conn.Header.Get(protocol.AfterHeader); got != "0" {
		t.Fatalf("resumed with %s %q", protocol.AfterHeader, got)
	}
	if got := conn.Header.Get("Authorization"); got != "Bearer "+a.token {
		t.Fatalf("Authorization = %q", got)
	}
	// Local and guest edits are both in the file, the invalid entry skipped.
	if got := readText(t, a.file); !strings.Contains(got, "again guest one\ntwo\nhost") {
		t.Fatalf("file = %q", got)
	}
	if skipped.Load() != 1 || kept.Load() != 60 {
		t.Fatalf("skipped %d, keep %d", skipped.Load(), kept.Load())
	}
	// The checkpoint names the last id taken in and holds the merged text.
	checkpoints := a.sent(protocol.KindCheckpoint)
	if len(checkpoints) != 1 || binary.BigEndian.Uint64(checkpoints[0]) != 3 {
		t.Fatalf("checkpoints = %d", len(checkpoints))
	}
	if got := bundleText(t, keys, checkpoints[0][8:]); got != "again guest one\ntwo\nhost\n" {
		t.Fatalf("checkpoint holds %q", got)
	}
	// The record: the log taken in, nothing pending.
	prototest.WaitFor(t, wait, func() bool { return a.record().After == 3 }, "the record to follow the checkpoint")
	rec := a.record()
	if rec.Files[0].Pending != nil || rec.Files[0].Text != "again guest one\ntwo\nhost\n" {
		t.Fatalf("record = %+v", rec.Files[0])
	}
	// The entry that came late reaches the file, and the host carries on live.
	prototest.WaitFor(t, wait, func() bool { return strings.Contains(readText(t, a.file), "late") }, "the late entry in the file")
	if len(conns) != 2 || s.Client.Status() != protocol.StatusConnected {
		t.Fatalf("%d connections, status %s", len(conns), s.Client.Status())
	}
	// A guest syncing with the live host gets one copy of the text, not two.
	if got := s.Text.ToString(); strings.Count(got, "one") != 1 {
		t.Fatalf("live text = %q", got)
	}
	// Ctrl+C again keeps the room again.
	if err := s.Stop(); err != nil {
		t.Fatal(err)
	}
	// The relay's keep (a minute), not the first one's hour.
	if until := a.record().Until; !conn.Left() || until <= time.Now().UnixMilli() || until > time.Now().Add(2*time.Minute).UnixMilli() {
		t.Fatal("the resumed host did not keep the room on leaving")
	}
}

func mustSnapshot(t *testing.T, a *awayRoom) []byte {
	t.Helper()
	rec := a.record()
	link, err := protocol.ParseFragment(rec.Fragment)
	if err != nil {
		t.Fatal(err)
	}
	keys, err := protocol.DeriveRoomKeys(link, a.id)
	if err != nil {
		t.Fatal(err)
	}
	var files []protocol.KeptFileSnapshot
	for _, e := range (&keptTextHost{state: rec}).entries() {
		files = append(files, protocol.KeptFileSnapshot{ID: e.ID, Path: e.Path, Update: e.State})
	}
	bundle, err := protocol.SealKeptBundle(keys, files)
	if err != nil {
		t.Fatal(err)
	}
	return bundle
}

func TestResumeRefusesARelayThatSpeaksVersion5(t *testing.T) {
	a := newAwayRoom(t, "notes\n")
	keepAndLeave(t, a)
	a.relay.Subprotocol = "pedit-v5"
	opts := a.options()
	opts.Resume = a.id
	if _, err := Start(context.Background(), opts); err == nil || !strings.Contains(err.Error(), "too old") {
		t.Fatalf("Start = %v", err)
	}
}
