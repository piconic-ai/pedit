package session

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestListKeptTextZeroOneAndSeveralRecords(t *testing.T) {
	isolateKeptUserConfig(t)
	project, other := t.TempDir(), t.TempDir()
	if records, err := ListKeptText(project); err != nil || len(records) != 0 {
		t.Fatalf("empty: %v %v", records, err)
	}
	roomA, _, _ := pruneRecord(t, project, "https://example.test", 1, 2000, nil)
	pruneRecord(t, other, "https://example.test", 3, 1000, nil)
	records, err := ListKeptText(project)
	if err != nil || len(records) != 1 || records[0].Room != roomA || records[0].Until != 2000 || len(records[0].Paths) != 1 || records[0].Paths[0] != "notesb.md" {
		t.Fatalf("one: %+v %v", records, err)
	}
	roomB, _, _ := pruneRecord(t, project, "https://example.test", 2, 1000, nil)
	records, err = ListKeptText(project)
	if err != nil || len(records) != 2 || records[0].Room != roomB || records[1].Room != roomA {
		t.Fatalf("several, soonest first: %+v %v", records, err)
	}
}

func TestKeptTextResumeByRoomID(t *testing.T) {
	isolateKeptUserConfig(t)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(http.StatusGone) }))
	defer server.Close()
	project := t.TempDir()
	room, path, _ := pruneRecord(t, project, server.URL, 1, 1, nil)
	ended := 0
	err := RunKeptText(context.Background(), KeptTextOptions{Project: project, Resume: room, OnEnded: func() { ended++ }}, nil, nil)
	if err == nil || ended != 1 || exists(path) {
		t.Fatalf("room ID did not reach the relay: err=%v ended=%d", err, ended)
	}
	other := t.TempDir()
	if err := RunKeptText(context.Background(), KeptTextOptions{Project: other, Resume: room}, nil, nil); err == nil {
		t.Fatal("resumed a room this project has no record of")
	}
}
