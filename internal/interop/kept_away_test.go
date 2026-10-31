package interop

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/piconic-ai/pedit/internal/protocol"
	"github.com/piconic-ai/pedit/internal/protocol/prototest"
	"github.com/reearth/ygo/crdt"
)

// awayGuest is a guest built from internal/protocol, speaking version 6 on a
// socket of its own to the real Worker.
type awayGuest struct {
	t    *testing.T
	conn protocol.Conn
	keys *protocol.RoomKeys
}

// textKind stands for a text message in next.
const textKind byte = 255

func dialAwayGuest(t *testing.T, relay, link, after string) *awayGuest {
	t.Helper()
	u, err := url.Parse(link)
	if err != nil {
		t.Fatal(err)
	}
	id := strings.TrimPrefix(u.Path, "/r/")
	secrets, err := protocol.ParseFragment(u.Fragment)
	if err != nil {
		t.Fatal(err)
	}
	keys, err := protocol.DeriveRoomKeys(secrets, id)
	if err != nil {
		t.Fatal(err)
	}
	header := protocol.HandshakeHeader(http.Header{}, keys, false)
	if after != "" {
		header.Set(protocol.AfterHeader, after)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	conn, err := protocol.DialWebSocket(ctx, "ws"+strings.TrimPrefix(relay, "http")+"/api/rooms/"+id+"/ws", header)
	if err != nil {
		t.Fatal(err)
	}
	if protocol.ConnVersion(conn) != 6 {
		t.Fatal("the relay did not speak version 6")
	}
	t.Cleanup(func() { _ = conn.Close() })
	return &awayGuest{t: t, conn: conn, keys: keys}
}

// next reads a message: its kind (textKind for a text) and payload.
func (g *awayGuest) next() (byte, []byte) {
	g.t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	data, err := g.conn.Read(ctx)
	var sig protocol.Signal
	if errors.As(err, &sig) {
		return textKind, []byte(sig)
	}
	if err != nil {
		g.t.Fatalf("guest read: %v", err)
	}
	kind, payload, _ := protocol.SplitKind(data)
	return kind, payload
}

// replay reads what a joining peer is sent: texts, then the snapshot (kind
// 5, if any), the entries (kind 4) and the tail (kind 6).
func (g *awayGuest) replay() (texts []string, snapshot []byte, ids []uint64, tail uint64) {
	g.t.Helper()
	for {
		kind, payload := g.next()
		switch kind {
		case textKind:
			texts = append(texts, string(payload))
		case protocol.KindReplay:
			snapshot = payload
		case protocol.KindLogged:
			id, _, ok := protocol.DecodeLogged(payload)
			if !ok {
				g.t.Fatal("invalid kind 4")
			}
			ids = append(ids, id)
		case protocol.KindLogEnd:
			tail, _ = protocol.DecodeLogEnd(payload)
			return
		}
	}
}

// waitFor reads until a text of the relay is text.
func (g *awayGuest) waitFor(text string) {
	g.t.Helper()
	for {
		if kind, payload := g.next(); kind == textKind && string(payload) == text {
			return
		}
	}
}

func (g *awayGuest) send(kind byte, payload []byte) {
	g.t.Helper()
	if err := g.conn.Write(context.Background(), protocol.WithKind(kind, payload)); err != nil {
		g.t.Fatal(err)
	}
}

func TestGoHostKeepsAWebSocketRoomWhileAway(t *testing.T) {
	for _, key := range []string{"GOMODCACHE", "GOCACHE"} {
		if os.Getenv(key) == "" {
			raw, e := exec.Command("go", "env", key).Output()
			if e != nil {
				t.Fatal(e)
			}
			t.Setenv(key, strings.TrimSpace(string(raw)))
		}
	}
	userConfig := t.TempDir()
	t.Setenv("XDG_CONFIG_HOME", userConfig)
	if runtime.GOOS == "darwin" {
		t.Setenv("HOME", userConfig)
	}
	protocolDir(t)
	relay := keptRelay(t)
	root, err := filepath.Abs("../..")
	if err != nil {
		t.Fatal(err)
	}
	binary := filepath.Join(t.TempDir(), "pedit")
	build := exec.Command("go", "build", "-o", binary, "./cmd/pedit")
	build.Dir = root
	if output, err := build.CombinedOutput(); err != nil {
		t.Fatalf("build CLI: %v\n%s", err, output)
	}
	project := t.TempDir()
	if err := os.Mkdir(filepath.Join(project, ".pedit"), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(project, ".pedit/config.yaml"), []byte("server: "+relay+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	file := filepath.Join(project, "notes.md")
	if err := os.WriteFile(file, []byte("notes\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	read := func() string {
		b, _ := os.ReadFile(file)
		return string(b)
	}

	host := keptCommand(t, project, binary, "--keep", "7d", "notes.md")
	link := host.link(t)
	// The test relay allows a minute.
	for i := 0; i < 30 && !strings.Contains(strings.Join(host.seen, "\n"), "capped keep time to 1m"); i++ {
		host.line(t)
	}
	if !strings.Contains(strings.Join(host.seen, "\n"), "capped keep time to 1m") {
		t.Fatalf("the clamped keep was not reported:\n%s", strings.Join(host.seen, "\n"))
	}
	// A guest that is in the room when the host leaves is told it is kept.
	early := dialAwayGuest(t, relay, link, "")
	if out := host.stop(t); !strings.Contains(out, "Room stays open until") || !strings.Contains(out, "pedit notes.md") {
		t.Fatalf("Ctrl+C did not say how long the room stays:\n%s", out)
	}
	var kept string
	for kept == "" {
		if kind, payload := early.next(); kind == textKind && strings.HasPrefix(string(payload), "kept ") {
			kept = string(payload)
		}
	}
	if until, ok := protocol.ParseKept(kept); !ok || until <= time.Now().UnixMilli() {
		t.Fatalf("relay said %q", kept)
	}

	// A guest joins while the host is away: the snapshot, no log yet.
	guest := dialAwayGuest(t, relay, link, "")
	texts, snapshot, ids, tail := guest.replay()
	if len(snapshot) == 0 || len(ids) != 0 || tail != 0 || len(texts) == 0 || !strings.HasPrefix(texts[0], "kept ") {
		t.Fatalf("join: texts %v, snapshot %d bytes, entries %v, tail %d", texts, len(snapshot), ids, tail)
	}
	files, err := protocol.OpenKeptBundle(guest.keys, snapshot)
	if err != nil || len(files) != 2 || files[0].Path != "notes.md" || files[1].Path != ".pedit/meta/notes.md.json" {
		t.Fatalf("snapshot: %v, %v", files, err)
	}
	doc := crdt.New()
	if err := crdt.ApplyUpdateV1(doc, files[0].Update, nil); err != nil {
		t.Fatal(err)
	}
	text := doc.GetText("content")
	// Two kind 1 entries; the relay logs them and sends each back as kind 4.
	insert := func(index int, s string) {
		before := doc.StateVector()
		doc.Transact(func(tx *crdt.Transaction) { text.Insert(tx, index, s, nil) })
		entry, err := protocol.SealKeptFileUpdate(guest.keys, 0, crdt.EncodeStateAsUpdateV1(doc, before))
		if err != nil {
			t.Fatal(err)
		}
		guest.send(protocol.KindEntry, entry)
	}
	insert(0, "first ")
	insert(len("first notes\n"), "second\n")
	for want := uint64(1); want <= 2; {
		if kind, payload := guest.next(); kind == protocol.KindLogged {
			if id, _, _ := protocol.DecodeLogged(payload); id != want {
				t.Fatalf("entry %d acknowledged as %d", want, id)
			}
			want++
		}
	}
	// Another connection that holds nothing is replayed the log.
	second := dialAwayGuest(t, relay, link, "0")
	_, _, ids, tail = second.replay()
	if len(ids) != 2 || ids[0] != 1 || ids[1] != 2 || tail != 2 {
		t.Fatalf("replay with after=0: entries %v, tail %d", ids, tail)
	}
	// And the host edited its file in its own editor meanwhile.
	if err := os.WriteFile(file, []byte("notes\nlocal\n"), 0o600); err != nil {
		t.Fatal(err)
	}

	resumed := keptCommand(t, project, binary, "--resume")
	resumed.link(t)
	prototest.WaitFor(t, 10*time.Second, func() bool {
		got := read()
		return strings.Contains(got, "first ") && strings.Contains(got, "second") && strings.Contains(got, "local")
	}, "the guests' and the host's edits in the file")
	roomURL, _ := url.Parse(link)
	prototest.WaitFor(t, 10*time.Second, func() bool {
		response, err := http.Get(relay + "/__test/kept/" + strings.TrimPrefix(roomURL.Path, "/r/"))
		if err != nil {
			return false
		}
		defer response.Body.Close()
		var state struct{ Entries int }
		return json.NewDecoder(response.Body).Decode(&state) == nil && state.Entries == 0
	}, "the relay's log to be cut after the host's checkpoint")
	// The host is live again: the guests are told, and a newcomer is not replayed a log.
	guest.waitFor(protocol.HostBack)
	early.waitFor(protocol.HostBack)
	resumed.stop(t)

	// --close takes in the log, leaves, and has the relay end the room.
	closer := keptCommand(t, project, binary, "--close")
	var closing []string
	for line := range closer.lines {
		closing = append(closing, line)
	}
	if err := closer.wait(); err != nil || !strings.Contains(strings.Join(closing, "\n"), "Closed the room") {
		t.Fatalf("--close: %v\n%s", err, strings.Join(closing, "\n"))
	}
	late := dialAwayGuest(t, relay, link, "")
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	for {
		_, err := late.conn.Read(ctx)
		var closed *protocol.CloseError
		if errors.As(err, &closed) {
			if closed.Code != protocol.RoomClosed {
				t.Fatalf("closed with %d", closed.Code)
			}
			break
		}
		var sig protocol.Signal
		if err != nil && !errors.As(err, &sig) {
			t.Fatalf("the ended room let a guest in: %v", err)
		}
	}
}
