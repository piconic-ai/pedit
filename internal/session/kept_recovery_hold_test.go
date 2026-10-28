package session

import (
	"bytes"
	"context"
	"errors"
	"github.com/piconic-ai/pedit/internal/filewriter"
	"github.com/piconic-ai/pedit/internal/meta"
	"github.com/reearth/ygo/crdt"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestRecoveryStartAndStopHoldTextAndComments(t *testing.T) {
	base := crdt.New()
	content := newTextContent(base, "base")
	base.Transact(func(tx *crdt.Transaction) { content.text.Insert(tx, 4, " guest", nil) })
	comments := crdt.New()
	root := comments.GetMap(meta.CommentsKey)
	comments.Transact(func(tx *crdt.Transaction) {
		thread := crdt.NewMapPrelim()
		root.Set(tx, "c1", thread)
		thread.Set(tx, meta.QuoteKey, "guest comment")
	})
	cp := &recoveryCheckpoint{text: crdt.EncodeStateAsUpdateV1(base, nil), comments: crdt.EncodeStateAsUpdateV1(comments, nil)}
	diskMeta := `{"version":1,"path":"notes.md","comments":{},"unknown":{"keep":1}}`
	f := setup(t, "external edit", setupOpts{project: true, meta: diskMeta, watch: true, recovery: cp})
	if got := f.session.Text.ToString(); got != "base guest" {
		t.Fatalf("recovered text %q", got)
	}
	if _, ok := f.session.meta.doc.GetMap(meta.CommentsKey).Get("c1"); !ok {
		t.Fatal("recovered comment missing")
	}
	guest := crdt.New()
	if err := crdt.ApplyUpdateV1(guest, cp.text, nil); err != nil {
		t.Fatal(err)
	}
	var update []byte
	guest.OnUpdate(func(u []byte, _ any) { update = bytes.Clone(u) })
	guestText := guest.GetText("content")
	guest.Transact(func(tx *crdt.Transaction) { guestText.Insert(tx, 10, "!", nil) })
	var applyErr error
	f.session.Client.Do(func() { applyErr = crdt.ApplyUpdateV1(f.session.Doc, update, f.session.Client) })
	if applyErr != nil {
		t.Fatal(applyErr)
	}
	peerComments := crdt.New()
	if err := crdt.ApplyUpdateV1(peerComments, cp.comments, nil); err != nil {
		t.Fatal(err)
	}
	var commentUpdate []byte
	peerComments.OnUpdate(func(u []byte, _ any) { commentUpdate = bytes.Clone(u) })
	peerRoot := peerComments.GetMap(meta.CommentsKey)
	peerComments.Transact(func(tx *crdt.Transaction) {
		thread := crdt.NewMapPrelim()
		peerRoot.Set(tx, "c2", thread)
		thread.Set(tx, meta.QuoteKey, "second")
	})
	f.session.Client.Do(func() {
		applyErr = crdt.ApplyUpdateV1(f.session.meta.doc, commentUpdate, f.session.Client)
	})
	if applyErr != nil {
		t.Fatal(applyErr)
	}
	time.Sleep(100 * time.Millisecond)
	if got := readFile(t, f.file); got != "external edit" {
		t.Fatalf("wrote held file: %q", got)
	}
	if got := readFile(t, metaPathOf(f, "notes.md")); got != diskMeta {
		t.Fatalf("wrote held comments: %q", got)
	}
	if got := f.session.Text.ToString(); got != "base guest!" {
		t.Fatalf("lost update %q", got)
	}
	local, recovered, differs, err := f.session.recoveryContents()
	if err != nil || !differs || local != "external edit" || recovered != "base guest!" {
		t.Fatalf("local=%q recovered=%q differs=%v err=%v", local, recovered, differs, err)
	}
	if _, err := f.session.AddFile(f.file); err == nil {
		t.Fatal("accepted extra file during recovery")
	}
	late, err := os.OpenFile(f.file, os.O_WRONLY|os.O_TRUNC, 0)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := late.WriteString("late external edit"); err != nil {
		t.Fatal(err)
	}
	if err := late.Close(); err != nil {
		t.Fatal(err)
	}
	if err := f.session.Stop(); !errors.Is(err, filewriter.ErrRecoveryHeld) {
		t.Fatalf("stop: %v", err)
	}
	if got := f.session.Text.ToString(); got != "base guest!" {
		t.Fatalf("stop lost recovered text: %q", got)
	}
	if _, ok := f.session.meta.doc.GetMap(meta.CommentsKey).Get("c2"); !ok {
		t.Fatal("stop lost recovered comments")
	}
	if got := readFile(t, f.file); got != "late external edit" {
		t.Fatalf("stop wrote file: %q", got)
	}
	if got := readFile(t, metaPathOf(f, "notes.md")); got != diskMeta {
		t.Fatalf("stop wrote comments: %q", got)
	}
}

func TestRecoveryRejectsInvalidCheckpointBeforeRoomCreation(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "a.md")
	if err := os.WriteFile(path, []byte("local"), 0600); err != nil {
		t.Fatal(err)
	}
	empty := crdt.EncodeStateAsUpdateV1(crdt.New(), nil)
	for _, cp := range []*recoveryCheckpoint{
		{text: []byte{255}, comments: empty},
		{text: empty, comments: []byte{255}},
	} {
		if s, err := start(context.Background(), Options{File: path, Project: dir}, cp); err == nil {
			_ = s.Stop()
			t.Fatal("invalid checkpoint accepted")
		}
	}
	if got := readFile(t, path); got != "local" {
		t.Fatalf("changed local file: %q", got)
	}
}
