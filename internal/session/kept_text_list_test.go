package session

import (
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

func TestListKeptTextLeavesOutTheOlderPollingRooms(t *testing.T) {
	isolateKeptUserConfig(t)
	project := t.TempDir()
	keptRecord(t, project, "https://example.test", 1, 2000, nil, false)
	room, _, _ := pruneRecord(t, project, "https://example.test", 2, 1000, nil)
	records, err := ListKeptText(project)
	if err != nil || len(records) != 1 || records[0].Room != room {
		t.Fatalf("%+v %v", records, err)
	}
}

func TestKeptTextResumeByRoomID(t *testing.T) {
	isolateKeptUserConfig(t)
	project := t.TempDir()
	room, path, _ := pruneRecord(t, project, "https://example.test", 1, 1, nil)
	h := keptTextHost{}
	if err := h.prepare(KeptTextOptions{Project: project, Resume: room}); err != nil || h.path != path {
		t.Fatalf("room ID did not find the record: %v %q", err, h.path)
	}
	other := t.TempDir()
	if err := (&keptTextHost{}).prepare(KeptTextOptions{Project: other, Resume: room}); err == nil {
		t.Fatal("resumed a room this project has no record of")
	}
}
