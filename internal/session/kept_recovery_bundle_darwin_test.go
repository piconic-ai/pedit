//go:build darwin

package session

import (
	"bytes"
	"crypto/ed25519"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	"github.com/piconic-ai/pedit/internal/hoststate"
	"github.com/piconic-ai/pedit/internal/protocol"
)

func emptyBundleFixture(t *testing.T, metadata ...string) (*hoststate.Store, string, string, string) {
	t.Helper()
	dir := t.TempDir()
	file := filepath.Join(dir, "empty.md")
	if err := os.WriteFile(file, nil, 0600); err != nil {
		t.Fatal(err)
	}
	if len(metadata) > 0 {
		metaPath := filepath.Join(dir, ".pedit", "meta", "empty.md.json")
		if err := os.MkdirAll(filepath.Dir(metaPath), 0700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(metaPath, []byte(metadata[0]), 0600); err != nil {
			t.Fatal(err)
		}
	}
	initial, err := captureKeptInitial(file, dir, protocol.KeptAttachmentsNone)
	if err != nil {
		t.Fatal(err)
	}
	defer initial.Close()
	room := "6oZqdX5MOLq_qBJ8vppAnT"
	c := hoststate.Credentials{Version: 1, Origin: "https://edit.piconic.ai", RoomID: room, HostToken: "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8", Generation: 1}
	c.EditSecret[0] = 1
	c.HostSeed[0] = 2
	store, err := hoststate.Open(filepath.Join(t.TempDir(), "host"))
	if err != nil {
		t.Fatal(err)
	}
	c, err = initial.persist(store, c)
	if err != nil {
		t.Fatal(err)
	}
	baseline, err := loadKeptInitial(c)
	if err != nil {
		t.Fatal(err)
	}
	keys, signer, err := c.Keys()
	if err != nil {
		t.Fatal(err)
	}
	plain, err := protocol.OpenKeptCheckpoint(keys, protocol.KeptCheckpointContext{RoomID: room, Epoch: baseline.Epoch, Generation: 1}, baseline.Checkpoint)
	if err != nil {
		t.Fatal(err)
	}
	cp, err := protocol.DecodeKeptTextPayload(plain, protocol.MaxKeptCheckpointReceipts)
	if err != nil {
		t.Fatal(err)
	}
	replayed, err := replayKeptRecovery(recoveryCheckpoint{text: cp.Documents[0], comments: cp.Documents[1], metaID: 1}, cp.Ledger, keys, protocol.KeptRecordContext{RoomID: room, Epoch: baseline.Epoch, Generation: 1}, nil)
	if err != nil {
		t.Fatal(err)
	}
	ledger, err := protocol.EncodeKeptLedger(replayed.ledger)
	if err != nil {
		t.Fatal(err)
	}
	e := recoveryEvidence{Version: 1, Room: room, Epoch: baseline.Epoch, Generation: 1, Checkpoint: baseline.Checkpoint, Entries: []evidenceEntry{}, Text: replayed.text, Comments: replayed.comments, MetadataID: 1, Ledger: ledger, TailStatus: "unverified"}
	message, err := evidenceMessage(e)
	if err != nil {
		t.Fatal(err)
	}
	e.Signature = ed25519.Sign(signer, message)
	raw, err := json.Marshal(e)
	if err != nil {
		t.Fatal(err)
	}
	evidence, err := store.PublishCandidate(room, raw)
	if err != nil {
		t.Fatal(err)
	}
	return store, room, evidence, file
}

func TestRecoveryBundlePreservesEmptyTextAndRejectsInconsistentSignedOutput(t *testing.T) {
	store, room, evidence, file := emptyBundleFixture(t)
	defer store.Close()
	paths, err := publishRecoveryBundle(store, room, evidence)
	if err != nil {
		t.Fatal(err)
	}
	result, err := openRecoveryBundle(store, room, paths.Manifest)
	if err != nil || len(result.Text) != 0 || !bytes.Equal(result.Comments, []byte("{}\n")) {
		t.Fatalf("empty bundle: %q %q %v", result.Text, result.Comments, err)
	}
	if raw, err := os.ReadFile(paths.Text); err != nil || len(raw) != 0 {
		t.Fatal("empty output changed", err)
	}
	if _, err = openRecoveryBundle(store, "AAAAAAAAAAAAAAAAAAAAAA", paths.Manifest); err == nil {
		t.Fatal("accepted other room")
	}
	fakePath, err := store.PublishRecoveryOutput(room, hoststate.RecoveryText, []byte("forged"))
	if err != nil {
		t.Fatal(err)
	}
	raw, err := store.ReadCandidate(room, paths.Manifest)
	if err != nil {
		t.Fatal(err)
	}
	var m recoveryBundleManifest
	if err = json.Unmarshal(raw, &m); err != nil {
		t.Fatal(err)
	}
	m.TextPath = fakePath
	m.TextHash = recoveryBundleHash([]byte("forged"))
	c, err := store.Load(room)
	if err != nil {
		t.Fatal(err)
	}
	_, signer, err := c.Keys()
	if err != nil {
		t.Fatal(err)
	}
	message, err := recoveryBundleMessage(m)
	if err != nil {
		t.Fatal(err)
	}
	m.Signature = ed25519.Sign(signer, message)
	raw, err = json.Marshal(m)
	if err != nil {
		t.Fatal(err)
	}
	forged, err := store.PublishCandidate(room, raw)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = openRecoveryBundle(store, room, forged); err == nil {
		t.Fatal("accepted signed output inconsistent with evidence")
	}
	if raw, err := os.ReadFile(file); err != nil || len(raw) != 0 {
		t.Fatal("original changed", err)
	}
}
