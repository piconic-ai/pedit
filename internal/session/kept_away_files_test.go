package session

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/piconic-ai/pedit/internal/protocol"
	"github.com/piconic-ai/pedit/internal/protocol/prototest"
	"github.com/reearth/ygo/crdt"
)

func TestKeepSeveralFilesWithTheirCommentsAndResumeThem(t *testing.T) {
	a := newAwayRoom(t, "notes\n")
	todo := filepath.Join(a.project, "todo.md")
	if err := os.WriteFile(todo, []byte("todo\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	opts := a.options()
	opts.Keep = 3600e9
	opts.More = []string{todo}
	s, err := Start(context.Background(), opts)
	if err != nil {
		t.Fatal(err)
	}
	a.waitSent(protocol.KindSnapshot, 1)
	prototest.WaitFor(t, wait, func() bool { return !s.KeptUntil().IsZero() }, "the keep")
	keys := s.Client.Keys()
	// The bundle holds both texts and the comments doc paired with each, under
	// the ids the record keeps.
	files, err := protocol.OpenKeptBundle(keys, a.sent(protocol.KindSnapshot)[0])
	if err != nil {
		t.Fatal(err)
	}
	var ids []uint32
	var paths []string
	for _, f := range files {
		ids, paths = append(ids, f.ID), append(paths, f.Path)
	}
	if strings.Join(paths, " ") != "notes.md todo.md .pedit/meta/notes.md.json .pedit/meta/todo.md.json" || ids[1] != 1 || ids[2] != keptMetaIDBase || ids[3] != keptMetaIDBase+1 {
		t.Fatalf("bundle holds %v %v", ids, paths)
	}
	if _, err := s.AddFile(todo); err == nil {
		t.Fatal("added a file to a kept room")
	}
	if err := s.Stop(); err != nil {
		t.Fatal(err)
	}

	// A guest edited the second file while the host was away.
	doc := crdt.New()
	if err := crdt.ApplyUpdateV1(doc, files[1].Update, nil); err != nil {
		t.Fatal(err)
	}
	before := doc.StateVector()
	text := doc.GetText("content")
	doc.Transact(func(tx *crdt.Transaction) { text.Insert(tx, 4, " by a guest", nil) })
	entry, err := protocol.SealKeptFileUpdate(keys, 1, crdt.EncodeStateAsUpdateV1(doc, before))
	if err != nil {
		t.Fatal(err)
	}
	a.script(1, protocol.EncodeLogged(1, entry), protocol.EncodeLogEnd(1))
	resume := a.options()
	resume.Resume = a.id
	resumed, err := Start(context.Background(), resume)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = resumed.Stop() })
	if got := readText(t, todo); got != "todo by a guest\n" {
		t.Fatalf("todo.md = %q", got)
	}
	if got := readText(t, a.file); got != "notes\n" {
		t.Fatalf("notes.md = %q", got)
	}
	if n := len(resumed.Files()); n != 2 {
		t.Fatalf("shares %d files", n)
	}
}
