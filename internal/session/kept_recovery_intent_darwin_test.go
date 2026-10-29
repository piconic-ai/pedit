//go:build darwin

package session

import (
	"bytes"
	"crypto/ed25519"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"testing"

	"github.com/piconic-ai/pedit/internal/hoststate"
)

func TestRecoveryIntentPreservesSourcesAndReopensAfterRestart(t *testing.T) {
	store, room, evidence, file := emptyBundleFixture(t)
	defer store.Close()
	bundle, err := publishRecoveryBundle(store, room, evidence)
	if err != nil {
		t.Fatal(err)
	}
	paths, err := prepareRecoveryIntent(store, room, bundle.Manifest)
	if err != nil {
		t.Fatal(err)
	}
	view, err := openRecoveryIntent(store, room, paths.IntentPath)
	if err != nil || view.Paths != paths || len(view.NewText) != 0 || view.MetadataStatus != "not-generated" || view.TailStatus != "unverified" || view.AttachmentStatus != "unverified" {
		t.Fatal("intent did not validate", err)
	}
	if raw, err := os.ReadFile(file); err != nil || len(raw) != 0 {
		t.Fatal("source changed", err)
	}
	stateDir := filepath.Dir(paths.IntentPath)
	if err = store.Close(); err != nil {
		t.Fatal(err)
	}
	child := exec.Command(os.Args[0], "-test.run=^TestRecoveryIntentChild$")
	child.Env = append(os.Environ(), "PEDIT_INTENT_STORE="+stateDir, "PEDIT_INTENT_ROOM="+room, "PEDIT_INTENT_PATH="+paths.IntentPath)
	if output, err := child.CombinedOutput(); err != nil {
		t.Fatalf("fresh process: %v %s", err, output)
	}
	store, err = hoststate.Open(stateDir)
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	if _, err = openRecoveryIntent(store, room, paths.IntentPath); err != nil {
		t.Fatal(err)
	}
	if err = os.WriteFile(file, []byte("external"), 0600); err != nil {
		t.Fatal(err)
	}
	failed, err := openRecoveryIntent(store, room, paths.IntentPath)
	if err == nil || failed.Paths != paths {
		t.Fatal("changed source did not retain paths", err)
	}
	if raw, err := os.ReadFile(file); err != nil || string(raw) != "external" {
		t.Fatal("changed source overwritten", err)
	}
}

func TestRecoveryIntentChild(t *testing.T) {
	path := os.Getenv("PEDIT_INTENT_STORE")
	if path == "" {
		t.Skip("subprocess only")
	}
	store, err := hoststate.Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	view, err := openRecoveryIntent(store, os.Getenv("PEDIT_INTENT_ROOM"), os.Getenv("PEDIT_INTENT_PATH"))
	if err != nil || view.MetadataStatus != "not-generated" || len(view.NewText) != 0 {
		t.Fatal("intent unavailable after restart", err)
	}
}

func TestRecoveryIntentRejectsChangedArtifactsAndTargets(t *testing.T) {
	store, room, evidence, file := emptyBundleFixture(t)
	defer store.Close()
	bundle, err := publishRecoveryBundle(store, room, evidence)
	if err != nil {
		t.Fatal(err)
	}
	paths, err := prepareRecoveryIntent(store, room, bundle.Manifest)
	if err != nil {
		t.Fatal(err)
	}
	for _, path := range []string{bundle.Manifest, bundle.Evidence, bundle.Text, bundle.Comments, paths.IntentPath} {
		old, err := os.ReadFile(path)
		if err != nil {
			t.Fatal(err)
		}
		if err = os.WriteFile(path, append(bytes.Clone(old), 'x'), 0600); err != nil {
			t.Fatal(err)
		}
		retained, err := openRecoveryIntent(store, room, paths.IntentPath)
		if err == nil {
			t.Fatalf("accepted changed %s", path)
		}
		if path != paths.IntentPath && retained.Paths != paths {
			t.Fatalf("lost retained paths after change to %s", path)
		}
		if err = os.WriteFile(path, old, 0600); err != nil {
			t.Fatal(err)
		}
	}
	if err = os.Rename(file, file+".saved"); err != nil {
		t.Fatal(err)
	}
	if err = os.WriteFile(file, nil, 0600); err != nil {
		t.Fatal(err)
	}
	if _, err = openRecoveryIntent(store, room, paths.IntentPath); err == nil {
		t.Fatal("accepted replacement inode with same bytes")
	}
	if err = os.Remove(file); err != nil {
		t.Fatal(err)
	}
	if err = os.Rename(file+".saved", file); err != nil {
		t.Fatal(err)
	}
	metadata := filepath.Join(filepath.Dir(file), ".pedit", "meta", "empty.md.json")
	if err = os.MkdirAll(filepath.Dir(metadata), 0700); err != nil {
		t.Fatal(err)
	}
	if err = os.WriteFile(metadata, []byte("not json"), 0600); err != nil {
		t.Fatal(err)
	}
	retained, err := openRecoveryIntent(store, room, paths.IntentPath)
	if err == nil || retained.Paths != paths {
		t.Fatal("accepted added metadata or lost artifact paths", err)
	}
	if data, err := os.ReadFile(metadata); err != nil || string(data) != "not json" {
		t.Fatal("metadata changed", err)
	}
}

func TestRecoveryIntentRejectsResignedContentMismatch(t *testing.T) {
	store, room, evidence, _ := emptyBundleFixture(t)
	defer store.Close()
	bundle, err := publishRecoveryBundle(store, room, evidence)
	if err != nil {
		t.Fatal(err)
	}
	paths, err := prepareRecoveryIntent(store, room, bundle.Manifest)
	if err != nil {
		t.Fatal(err)
	}
	raw, err := store.ReadCandidate(room, paths.IntentPath)
	if err != nil {
		t.Fatal(err)
	}
	var intent recoveryIntent
	if err = json.Unmarshal(raw, &intent); err != nil {
		t.Fatal(err)
	}
	intent.NewText = []byte("different")
	creds, err := store.Load(room)
	if err != nil {
		t.Fatal(err)
	}
	_, signer, err := creds.Keys()
	if err != nil {
		t.Fatal(err)
	}
	message, err := intentMessage(intent)
	if err != nil {
		t.Fatal(err)
	}
	intent.Signature = ed25519.Sign(signer, message)
	raw, err = json.Marshal(intent)
	if err != nil {
		t.Fatal(err)
	}
	forged, err := store.PublishCandidate(room, raw)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = openRecoveryIntent(store, room, forged); err == nil {
		t.Fatal("accepted intent with mismatched bytes")
	}
}

func TestRecoveryIntentPreservesAndChecksExistingMetadata(t *testing.T) {
	original := `{"version":1,"path":"empty.md","comments":{},"future":{"keep":true}}`
	store, room, evidence, file := emptyBundleFixture(t, original)
	defer store.Close()
	bundle, err := publishRecoveryBundle(store, room, evidence)
	if err != nil {
		t.Fatal(err)
	}
	paths, err := prepareRecoveryIntent(store, room, bundle.Manifest)
	if err != nil {
		t.Fatal(err)
	}
	metadata := filepath.Join(filepath.Dir(file), ".pedit", "meta", "empty.md.json")
	if data, err := os.ReadFile(metadata); err != nil || string(data) != original {
		t.Fatal("metadata changed", err)
	}
	if err = os.WriteFile(metadata, []byte("not json"), 0600); err != nil {
		t.Fatal(err)
	}
	result, err := openRecoveryIntent(store, room, paths.IntentPath)
	if err == nil || result.Paths != paths {
		t.Fatal("metadata change accepted or paths lost", err)
	}
	if data, err := os.ReadFile(metadata); err != nil || string(data) != "not json" {
		t.Fatal("external metadata changed", err)
	}
	if err = os.WriteFile(metadata, []byte(original), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err = openRecoveryIntent(store, room, paths.IntentPath); err != nil {
		t.Fatal("unchanged inode and bytes rejected", err)
	}
	if err = os.Rename(metadata, metadata+".saved"); err != nil {
		t.Fatal(err)
	}
	if err = os.WriteFile(metadata, []byte(original), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err = openRecoveryIntent(store, room, paths.IntentPath); err == nil {
		t.Fatal("metadata inode replacement accepted")
	}
}

func TestRecoveryIntentProcessInterruption(t *testing.T) {
	if path := os.Getenv("PEDIT_INTENT_CRASH_STORE"); path != "" {
		store, err := hoststate.Open(path)
		if err != nil {
			os.Exit(2)
		}
		_, _ = prepareRecoveryIntentWithHook(store, os.Getenv("PEDIT_INTENT_CRASH_ROOM"), os.Getenv("PEDIT_INTENT_CRASH_BUNDLE"), func(point string) {
			if point == os.Getenv("PEDIT_INTENT_CRASH_POINT") {
				os.Exit(7)
			}
		})
		os.Exit(3)
	}
	for _, point := range []string{"before-publish", "published"} {
		t.Run(point, func(t *testing.T) {
			store, room, evidence, file := emptyBundleFixture(t)
			bundle, err := publishRecoveryBundle(store, room, evidence)
			if err != nil {
				t.Fatal(err)
			}
			stateDir := filepath.Dir(bundle.Manifest)
			if err = store.Close(); err != nil {
				t.Fatal(err)
			}
			child := exec.Command(os.Args[0], "-test.run=^TestRecoveryIntentProcessInterruption$")
			child.Env = append(os.Environ(), "PEDIT_INTENT_CRASH_STORE="+stateDir, "PEDIT_INTENT_CRASH_ROOM="+room, "PEDIT_INTENT_CRASH_BUNDLE="+bundle.Manifest, "PEDIT_INTENT_CRASH_POINT="+point)
			err = child.Run()
			if e, ok := err.(*exec.ExitError); !ok || e.ExitCode() != 7 {
				t.Fatal("child", err)
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
			var intents []string
			for _, path := range paths {
				raw, e := store.ReadCandidate(room, path)
				if e != nil {
					t.Fatal(e)
				}
				var header struct {
					Kind string `json:"kind"`
				}
				if json.Unmarshal(raw, &header) == nil && header.Kind == "recovery-intent" {
					intents = append(intents, path)
				}
			}
			want := 0
			if point == "published" {
				want = 1
			}
			if len(intents) != want {
				t.Fatalf("found %d intents", len(intents))
			}
			if _, err = openRecoveryBundle(store, room, bundle.Manifest); err != nil {
				t.Fatal("bundle lost", err)
			}
			if want == 1 {
				view, err := openRecoveryIntent(store, room, intents[0])
				if err != nil || view.Paths.BundlePath != bundle.Manifest {
					t.Fatal("published intent lost", err)
				}
			}
			if raw, err := os.ReadFile(file); err != nil || len(raw) != 0 {
				t.Fatal("source changed", err)
			}
		})
	}
}

func TestRecoveryIntentRejectsOutputSwapBeforePublish(t *testing.T) {
	store, room, evidence, file := emptyBundleFixture(t)
	defer store.Close()
	bundle, err := publishRecoveryBundle(store, room, evidence)
	if err != nil {
		t.Fatal(err)
	}
	original, err := os.ReadFile(bundle.Text)
	if err != nil {
		t.Fatal(err)
	}
	paths, err := prepareRecoveryIntentWithHook(store, room, bundle.Manifest, func(stage string) {
		if stage == "before-publish" {
			if err := os.WriteFile(bundle.Text, []byte("replacement"), 0600); err != nil {
				t.Fatal(err)
			}
		}
	})
	if err == nil || paths.IntentPath == "" || paths.TextPath != bundle.Text {
		t.Fatal("swap accepted or artifact path lost", err)
	}
	if err := os.WriteFile(bundle.Text, original, 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := openRecoveryIntent(store, room, paths.IntentPath); err != nil {
		t.Fatal(err)
	}
	if raw, err := os.ReadFile(file); err != nil || len(raw) != 0 {
		t.Fatal("source changed", err)
	}
}
