//go:build darwin

package session

import (
	"crypto/ed25519"
	"encoding/json"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"testing"

	"github.com/piconic-ai/pedit/internal/hoststate"
)

func TestRecoveryTransactionReopenAndConflicts(t *testing.T) {
	store, room, evidence, file := emptyBundleFixture(t)
	defer store.Close()
	bundle, err := publishRecoveryBundle(store, room, evidence)
	if err != nil {
		t.Fatal(err)
	}
	intent, err := prepareRecoveryIntent(store, room, bundle.Manifest)
	if err != nil {
		t.Fatal(err)
	}
	j, err := prepareRecoveryTransaction(store, room, intent.IntentPath)
	if err != nil || j.State != "baseline-observed" {
		t.Fatal("prepare", err)
	}
	if _, err = os.Stat(j.TextStage); !os.IsNotExist(err) {
		t.Fatal("stage unexpectedly created", err)
	}
	stateDir := filepath.Dir(j.Journal)
	if err = store.Close(); err != nil {
		t.Fatal(err)
	}
	child := exec.Command(os.Args[0], "-test.run=^TestRecoveryTransactionChild$")
	child.Env = append(os.Environ(), "PEDIT_TRANSACTION_STORE="+stateDir, "PEDIT_TRANSACTION_ROOM="+room, "PEDIT_TRANSACTION_PATH="+j.Journal)
	if output, err := child.CombinedOutput(); err != nil {
		t.Fatalf("restart: %v %s", err, output)
	}
	store, err = hoststate.Open(stateDir)
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	if err = os.WriteFile(j.TextStage, []byte("external"), 0600); err != nil {
		t.Fatal(err)
	}
	conflict, err := inspectRecoveryTransaction(store, room, j.Journal)
	if err == nil || conflict.State != "conflict" || conflict.TextStage != j.TextStage {
		t.Fatal("reserved name collision", err)
	}
	if err = os.Remove(j.TextStage); err != nil {
		t.Fatal(err)
	}
	old, err := os.OpenFile(file, os.O_WRONLY, 0)
	if err != nil {
		t.Fatal(err)
	}
	defer old.Close()
	if err = os.Rename(file, file+".moved"); err != nil {
		t.Fatal(err)
	}
	if err = os.WriteFile(file, nil, 0600); err != nil {
		t.Fatal(err)
	}
	if _, err = old.Write([]byte("late write")); err != nil {
		t.Fatal(err)
	}
	conflict, err = inspectRecoveryTransaction(store, room, j.Journal)
	if err == nil || conflict.State != "conflict" || conflict.Intent != j.Intent {
		t.Fatal("replacement accepted", err)
	}
	if raw, err := os.ReadFile(file + ".moved"); err != nil || string(raw) != "late write" {
		t.Fatal("late write lost", err)
	}
}

func TestRecoveryTransactionChild(t *testing.T) {
	dir := os.Getenv("PEDIT_TRANSACTION_STORE")
	if dir == "" {
		t.Skip("subprocess only")
	}
	store, err := hoststate.Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	view, err := inspectRecoveryTransaction(store, os.Getenv("PEDIT_TRANSACTION_ROOM"), os.Getenv("PEDIT_TRANSACTION_PATH"))
	if err != nil || view.State != "baseline-observed" {
		t.Fatal(err)
	}
}

func TestRecoveryTransactionRejectsMetadataAppearanceAndSyncUncertainty(t *testing.T) {
	store, room, evidence, file := emptyBundleFixture(t)
	defer store.Close()
	bundle, err := publishRecoveryBundle(store, room, evidence)
	if err != nil {
		t.Fatal(err)
	}
	intent, err := prepareRecoveryIntent(store, room, bundle.Manifest)
	if err != nil {
		t.Fatal(err)
	}
	journal, err := prepareRecoveryTransaction(store, room, intent.IntentPath)
	if err != nil {
		t.Fatal(err)
	}
	sidecar := filepath.Join(filepath.Dir(file), ".pedit", "meta", "empty.md.json")
	if err = os.MkdirAll(filepath.Dir(sidecar), 0700); err != nil {
		t.Fatal(err)
	}
	if err = os.WriteFile(sidecar, []byte("external"), 0600); err != nil {
		t.Fatal(err)
	}
	result, err := inspectRecoveryTransaction(store, room, journal.Journal)
	if err == nil || result.State != "conflict" || result.Intent != journal.Intent {
		t.Fatal("metadata appearance accepted", err)
	}
	raw, err := os.ReadFile(sidecar)
	if err != nil || string(raw) != "external" {
		t.Fatal("metadata overwritten", err)
	}
	if err = os.Remove(sidecar); err != nil {
		t.Fatal(err)
	}
	if result, err = inspectRecoveryTransactionWithSync(store, room, journal.Journal, func() error { return errors.New("injected fsync failure") }); err == nil || result.State == "baseline-observed" {
		t.Fatal("accepted fsync failure")
	}
	stateDir := filepath.Dir(journal.Journal)
	if err = os.Chmod(stateDir, 0500); err != nil {
		t.Fatal(err)
	}
	_, err = inspectRecoveryTransaction(store, room, journal.Journal)
	if err == nil {
		t.Fatal("accepted unsafe state directory")
	}
	if err = os.Chmod(stateDir, 0700); err != nil {
		t.Fatal(err)
	}
	if result, err = inspectRecoveryTransaction(store, room, journal.Journal); err != nil || result.State != "baseline-observed" {
		t.Fatal("could not retry", err)
	}
}

func TestRecoveryTransactionCrashAfterPublication(t *testing.T) {
	store, room, evidence, file := emptyBundleFixture(t)
	bundle, err := publishRecoveryBundle(store, room, evidence)
	if err != nil {
		t.Fatal(err)
	}
	intent, err := prepareRecoveryIntent(store, room, bundle.Manifest)
	if err != nil {
		t.Fatal(err)
	}
	stateDir := filepath.Dir(intent.IntentPath)
	if err = store.Close(); err != nil {
		t.Fatal(err)
	}
	child := exec.Command(os.Args[0], "-test.run=^TestRecoveryTransactionCrashChild$")
	child.Env = append(os.Environ(), "PEDIT_TRANSACTION_STORE="+stateDir, "PEDIT_TRANSACTION_ROOM="+room, "PEDIT_TRANSACTION_PATH="+intent.IntentPath)
	err = child.Run()
	if exit, ok := err.(*exec.ExitError); !ok || exit.ExitCode() != 31 {
		t.Fatal("child did not stop after publication", err)
	}
	store, err = hoststate.Open(stateDir)
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	paths, err := store.ListCandidates(room)
	if err != nil {
		t.Fatal(err)
	}
	found := 0
	for _, p := range paths {
		raw, e := store.ReadCandidate(room, p)
		if e != nil {
			t.Fatal(e)
		}
		var marker struct {
			Kind string `json:"kind"`
		}
		if json.Unmarshal(raw, &marker) != nil || marker.Kind != "recovery-transaction" {
			continue
		}
		view, e := inspectRecoveryTransaction(store, room, p)
		if e != nil || view.State != "baseline-observed" || view.Intent != intent {
			t.Fatal("recovery after crash", e)
		}
		found++
	}
	if found != 1 {
		t.Fatalf("found %d journals", found)
	}
	if raw, e := os.ReadFile(file); e != nil || len(raw) != 0 {
		t.Fatal("original changed", e)
	}
}

func TestRecoveryTransactionCrashChild(t *testing.T) {
	dir := os.Getenv("PEDIT_TRANSACTION_STORE")
	if dir == "" {
		t.Skip("subprocess only")
	}
	store, err := hoststate.Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = prepareRecoveryTransaction(store, os.Getenv("PEDIT_TRANSACTION_ROOM"), os.Getenv("PEDIT_TRANSACTION_PATH")); err != nil {
		t.Fatal(err)
	}
	os.Exit(31)
}

func TestRecoveryTransactionRejectsSignedMetadataMismatch(t *testing.T) {
	store, room, evidence, _ := emptyBundleFixture(t)
	defer store.Close()
	bundle, err := publishRecoveryBundle(store, room, evidence)
	if err != nil {
		t.Fatal(err)
	}
	intent, err := prepareRecoveryIntent(store, room, bundle.Manifest)
	if err != nil {
		t.Fatal(err)
	}
	journal, err := prepareRecoveryTransaction(store, room, intent.IntentPath)
	if err != nil {
		t.Fatal(err)
	}
	raw, err := store.ReadCandidate(room, journal.Journal)
	if err != nil {
		t.Fatal(err)
	}
	var forged recoveryTransaction
	if err = json.Unmarshal(raw, &forged); err != nil {
		t.Fatal(err)
	}
	forged.Metadata = []byte(`{"version":1,"path":"wrong","comments":{}}`)
	credentials, err := store.Load(room)
	if err != nil {
		t.Fatal(err)
	}
	_, signer, err := credentials.Keys()
	if err != nil {
		t.Fatal(err)
	}
	message, err := recoveryTransactionMessage(forged)
	if err != nil {
		t.Fatal(err)
	}
	forged.Signature = ed25519.Sign(signer, message)
	raw, err = json.Marshal(forged)
	if err != nil {
		t.Fatal(err)
	}
	forgedPath, err := store.PublishCandidate(room, raw)
	if err != nil {
		t.Fatal(err)
	}
	result, err := inspectRecoveryTransaction(store, room, forgedPath)
	if err == nil || result.State != "conflict" || result.Intent != intent {
		t.Fatal("signed incorrect metadata accepted", err)
	}
}
