//go:build darwin

package session

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"testing"

	"github.com/piconic-ai/pedit/internal/hoststate"
	"golang.org/x/sys/unix"
)

func TestRecoveryExchangeCrashClassification(t *testing.T) {
	for _, tc := range []struct{ mode, text, metadata string }{{"none", "old", "old"}, {"text", "new", "old"}, {"metadata", "old", "new"}, {"both", "new", "new"}, {"text-sync", "new", "old"}, {"metadata-sync", "old", "new"}, {"both-sync", "new", "new"}} {
		t.Run(tc.mode, func(t *testing.T) {
			store, room, journal, file := stageFixture(t)
			stage, err := prepareRecoveryStages(store, room, journal, nil)
			if err != nil {
				t.Fatal(err)
			}
			sidecar := filepath.Join(filepath.Dir(file), ".pedit", "meta", "empty.md.json")
			stateDir := filepath.Dir(stage.Receipt)
			if err = store.Close(); err != nil {
				t.Fatal(err)
			}
			child := exec.Command(os.Args[0], "-test.run=^TestRecoveryExchangeCrashChild$")
			child.Env = append(os.Environ(), "PEDIT_EXCHANGE_MODE="+tc.mode, "PEDIT_EXCHANGE_TEXT="+file, "PEDIT_EXCHANGE_TEXT_STAGE="+stage.Recovery.TextStage, "PEDIT_EXCHANGE_META="+sidecar, "PEDIT_EXCHANGE_META_STAGE="+stage.Recovery.MetadataStage)
			err = child.Run()
			e, ok := err.(*exec.ExitError)
			if !ok || !e.Sys().(syscall.WaitStatus).Signaled() || e.Sys().(syscall.WaitStatus).Signal() != syscall.SIGKILL {
				t.Fatal("child failure", err)
			}
			store, err = hoststate.Open(stateDir)
			if err != nil {
				t.Fatal(err)
			}
			defer store.Close()
			view, err := inspectRecoveryExchange(store, room, stage.Receipt)
			if err != nil || view.TextState != tc.text || view.MetadataState != tc.metadata || view.Recovery.TextRetained != stage.Recovery.TextRetained || view.Recovery.MetadataRetained != stage.Recovery.MetadataRetained {
				t.Fatalf("state %s/%s: %v", view.TextState, view.MetadataState, err)
			}
		})
	}
}

func TestRecoveryExchangeCrashChild(t *testing.T) {
	mode := os.Getenv("PEDIT_EXCHANGE_MODE")
	if mode == "" {
		t.Skip("subprocess only")
	}
	syncAfter := strings.HasSuffix(mode, "-sync")
	mode = strings.TrimSuffix(mode, "-sync")
	swap := func(a, b string) {
		d, e := os.Open(filepath.Dir(a))
		if e != nil {
			t.Fatal(e)
		}
		defer d.Close()
		if e = unix.RenameatxNp(int(d.Fd()), filepath.Base(a), int(d.Fd()), filepath.Base(b), unix.RENAME_SWAP); e != nil {
			t.Fatal(e)
		}
		if syncAfter {
			if e = hoststate.SyncDirectory(d); e != nil {
				t.Fatal(e)
			}
		}
	}
	if mode == "text" || mode == "both" {
		swap(os.Getenv("PEDIT_EXCHANGE_TEXT"), os.Getenv("PEDIT_EXCHANGE_TEXT_STAGE"))
	}
	if mode == "metadata" || mode == "both" {
		swap(os.Getenv("PEDIT_EXCHANGE_META"), os.Getenv("PEDIT_EXCHANGE_META_STAGE"))
	}
	_ = unix.Kill(os.Getpid(), unix.SIGKILL)
	select {}
}

func TestRecoveryExchangeConflictRetainsAllPaths(t *testing.T) {
	store, room, journal, file := stageFixture(t)
	defer store.Close()
	old, err := os.OpenFile(file, os.O_WRONLY, 0)
	if err != nil {
		t.Fatal(err)
	}
	defer old.Close()
	stage, err := prepareRecoveryStages(store, room, journal, nil)
	if err != nil {
		t.Fatal(err)
	}
	if err = os.Rename(file, file+".external"); err != nil {
		t.Fatal(err)
	}
	if err = os.WriteFile(file, []byte("intruder"), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err = old.Write([]byte("late")); err != nil {
		t.Fatal(err)
	}
	view, err := inspectRecoveryExchange(store, room, stage.Receipt)
	if err == nil || view.TextState != "conflict" || view.Recovery.TextRetained != stage.Recovery.TextRetained || view.Recovery.TextStage != stage.Recovery.TextStage || view.Recovery.MetadataRetained != stage.Recovery.MetadataRetained || view.Recovery.MetadataStage != stage.Recovery.MetadataStage {
		t.Fatal("conflict lost paths or succeeded", err)
	}
	retained, err := os.ReadFile(stage.Recovery.TextRetained)
	if err != nil || string(retained) != "late" {
		t.Fatal("late write missing", err)
	}
	current, err := os.ReadFile(file)
	if err != nil || string(current) != "intruder" {
		t.Fatal("external file changed", err)
	}
}

func TestRecoveryExchangeParentMoveIsUncertain(t *testing.T) {
	store, room, journal, file := stageFixture(t)
	defer store.Close()
	stage, err := prepareRecoveryStages(store, room, journal, nil)
	if err != nil {
		t.Fatal(err)
	}
	oldDir := filepath.Dir(file)
	moved := oldDir + "-moved"
	if err = os.Rename(oldDir, moved); err != nil {
		t.Fatal(err)
	}
	defer os.Rename(moved, oldDir)
	view, err := inspectRecoveryExchange(store, room, stage.Receipt)
	if err == nil || view.TextState != "uncertain" || view.MetadataState != "uncertain" || view.Recovery.TextStage != stage.Recovery.TextStage || view.Recovery.MetadataRetained != stage.Recovery.MetadataRetained || view.TextDestination != file || view.MetadataDestination != filepath.Join(oldDir, ".pedit", "meta", "empty.md.json") {
		t.Fatal("moved parent accepted or paths lost", err)
	}
	if _, err = os.Stat(filepath.Join(moved, filepath.Base(stage.Recovery.TextRetained))); err != nil {
		t.Fatal("moved retained file lost", err)
	}
}

func TestRecoveryExchangeUnknownInodeWithSameBytesIsConflict(t *testing.T) {
	store, room, journal, file := stageFixture(t)
	defer store.Close()
	stage, err := prepareRecoveryStages(store, room, journal, nil)
	if err != nil {
		t.Fatal(err)
	}
	if err = os.Rename(file, file+".moved"); err != nil {
		t.Fatal(err)
	}
	if err = os.WriteFile(file, nil, 0600); err != nil {
		t.Fatal(err)
	}
	view, err := inspectRecoveryExchange(store, room, stage.Receipt)
	if err == nil || view.TextState != "conflict" || view.Recovery.TextRetained != stage.Recovery.TextRetained || view.Recovery.MetadataStage != stage.Recovery.MetadataStage {
		t.Fatal("unknown inode accepted", err)
	}
}

func TestRecoveryExchangeDetectsReplacementRacingSwap(t *testing.T) {
	store, room, journal, file := stageFixture(t)
	defer store.Close()
	stage, err := prepareRecoveryStages(store, room, journal, nil)
	if err != nil {
		t.Fatal(err)
	}
	replacement := file + ".replacement"
	if err = os.WriteFile(replacement, []byte("external"), 0600); err != nil {
		t.Fatal(err)
	}
	if err = os.Rename(replacement, file); err != nil {
		t.Fatal(err)
	}
	d, err := os.Open(filepath.Dir(file))
	if err != nil {
		t.Fatal(err)
	}
	defer d.Close()
	if err = unix.RenameatxNp(int(d.Fd()), filepath.Base(file), int(d.Fd()), filepath.Base(stage.Recovery.TextStage), unix.RENAME_SWAP); err != nil {
		t.Fatal(err)
	}
	view, err := inspectRecoveryExchange(store, room, stage.Receipt)
	if err == nil || view.TextState != "conflict" || view.Recovery.TextStage != stage.Recovery.TextStage || view.Recovery.TextRetained != stage.Recovery.TextRetained {
		t.Fatal("race accepted", err)
	}
	displaced, err := os.ReadFile(stage.Recovery.TextStage)
	if err != nil || string(displaced) != "external" {
		t.Fatal("external inode lost", err)
	}
	original, err := os.ReadFile(stage.Recovery.TextRetained)
	if err != nil || len(original) != 0 {
		t.Fatal("original inode lost", err)
	}
}
