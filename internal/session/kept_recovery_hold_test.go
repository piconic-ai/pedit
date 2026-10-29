package session

import (
	"bytes"
	"context"
	"errors"
	"github.com/piconic-ai/pedit/internal/filewriter"
	"github.com/piconic-ai/pedit/internal/meta"
	"github.com/reearth/ygo/crdt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime/pprof"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func TestRecoveryRejectsUnknownRootBeforeRoomCreation(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "notes.md")
	if err := os.WriteFile(path, []byte("local"), 0600); err != nil {
		t.Fatal(err)
	}
	var requests atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		requests.Add(1)
		_, _ = w.Write([]byte(`{"id":"AAAAAAAAAAAAAAAAAAAAAA","hostToken":"host-token"}`))
	}))
	defer server.Close()
	text := crdt.New()
	content, hidden := text.GetText("content"), text.GetText("unknown")
	text.Transact(func(tx *crdt.Transaction) {
		content.Insert(tx, 0, "visible", nil)
		hidden.Insert(tx, 0, "hidden", nil)
	})
	empty := crdt.EncodeStateAsUpdateV1(crdt.New(), nil)
	_, err := start(context.Background(), Options{File: path, Project: dir, Server: server.URL}, &recoveryCheckpoint{text: crdt.EncodeStateAsUpdateV1(text, nil), comments: empty})
	if err == nil || !strings.Contains(err.Error(), "unsupported recovery text state") {
		t.Fatalf("start: %v", err)
	}
	if requests.Load() != 0 {
		t.Fatal("contacted relay before rejecting checkpoint")
	}
	if got := readFile(t, path); got != "local" {
		t.Fatalf("changed local file: %q", got)
	}
}

func TestRecoveryContentsRejectsUnknownRootAddedAfterStart(t *testing.T) {
	text := crdt.New()
	value := text.GetText("content")
	text.Transact(func(tx *crdt.Transaction) { value.Insert(tx, 0, "guest", nil) })
	cp := &recoveryCheckpoint{text: crdt.EncodeStateAsUpdateV1(text, nil), comments: crdt.EncodeStateAsUpdateV1(crdt.New(), nil)}
	f := setup(t, "local", setupOpts{project: true, recovery: cp})
	f.session.Client.Do(func() {
		hidden := f.session.Doc.GetText("unknown")
		f.session.Doc.Transact(func(tx *crdt.Transaction) { hidden.Insert(tx, 0, "hidden", nil) })
	})
	if _, _, _, err := f.session.recoveryContents(); err == nil {
		t.Fatal("accepted unsupported live state")
	}
	if got := readFile(t, f.file); got != "local" {
		t.Fatalf("changed file: %q", got)
	}
}

func TestRecoveryMalformedMetadataDoesNotStartAttachmentWorker(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "notes.md")
	metaPath := filepath.Join(dir, ".pedit", "meta", "notes.md.json")
	if err := os.MkdirAll(filepath.Dir(metaPath), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte("local"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(metaPath, []byte("invalid metadata"), 0600); err != nil {
		t.Fatal(err)
	}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(`{"id":"AAAAAAAAAAAAAAAAAAAAAA","hostToken":"host-token"}`))
	}))
	defer server.Close()
	count := func() int {
		var out bytes.Buffer
		_ = pprof.Lookup("goroutine").WriteTo(&out, 2)
		return strings.Count(out.String(), "internal/attach.(*Attachments).run(")
	}
	before := count()
	empty := crdt.EncodeStateAsUpdateV1(crdt.New(), nil)
	for range 3 {
		s, err := start(context.Background(), Options{File: path, Project: dir, Server: server.URL}, &recoveryCheckpoint{text: empty, comments: empty})
		if err != nil {
			t.Fatalf("start: %v", err)
		}
		if err = s.Stop(); !errors.Is(err, filewriter.ErrRecoveryHeld) {
			t.Fatalf("stop: %v", err)
		}
	}
	if got := readFile(t, metaPath); got != "invalid metadata" {
		t.Fatalf("changed metadata: %q", got)
	}
	if after := count(); after != before {
		t.Fatalf("attachment workers before=%d after=%d", before, after)
	}
}

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
	if f.session.attachments != nil {
		t.Fatal("recovery started an attachment worker")
	}
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
	unknown := crdt.New()
	hidden := unknown.GetText("unknown")
	unknown.Transact(func(tx *crdt.Transaction) { hidden.Insert(tx, 0, "hidden", nil) })
	for _, cp := range []*recoveryCheckpoint{
		{text: []byte{255}, comments: empty},
		{text: crdt.EncodeStateAsUpdateV1(unknown, nil), comments: empty},
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
