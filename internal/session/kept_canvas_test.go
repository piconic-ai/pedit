package session

import (
	"bytes"
	"context"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"testing"

	"github.com/piconic-ai/pedit/internal/canvas"
	"github.com/piconic-ai/pedit/internal/meta"
	"github.com/piconic-ai/pedit/internal/protocol"
	"github.com/reearth/ygo/crdt"
)

func TestKeptCanvasReplaysBoardUpdates(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "board.canvas")
	initial := `{"nodes":[{"id":"a","type":"text","text":"hello","x":0,"y":0,"width":100,"height":100}],"edges":[],"custom":true}`
	if err := os.WriteFile(path, []byte(initial), 0600); err != nil {
		t.Fatal(err)
	}
	thread := keptCommentThread("hello", 0)
	thread.Anchor = meta.Anchor{Type: meta.AnchorNode, ID: "a"}
	sidecar, err := meta.Render(&meta.File{Path: "board.canvas", Comments: map[string]meta.Thread{"t1": thread}})
	if err != nil {
		t.Fatal(err)
	}
	metaPath := filepath.Join(dir, ".pedit", "meta", "board.canvas.json")
	if err := os.MkdirAll(filepath.Dir(metaPath), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(metaPath, sidecar, 0600); err != nil {
		t.Fatal(err)
	}
	files, err := prepareKeptFiles(dir, path)
	if err != nil {
		t.Fatal(err)
	}
	keys, _, _, _ := keptFixFrames(t)
	host := &keptTextHost{state: keptTextState{Project: dir, Files: files}, keys: keys, path: filepath.Join(t.TempDir(), "state.json"), room: "abcdefghijklmnopqrstuv"}
	if err := host.openFiles(); err != nil {
		t.Fatal(err)
	}
	defer host.closeFiles()
	if err := host.restore(); err != nil {
		t.Fatal(err)
	}
	guest := crdt.New()
	defer guest.Destroy()
	if err := crdt.ApplyUpdateV1(guest, files[0].State, nil); err != nil {
		t.Fatal(err)
	}
	vector := guest.StateVector()
	node := guest.GetArray(canvas.NodesKey).Get(0).(*crdt.YMap)
	text, _ := node.Get(canvas.TextKey)
	guest.Transact(func(tx *crdt.Transaction) {
		node.Set(tx, "x", float64(42))
		text.(*crdt.YText).Insert(tx, 5, " world", nil)
	})
	frame, err := protocol.SealKeptFileUpdate(keys, 0, crdt.EncodeStateAsUpdateV1(guest, vector))
	if err != nil {
		t.Fatal(err)
	}
	read := keptTextRead{Entries: []keptTextEntry{{ID: 1, Body: frame}, {ID: 2, Body: frame}}, Tail: 2}
	takeInRead(t, host, read)
	out, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	parsed, err := canvas.Parse(out)
	if err != nil {
		t.Fatal(err)
	}
	if len(parsed.Canvas.Nodes) != 1 || parsed.Canvas.Nodes[0]["text"] != "hello world" || parsed.Canvas.Nodes[0]["x"] != int64(42) || parsed.Canvas.Extra["custom"] != true {
		t.Fatalf("wrong canvas: %s", out)
	}
	if host.files[0].tracker != nil {
		t.Fatal("canvas acquired a text tracker")
	}
	savedComment, err := os.ReadFile(metaPath)
	if err != nil {
		t.Fatal(err)
	}
	comments, err := meta.Parse(savedComment)
	if err != nil || comments.Comments["t1"].Anchor.ID != "a" {
		t.Fatalf("lost canvas comment: %s (%v)", savedComment, err)
	}
	if err := host.restore(); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(initial), 0600); err != nil {
		t.Fatal(err)
	}
	if err := host.restore(); err == nil {
		t.Fatal("overwrote external canvas edit")
	}
	after, _ := os.ReadFile(path)
	if string(after) != initial {
		t.Fatal("external edit changed")
	}
}

func TestKeptCanvasResumeKeepsSharedIdentities(t *testing.T) {
	initial := `{"nodes":[{"id":"a","type":"text","text":"hello","x":0,"y":0,"width":100,"height":100}],"edges":[]}`
	original := crdt.New()
	defer original.Destroy()
	if _, err := newContent(original, "board.canvas", initial, nil); err != nil {
		t.Fatal(err)
	}
	saved := crdt.EncodeStateAsUpdateV1(original, nil)
	resumed := crdt.New()
	defer resumed.Destroy()
	if _, err := newContent(resumed, "board.canvas", initial, saved); err != nil {
		t.Fatal(err)
	}
	if err := crdt.ApplyUpdateV1(resumed, saved, nil); err != nil {
		t.Fatal(err)
	}
	if got := resumed.GetArray(canvas.NodesKey).Len(); got != 1 {
		t.Fatalf("resume duplicated nodes: %d", got)
	}
}

func TestKeptCanvasHostReturnsToGuestBoardEdits(t *testing.T) {
	initial := `{"nodes":[{"id":"a","type":"text","text":"hello","x":0,"y":0,"width":100,"height":100}],"edges":[]}`
	a := newAwayRoom(t, initial)
	a.file = filepath.Join(a.project, "board.canvas")
	if err := os.WriteFile(a.file, []byte(initial), 0600); err != nil {
		t.Fatal(err)
	}
	_, guest := keepAndLeave(t, a)
	defer guest.doc.Destroy()
	vector := guest.doc.StateVector()
	nodes := guest.doc.GetArray(canvas.NodesKey)
	node := nodes.Get(0).(*crdt.YMap)
	text, _ := node.Get(canvas.TextKey)
	guest.doc.Transact(func(tx *crdt.Transaction) {
		node.Set(tx, "x", int64(42))
		text.(*crdt.YText).Insert(tx, 5, " world", nil)
		added := crdt.NewMapPrelim()
		for k, v := range map[string]any{"id": "b", "type": "text", "text": "new", "x": int64(100), "y": int64(0), "width": int64(100), "height": int64(100)} {
			added.Set(tx, k, v)
		}
		nodes.PushType(tx, added)
	})
	entry, err := protocol.SealKeptFileUpdate(guest.keys, 0, crdt.EncodeStateAsUpdateV1(guest.doc, vector))
	if err != nil {
		t.Fatal(err)
	}
	a.script(2, protocol.EncodeLogged(1, entry), protocol.EncodeLogged(2, entry), protocol.EncodeLogEnd(2))
	opts := a.options()
	opts.Resume = a.id
	opts.File, opts.Server = "", ""
	resumed, err := Start(context.Background(), opts)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = resumed.Stop() })
	out := readText(t, a.file)
	parsed, err := canvas.Parse([]byte(out))
	if err != nil {
		t.Fatal(err)
	}
	if len(parsed.Canvas.Nodes) != 2 || parsed.Canvas.Nodes[0]["text"] != "hello world" {
		t.Fatalf("lost or duplicated guest edits: %s", out)
	}
	if count := resumed.Doc.GetArray(canvas.NodesKey).Len(); count != 2 {
		t.Fatalf("live resumed doc has %d nodes", count)
	}
}

func TestKeptCanvasRestoresReferencedImages(t *testing.T) {
	dir := t.TempDir()
	hash := protocol.ContentHash(keptPNG)
	initial := `{"nodes":[{"id":"a","type":"file","file":"assets\/` + hash + `.png","x":0,"y":0,"width":100,"height":100}],"edges":[]}`
	path := filepath.Join(dir, "board.canvas")
	if err := os.WriteFile(path, []byte(initial), 0600); err != nil {
		t.Fatal(err)
	}
	files, err := prepareKeptFiles(dir, path)
	if err != nil {
		t.Fatal(err)
	}
	keys, _, _, _ := keptFixFrames(t)
	blobs, err := protocol.DeriveBlobKeys(keys.FrameKey)
	if err != nil {
		t.Fatal(err)
	}
	host := &keptTextHost{state: keptTextState{Project: dir, Origin: "https://relay.test", Files: files}, keys: keys, path: filepath.Join(t.TempDir(), "state.json"), room: "abcdefghijklmnopqrstuv"}
	host.imageClient = &http.Client{Transport: keepFixTransport(func(*http.Request) (*http.Response, error) {
		return &http.Response{StatusCode: 200, Header: http.Header{}, Body: io.NopCloser(bytes.NewReader(blobs.Encrypt(keptPNG)))}, nil
	})}
	if err := host.openFiles(); err != nil {
		t.Fatal(err)
	}
	defer host.closeFiles()
	if err := host.restore(); err != nil {
		t.Fatal(err)
	}
	if _, err := host.intake(context.Background(), keptTextRead{}); err != nil {
		t.Fatal(err)
	}
	image, err := os.ReadFile(filepath.Join(dir, "assets", hash+".png"))
	if err != nil || !bytes.Equal(image, keptPNG) {
		t.Fatalf("canvas image not restored: %v", err)
	}
}
