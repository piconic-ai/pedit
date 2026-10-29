//go:build darwin

package session

import (
	"bytes"
	"os"
	"path/filepath"
	"testing"
)

func TestRecoveryMetadataProposalKeepsSourcesAndRejectsConflict(t *testing.T) {
	baseline := `{"version":1,"path":"empty.md","comments":{},"future":{"keep":true}}`
	store, room, evidence, file := emptyBundleFixture(t, baseline)
	defer store.Close()
	bundle, err := publishRecoveryBundle(store, room, evidence)
	if err != nil {
		t.Fatal(err)
	}
	paths, err := prepareRecoveryIntent(store, room, bundle.Manifest)
	if err != nil {
		t.Fatal(err)
	}
	view, raw, err := recoveryMetadata(store, room, paths.IntentPath)
	if err != nil || view.MetadataStatus != "proposal-only" || !bytes.Contains(raw, []byte(`"future": {"keep":true}`)) {
		t.Fatal("proposal", err, string(raw))
	}
	if data, err := os.ReadFile(file); err != nil || len(data) != 0 {
		t.Fatal("original changed", err)
	}
	sidecar := filepath.Join(filepath.Dir(file), ".pedit", "meta", "empty.md.json")
	if disk, err := os.ReadFile(sidecar); err != nil || string(disk) != baseline {
		t.Fatal("baseline metadata changed", err)
	}
	if err := os.WriteFile(file, []byte("external"), 0600); err != nil {
		t.Fatal(err)
	}
	view, raw, err = recoveryMetadata(store, room, paths.IntentPath)
	if err == nil || raw != nil || view.Paths != paths {
		t.Fatal("conflict did not retain candidate paths", err)
	}
	if data, err := os.ReadFile(file); err != nil || string(data) != "external" {
		t.Fatal("external change lost", err)
	}
}
