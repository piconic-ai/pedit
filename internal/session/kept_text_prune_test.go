package session

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/piconic-ai/pedit/internal/protocol"
	"github.com/reearth/ygo/crdt"
)

// pruneRecord saves a resume record for project and returns its room, path and link.
func pruneRecord(t *testing.T, project, origin string, seed byte, until int64, pending *string) (string, string, string) {
	t.Helper()
	file := filepath.Join(project, "notes"+string(rune('a'+seed))+".md")
	if err := os.WriteFile(file, []byte("base"), 0600); err != nil {
		t.Fatal(err)
	}
	doc := crdt.New()
	defer doc.Destroy()
	text := doc.GetText("content")
	doc.Transact(func(tx *crdt.Transaction) { text.Insert(tx, 0, "base", nil) })
	token := base64.RawURLEncoding.EncodeToString([]byte(strings.Repeat(string(rune('a'+seed)), 32)))
	hash := sha256.Sum256([]byte(token))
	room := base64.RawURLEncoding.EncodeToString(hash[:])[:22]
	state := keptTextState{Project: project, Origin: origin, Fragment: protocol.GenerateEditSecret(), HostToken: token, Keep: 60, Until: until, Initialized: true,
		Files: []keptTextFileState{{Path: filepath.Base(file), File: file, State: crdt.EncodeStateAsUpdateV1(doc, nil), Text: "base", Pending: pending}}}
	path := keptTestStatePath(t, project, room)
	if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
		t.Fatal(err)
	}
	if err := saveKeptState(path, state); err != nil {
		t.Fatal(err)
	}
	return room, path, origin + "/r/" + room + "?keep=1#" + state.Fragment
}

func exists(path string) bool { _, e := os.Stat(path); return e == nil }

func TestKeptTextResumeRemovesRecordWhenRoomIsOver(t *testing.T) {
	for status, wantGone := range map[int]bool{http.StatusGone: true, http.StatusNotFound: true, http.StatusInternalServerError: false} {
		isolateKeptUserConfig(t)
		server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(status) }))
		project := t.TempDir()
		_, path, link := pruneRecord(t, project, server.URL, 1, 1, nil)
		ended := 0
		err := RunKeptText(context.Background(), KeptTextOptions{Project: project, Resume: link, OnEnded: func() { ended++ }}, nil, nil)
		server.Close()
		if err == nil || exists(path) == wantGone || (ended == 1) != wantGone {
			t.Fatalf("status %d: err=%v exists=%v ended=%d", status, err, exists(path), ended)
		}
	}
}

func TestKeptTextStartPrunesOnlyConfirmedExpiredRecordsOfThisProject(t *testing.T) {
	isolateKeptUserConfig(t)
	live := int64(1) << 60
	var gone, held string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case strings.Contains(r.URL.Path, gone):
			w.WriteHeader(http.StatusGone)
		case strings.Contains(r.URL.Path, held):
			w.Write([]byte(`{"entries":[{"id":1,"body":""}],"tail":1}`)) // relay still holds entries
		default:
			w.WriteHeader(http.StatusInternalServerError)
		}
	}))
	defer server.Close()
	project, other := t.TempDir(), t.TempDir()
	_, current, link := pruneRecord(t, project, server.URL, 1, live, nil)
	gone, expired, _ := pruneRecord(t, project, server.URL, 2, 1, nil)
	pending := "x"
	_, pendingPath, _ := pruneRecord(t, project, server.URL, 3, 1, &pending)
	held, heldPath, _ := pruneRecord(t, project, server.URL, 4, 1, nil)
	_, future, _ := pruneRecord(t, project, server.URL, 5, live, nil)
	_, otherPath, _ := pruneRecord(t, other, server.URL, 6, 1, nil)
	junk := filepath.Join(filepath.Dir(current), "AAAAAAAAAAAAAAAAAAAAAA.json")
	if err := os.WriteFile(junk, []byte("{"), 0600); err != nil {
		t.Fatal(err)
	}
	pruned := 0
	// The current room answers 500, so the run ends right after pruning.
	_ = RunKeptText(context.Background(), KeptTextOptions{Project: project, Resume: link, OnPruned: func(n int) { pruned = n }}, nil, nil)
	if pruned != 1 || exists(expired) {
		t.Fatalf("pruned=%d expired record exists=%v", pruned, exists(expired))
	}
	for name, p := range map[string]string{"current": current, "pending": pendingPath, "relay holds entries": heldPath, "not yet due": future, "other project": otherPath, "unparsable": junk} {
		if !exists(p) {
			t.Errorf("removed %s record", name)
		}
	}
}
