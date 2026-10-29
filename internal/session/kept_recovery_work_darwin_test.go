//go:build darwin

package session

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/piconic-ai/pedit/internal/hoststate"
	"github.com/piconic-ai/pedit/internal/protocol"
	"github.com/reearth/ygo/crdt"
)

func TestCandidateImportRejectsOverBudgetText(t *testing.T) {
	f := newRecoveryFixture(t)
	updates := concurrentRecoveryUpdates(t, f.checkpoint.text, 1, protocol.MaxKeptYjsWork)
	merged, err := crdt.MergeUpdatesV1(f.checkpoint.text, updates)
	if err != nil {
		t.Fatal(err)
	}
	work, err := protocol.KeptTextWork(merged, false)
	if err != nil || work <= protocol.MaxKeptYjsWork {
		t.Fatal("fixture", work, err)
	}
	text := crdt.New()
	if err = crdt.ApplyUpdateV1(text, merged, nil); err != nil {
		t.Fatal(err)
	}
	render := text.GetText("content").ToString()
	text.Destroy()
	comments := crdt.New()
	commentBytes := crdt.EncodeStateAsUpdateV1(comments, nil)
	view, err := comments.GetMap("comments").ToJSON()
	comments.Destroy()
	if err != nil {
		t.Fatal(err)
	}
	room := "6oZqdX5MOLq_qBJ8vppAnT"
	c := hoststate.Credentials{Version: 1, Origin: "https://edit.piconic.ai", RoomID: room, HostToken: "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8", Generation: 1}
	c.EditSecret[0] = 1
	c.HostSeed[0] = 2
	store, err := hoststate.Open(filepath.Join(t.TempDir(), "host"))
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	if err = store.Save(c); err != nil {
		t.Fatal(err)
	}
	export := recoveryExport{Version: 1, RoomID: room, Path: "note.md", MetadataID: 7, TextComparison: "unavailable", Text: render, TextYjs: merged, CommentsYjs: commentBytes, CommentsView: view, Tail: "unverified", Attachments: "unverified"}
	b, err := json.MarshalIndent(export, "", "  ")
	if err != nil {
		t.Fatal(err)
	}
	path, err := store.PublishCandidate(room, append(b, '\n'))
	if err != nil {
		t.Fatal(err)
	}
	if _, err = openRecoveryExport(context.Background(), f.opts, store, room, path); err == nil {
		t.Fatal("accepted over-budget candidate")
	}
	if _, err = exportVerifiedRecovery(store, room, "note.md", recoveryCheckpoint{text: merged, comments: commentBytes, metaID: 7}); err == nil {
		t.Fatal("exported over-budget candidate")
	}
	if _, err = start(context.Background(), f.opts, &recoveryCheckpoint{text: merged, comments: commentBytes, metaID: 7}); err == nil {
		t.Fatal("started over-budget candidate")
	}
	if disk, err := os.ReadFile(f.opts.File); err != nil || string(disk) != "external edit" {
		t.Fatal("original changed", err)
	}

}

func TestCandidateImportRejectsOverBudgetComments(t *testing.T) {
	f := newRecoveryFixture(t)
	doc := crdt.New(crdt.WithClientID(7))
	root := doc.GetMap("comments")
	doc.Transact(func(tx *crdt.Transaction) { root.Set(tx, "x", "v") })
	comment := crdt.EncodeStateAsUpdateV1(doc, nil)
	doc.Destroy()
	comment = append(comment[:len(comment)-1], 1, 7, 0x80, 0x04)
	for range 512 {
		comment = append(comment, 0, 1)
	}
	work, err := protocol.KeptCommentsWork(comment, false)
	if err != nil || work <= protocol.MaxKeptYjsWork {
		t.Fatal("fixture", work, err)
	}
	decoded := crdt.New()
	if err = crdt.ApplyUpdateV1(decoded, comment, nil); err != nil {
		t.Fatal(err)
	}
	view, err := decoded.GetMap("comments").ToJSON()
	decoded.Destroy()
	if err != nil {
		t.Fatal(err)
	}
	room := "6oZqdX5MOLq_qBJ8vppAnT"
	c := hoststate.Credentials{Version: 1, Origin: "https://edit.piconic.ai", RoomID: room, HostToken: "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8", Generation: 1}
	c.EditSecret[0] = 1
	c.HostSeed[0] = 2
	store, err := hoststate.Open(filepath.Join(t.TempDir(), "host"))
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	if err = store.Save(c); err != nil {
		t.Fatal(err)
	}
	candidate := recoveryExport{Version: 1, RoomID: room, Path: "note.md", MetadataID: 7, TextComparison: "unavailable", Text: "base", TextYjs: f.checkpoint.text, CommentsYjs: comment, CommentsView: view, Tail: "unverified", Attachments: "unverified"}
	raw, err := json.MarshalIndent(candidate, "", "  ")
	if err != nil {
		t.Fatal(err)
	}
	path, err := store.PublishCandidate(room, append(raw, '\n'))
	if err != nil {
		t.Fatal(err)
	}
	if _, err = openRecoveryExport(context.Background(), f.opts, store, room, path); err == nil || !strings.Contains(err.Error(), "comments work exceeded") {
		t.Fatal("accepted comments or wrong failure", err)
	}
	if _, err = exportVerifiedRecovery(store, room, "note.md", recoveryCheckpoint{text: f.checkpoint.text, comments: comment, metaID: 7}); err == nil {
		t.Fatal("exported over-budget comments")
	}
	if _, err = start(context.Background(), f.opts, &recoveryCheckpoint{text: f.checkpoint.text, comments: comment, metaID: 7}); err == nil {
		t.Fatal("started over-budget comments")
	}
	if disk, err := os.ReadFile(f.opts.File); err != nil || string(disk) != "external edit" {
		t.Fatal("original changed", err)
	}
}

func TestCandidateWorkBoundaryCanBeExportedAndReopened(t *testing.T) {
	f := newRecoveryFixture(t)
	updates := concurrentRecoveryUpdates(t, f.checkpoint.text, 1, protocol.MaxKeptYjsWork-1)
	merged, err := crdt.MergeUpdatesV1(f.checkpoint.text, updates)
	if err != nil {
		t.Fatal(err)
	}
	work, err := protocol.KeptTextWork(merged, false)
	if err != nil || work != protocol.MaxKeptYjsWork {
		t.Fatal("fixture", work, err)
	}
	room := "6oZqdX5MOLq_qBJ8vppAnT"
	c := hoststate.Credentials{Version: 1, Origin: "https://edit.piconic.ai", RoomID: room, HostToken: "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8", Generation: 1}
	c.EditSecret[0] = 1
	c.HostSeed[0] = 2
	store, err := hoststate.Open(filepath.Join(t.TempDir(), "host"))
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	if err = store.Save(c); err != nil {
		t.Fatal(err)
	}
	path, err := exportVerifiedRecovery(store, room, "note.md", recoveryCheckpoint{text: merged, comments: f.checkpoint.comments, metaID: 7})
	if err != nil {
		t.Fatal(err)
	}
	candidate, err := openRecoveryExport(context.Background(), f.opts, store, room, path)
	if err != nil {
		t.Fatal(err)
	}
	candidate.session.Stop()
	if disk, err := os.ReadFile(f.opts.File); err != nil || string(disk) != "external edit" {
		t.Fatal("original changed", err)
	}
}

func TestLiveRecoveryExportRejectsOverBudgetState(t *testing.T) {
	f := newRecoveryFixture(t)
	s, err := start(context.Background(), f.opts, &f.checkpoint)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Stop()
	updates := concurrentRecoveryUpdates(t, f.checkpoint.text, 1, protocol.MaxKeptYjsWork)
	var applyErr error
	s.Client.Do(func() { applyErr = crdt.ApplyUpdateV1(s.Doc, updates, nil) })
	if applyErr != nil {
		t.Fatal(applyErr)
	}
	room := "6oZqdX5MOLq_qBJ8vppAnT"
	c := hoststate.Credentials{Version: 1, Origin: "https://edit.piconic.ai", RoomID: room, HostToken: "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8", Generation: 1}
	c.EditSecret[0] = 1
	c.HostSeed[0] = 2
	store, err := hoststate.Open(filepath.Join(t.TempDir(), "host"))
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	if err = store.Save(c); err != nil {
		t.Fatal(err)
	}
	candidate := &keptRecoveryCandidate{session: s, room: room}
	if _, err = candidate.exportRecoveryCandidate(store, room); err == nil {
		t.Fatal("exported over-budget live state")
	}
	if disk, err := os.ReadFile(f.opts.File); err != nil || string(disk) != "external edit" {
		t.Fatal("original changed", err)
	}
}
