package session

import (
	"os"
	"strings"
	"testing"
	"time"

	"github.com/piconic-ai/pedit/internal/canvas"
	"github.com/piconic-ai/pedit/internal/meta"
	"github.com/piconic-ai/pedit/internal/protocol"
	"github.com/piconic-ai/pedit/internal/protocol/prototest"
	"github.com/reearth/ygo/crdt"
)

func TestHostRecoversTextCommentsAndCanvasWithoutANewRoom(t *testing.T) {
	f := setup(t, "hello world!\n", setupOpts{watch: true, project: true})
	boardPath := writeBeside(t, f, "board.canvas", board)
	entry, err := f.session.AddFile(boardPath)
	if err != nil {
		t.Fatal(err)
	}
	g := joinFiles(t, f.relay, f.session.URL)
	prototest.WaitFor(t, wait, func() bool { return len(g.files()) == 4 && g.String() == "hello world!\n" }, "all shared files")
	comments := g.open(t, 1)
	boardDoc := g.open(t, entry.ID)
	boardText := func(id string) string {
		var text string
		g.Do(func() {
			for _, n := range canvas.Read(boardDoc).Nodes {
				if n["id"] == id {
					text, _ = n["text"].(string)
				}
			}
		})
		return text
	}
	prototest.WaitFor(t, wait, func() bool { return boardText("a1") == "Hello" }, "guest canvas")
	g.Do(func() { comment(t, comments, g.doc, "before", 6, 11, "Before the interruption") })
	path := metaPathOf(f, "notes.md")
	prototest.WaitFor(t, wait, func() bool { _, err := os.Stat(path); return err == nil }, "initial comment on disk")
	url := f.session.URL
	resume := f.relay.PauseHost()
	defer resume()
	prototest.WaitFor(t, wait, func() bool {
		return f.session.Client.Status() == protocol.StatusDisconnected && g.Status() == protocol.StatusWaiting
	}, "host offline and guest waiting")
	if err := os.WriteFile(f.file, []byte("local hello world!\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	localBoard := strings.Replace(board, `"World"`, `"Local world"`, 1)
	if err := os.WriteFile(boardPath, []byte(localBoard), 0o644); err != nil {
		t.Fatal(err)
	}
	g.Do(func() {
		g.insert(len([]rune("hello world!\n")), "guest\n")
		comment(t, comments, g.doc, "offline", 6, 11, "An in-flight comment")
		node := boardDoc.GetArray(canvas.NodesKey).Get(0).(*crdt.YMap)
		text, _ := node.Get(canvas.TextKey)
		boardDoc.Transact(func(txn *crdt.Transaction) { text.(*crdt.YText).Insert(txn, 0, "Guest ", nil) })
	})
	prototest.WaitFor(t, wait, func() bool {
		var text string
		f.session.Client.Do(func() { text = f.session.Text.ToString() })
		return text == "local hello world!\n" && strings.Contains(f.session.addedFile(entry.ID).render(), "Local world")
	}, "host to merge local disk changes while offline")
	resume()
	const want = "local hello world!\nguest\n"
	prototest.WaitFor(t, 6*time.Second, func() bool {
		data, _ := os.ReadFile(f.file)
		return string(data) == want && g.String() == want && f.session.Client.Status() == protocol.StatusConnected && g.Status() == protocol.StatusConnected
	}, "merged text saved before Stop")
	prototest.WaitFor(t, wait, func() bool {
		data, _ := os.ReadFile(boardPath)
		parsed, err := canvas.Parse(data)
		if err != nil {
			return false
		}
		texts := map[string]string{}
		for _, n := range parsed.Canvas.Nodes {
			texts[n["id"].(string)], _ = n["text"].(string)
		}
		return texts["a1"] == "Guest Hello" && texts["b2"] == "Local world" && boardText("a1") == "Guest Hello" && boardText("b2") == "Local world"
	}, "merged canvas saved before Stop")
	prototest.WaitFor(t, wait, func() bool {
		data, _ := os.ReadFile(path)
		saved, err := meta.Parse(data)
		if err != nil || len(saved.Comments) != 2 {
			return false
		}
		return saved.Comments["before"].Anchor.Text.Offset == 12 && saved.Comments["offline"].Messages["m1"].Body == "An in-flight comment"
	}, "both comments and moved anchors saved before Stop")
	if f.session.URL != url {
		t.Fatal("recovery created a new room")
	}
	urls := f.relay.URLs()
	for i, h := range f.relay.Headers() {
		if auth := h.Get("Authorization"); auth != "" {
			if auth != "Bearer host-token" || urls[i] != urls[0] {
				t.Fatalf("host handshake changed: %q %q", auth, urls[i])
			}
		}
	}
}
