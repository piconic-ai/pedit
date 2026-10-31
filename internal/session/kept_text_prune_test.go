package session

import (
	"crypto/sha256"
	"encoding/base64"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/piconic-ai/pedit/internal/protocol"
	"github.com/reearth/ygo/crdt"
)

// keptRecord saves a resume record for project and returns its room, path and
// link. Without socket it is the record of the older, polling kind of room.
func keptRecord(t *testing.T, project, origin string, seed byte, until int64, pending *string, socket bool) (string, string, string) {
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
	state := keptTextState{Project: project, Origin: origin, Fragment: protocol.GenerateEditSecret(), HostToken: token, Keep: 60, Until: until, Initialized: true, Socket: socket,
		Files: []keptTextFileState{{Path: filepath.Base(file), File: file, State: crdt.EncodeStateAsUpdateV1(doc, nil), Text: "base", Pending: pending}}}
	path := keptTestStatePath(t, project, room)
	if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
		t.Fatal(err)
	}
	if err := saveKeptState(path, state); err != nil {
		t.Fatal(err)
	}
	return room, path, origin + "/r/" + room + "#" + state.Fragment
}

// pruneRecord saves the record of a room kept by the relay.
func pruneRecord(t *testing.T, project, origin string, seed byte, until int64, pending *string) (string, string, string) {
	t.Helper()
	return keptRecord(t, project, origin, seed, until, pending, true)
}

func exists(path string) bool { _, e := os.Stat(path); return e == nil }

// The records of the older, polling kind of room cannot be resumed any more:
// closing a room removes them, except one with a write still to finish, and
// leaves every other record alone.
func TestKeptTextCloseRemovesOnlyOldRecordsOfThisProject(t *testing.T) {
	isolateKeptUserConfig(t)
	soon, later := int64(1), int64(1)<<60
	project, other := t.TempDir(), t.TempDir()
	_, current, _ := pruneRecord(t, project, "https://example.test", 1, later, nil)
	_, old, _ := keptRecord(t, project, "https://example.test", 2, soon, nil, false)
	pending := "x"
	_, pendingPath, _ := keptRecord(t, project, "https://example.test", 3, soon, &pending, false)
	_, expired, _ := pruneRecord(t, project, "https://example.test", 4, soon, nil)
	_, otherOld, _ := keptRecord(t, other, "https://example.test", 5, soon, nil, false)
	junk := filepath.Join(filepath.Dir(current), "AAAAAAAAAAAAAAAAAAAAAA.json")
	if err := os.WriteFile(junk, []byte("{"), 0600); err != nil {
		t.Fatal(err)
	}
	pruned := 0
	if err := PruneOldKept(project, func(n int) { pruned = n }); err != nil {
		t.Fatal(err)
	}
	if pruned != 1 || exists(old) {
		t.Fatalf("pruned=%d, old record exists=%v", pruned, exists(old))
	}
	for name, p := range map[string]string{"current": current, "write pending": pendingPath, "relay's, though past its deadline": expired, "other project": otherOld, "unparsable": junk} {
		if !exists(p) {
			t.Errorf("removed %s record", name)
		}
	}
}

func TestKeptTextOldRecordCannotBeResumed(t *testing.T) {
	isolateKeptUserConfig(t)
	project := t.TempDir()
	_, _, link := keptRecord(t, project, "https://example.test", 1, 1<<60, nil, false)
	if _, err := openAway(KeptTextOptions{Project: project, Resume: link}); err == nil || !strings.Contains(err.Error(), "older version") {
		t.Fatalf("resumed a polling room: %v", err)
	}
}
