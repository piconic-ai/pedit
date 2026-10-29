//go:build darwin

package session

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"testing"

	"github.com/piconic-ai/pedit/internal/filewriter"
	"github.com/piconic-ai/pedit/internal/hoststate"
	"github.com/piconic-ai/pedit/internal/meta"
	"github.com/reearth/ygo/crdt"
)

func TestExportRecoveryConflictPreservesLocalAndComments(t *testing.T) {
	text := crdt.New()
	newTextContent(text, "guest edit")
	comments := crdt.New()
	root := comments.GetMap(meta.CommentsKey)
	comments.Transact(func(tx *crdt.Transaction) {
		thread := crdt.NewMapPrelim()
		root.Set(tx, "c1", thread)
		thread.Set(tx, meta.QuoteKey, "guest comment")
	})
	cp := &recoveryCheckpoint{text: crdt.EncodeStateAsUpdateV1(text, nil), comments: crdt.EncodeStateAsUpdateV1(comments, nil)}
	f := setup(t, "external edit", setupOpts{project: true, recovery: cp})
	room := "6oZqdX5MOLq_qBJ8vppAnT"
	c := hoststate.Credentials{Version: 1, Origin: "https://edit.piconic.ai", RoomID: room, HostToken: "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8", Generation: 1}
	c.EditSecret[0] = 1
	c.HostSeed[0] = 2
	storePath := filepath.Join(t.TempDir(), "host")
	store, err := hoststate.Open(storePath)
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	if err = store.Save(c); err != nil {
		t.Fatal(err)
	}
	candidate := &keptRecoveryCandidate{session: f.session, room: room, tailStatus: "tail-unverified", attachmentStatus: "attachments-unverified"}
	if err = os.WriteFile(f.file, []byte("guest edit"), 0600); err != nil {
		t.Fatal(err)
	}
	equalPath, err := candidate.exportRecoveryCandidate(store, room)
	if err != nil {
		t.Fatal(err)
	}
	equalData, err := os.ReadFile(equalPath)
	if err != nil {
		t.Fatal(err)
	}
	var equal recoveryExport
	if json.Unmarshal(equalData, &equal) != nil || equal.TextComparison != "equal" {
		t.Fatal("matching local text not reported")
	}
	if err = os.WriteFile(f.file, []byte("external edit"), 0600); err != nil {
		t.Fatal(err)
	}
	path, err := candidate.exportRecoveryCandidate(store, room)
	if err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var result recoveryExport
	if err = json.Unmarshal(data, &result); err != nil {
		t.Fatal(err)
	}
	if result.TextComparison != "conflict" || result.Text != "guest edit" || result.Tail != "unverified" || result.Attachments != "unverified" {
		t.Fatalf("invalid candidate: %#v", result)
	}
	restored := crdt.New()
	defer restored.Destroy()
	if err = crdt.ApplyUpdateV1(restored, result.CommentsYjs, nil); err != nil {
		t.Fatal(err)
	}
	if _, ok := restored.GetMap(meta.CommentsKey).Get("c1"); !ok {
		t.Fatal("comment state lost")
	}
	if !bytes.Contains(result.CommentsView, []byte("guest comment")) {
		t.Fatal("comment preview is missing")
	}
	if _, err := candidate.exportRecoveryCandidate(store, "AAAAAAAAAAAAAAAAAAAAAA"); err == nil {
		t.Fatal("candidate used a different room")
	}
	if err = os.Rename(f.file, f.file+".away"); err != nil {
		t.Fatal(err)
	}
	unavailable, err := candidate.exportRecoveryCandidate(store, room)
	if err != nil {
		t.Fatal(err)
	}
	unavailableBytes, err := os.ReadFile(unavailable)
	if err != nil {
		t.Fatal(err)
	}
	var missing recoveryExport
	if err = json.Unmarshal(unavailableBytes, &missing); err != nil || missing.TextComparison != "unavailable" || missing.Text != "guest edit" {
		t.Fatal("unreadable local discarded candidate")
	}
	if err = os.Rename(f.file+".away", f.file); err != nil {
		t.Fatal(err)
	}
	if got := readFile(t, f.file); got != "external edit" {
		t.Fatal("local file changed")
	}
	if err = os.WriteFile(f.file, []byte("late edit"), 0600); err != nil {
		t.Fatal(err)
	}
	if err = f.session.Stop(); !errors.Is(err, filewriter.ErrRecoveryHeld) {
		t.Fatalf("stop: %v", err)
	}
	if _, err := candidate.exportRecoveryCandidate(store, room); err == nil {
		t.Fatal("closed session exported")
	}
	if got := readFile(t, f.file); got != "late edit" {
		t.Fatal("late local edit changed")
	}
	if got, err := os.ReadFile(path); err != nil || string(got) != string(data) {
		t.Fatal("candidate changed after stop")
	}
	if err = store.Close(); err != nil {
		t.Fatal(err)
	}
	reopened, err := hoststate.Open(storePath)
	if err != nil {
		t.Fatal(err)
	}
	defer reopened.Close()
	opts := Options{File: f.file, Project: filepath.Dir(f.file), Server: "https://must-not-connect.invalid"}
	restoredCandidate, err := openRecoveryExport(context.Background(), opts, reopened, room, path)
	if err != nil {
		t.Fatal(err)
	}
	if got := restoredCandidate.session.Text.ToString(); got != "guest edit" {
		t.Fatalf("restored text %q", got)
	}
	if _, ok := restoredCandidate.session.meta.doc.GetMap(meta.CommentsKey).Get("c1"); !ok {
		t.Fatal("restored comments missing")
	}
	reExported, err := restoredCandidate.exportRecoveryCandidate(reopened, room)
	if err != nil || reExported == path {
		t.Fatal("could not re-export reopened candidate")
	}
	reExportData, err := os.ReadFile(reExported)
	if err != nil {
		t.Fatal(err)
	}
	var again recoveryExport
	if json.Unmarshal(reExportData, &again) != nil || again.TextComparison != "conflict" || again.Text != "guest edit" {
		t.Fatal("reopened candidate lost content")
	}
	if err = restoredCandidate.session.Stop(); !errors.Is(err, filewriter.ErrRecoveryHeld) {
		t.Fatal("restored session was not held")
	}
	if got := readFile(t, f.file); got != "late edit" {
		t.Fatal("restored session changed local file")
	}
	guestHash := sha256.Sum256([]byte(result.Text))
	cases := map[string]func(*recoveryExport){
		"forged comments":           func(v *recoveryExport) { v.CommentsView = json.RawMessage(`{"c1":{"quote":"forged"}}`) },
		"missing comments":          func(v *recoveryExport) { v.CommentsView = nil },
		"unknown comparison":        func(v *recoveryExport) { v.TextComparison = "trusted" },
		"invalid hash":              func(v *recoveryExport) { v.ObservedLocalSHA256 = "not-a-hash" },
		"unavailable with hash":     func(v *recoveryExport) { v.TextComparison = "unavailable" },
		"equal with different hash": func(v *recoveryExport) { v.TextComparison = "equal" },
		"conflict with equal hash":  func(v *recoveryExport) { v.ObservedLocalSHA256 = hex.EncodeToString(guestHash[:]) },
	}
	for name, mutate := range cases {
		t.Run(name, func(t *testing.T) {
			badResult := result
			mutate(&badResult)
			bad, err := json.MarshalIndent(badResult, "", "  ")
			if err != nil {
				t.Fatal(err)
			}
			bad = append(bad, '\n')
			if err = os.WriteFile(path, bad, 0600); err != nil {
				t.Fatal(err)
			}
			if _, err = openRecoveryExport(context.Background(), opts, reopened, room, path); err == nil {
				t.Fatal("forged candidate accepted")
			}
			if got := readFile(t, f.file); got != "late edit" {
				t.Fatal("rejection changed local file")
			}
			if got, err := os.ReadFile(path); err != nil || !bytes.Equal(got, bad) {
				t.Fatal("rejection changed candidate")
			}
		})
	}
	result.Text = "tampered"
	bad, err := json.MarshalIndent(result, "", "  ")
	if err != nil {
		t.Fatal(err)
	}
	bad = append(bad, '\n')
	if err = os.WriteFile(path, bad, 0600); err != nil {
		t.Fatal(err)
	}
	if _, err = openRecoveryExport(context.Background(), opts, reopened, room, path); err == nil {
		t.Fatal("inconsistent recovered text accepted")
	}
	if got := readFile(t, f.file); got != "late edit" {
		t.Fatal("invalid recovery changed local file")
	}
}
