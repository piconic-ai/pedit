//go:build darwin

package session

import (
	"encoding/binary"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
	"unsafe"

	"github.com/piconic-ai/pedit/internal/hoststate"
	"golang.org/x/sys/unix"
)

func stageFixture(t *testing.T) (*hoststate.Store, string, string, string) {
	t.Helper()
	baseline := `{"version":1,"path":"empty.md","comments":{},"future":{"keep":true}}`
	store, room, evidence, file := emptyBundleFixture(t, baseline)
	for _, name := range []string{filepath.Dir(file), filepath.Join(filepath.Dir(file), ".pedit", "meta")} {
		if err := os.Chmod(name, 0700); err != nil {
			t.Fatal(err)
		}
	}
	for _, name := range []string{filepath.Dir(file), filepath.Join(filepath.Dir(file), ".pedit", "meta"), file, filepath.Join(filepath.Dir(file), ".pedit", "meta", "empty.md.json")} {
		setTestEmptyACL(t, name)
	}

	bundle, err := publishRecoveryBundle(store, room, evidence)
	if err != nil {
		t.Fatal(err)
	}
	intent, err := prepareRecoveryIntent(store, room, bundle.Manifest)
	if err != nil {
		t.Fatal(err)
	}
	j, err := prepareRecoveryTransaction(store, room, intent.IntentPath)
	if err != nil {
		t.Fatal(err)
	}
	return store, room, j.Journal, file
}

func setTestEmptyACL(t *testing.T, name string) {
	t.Helper()
	f, err := os.Open(name)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	attrs := struct {
		Count                        uint16
		Reserved                     uint16
		Common, Vol, Dir, File, Fork uint32
	}{Count: 5, Common: unix.ATTR_CMN_EXTENDED_SECURITY}
	var b [52]byte
	binary.LittleEndian.PutUint32(b[0:4], 8)
	binary.LittleEndian.PutUint32(b[4:8], 44)
	binary.LittleEndian.PutUint32(b[8:12], 0x012cc16d)
	_, _, errno := unix.Syscall6(unix.SYS_FSETATTRLIST, f.Fd(), uintptr(unsafe.Pointer(&attrs)), uintptr(unsafe.Pointer(&b[0])), uintptr(len(b)), 0, 0)
	if errno != 0 {
		t.Fatal(errno)
	}
}

func TestRecoveryStagesPreserveOriginalsAndReopen(t *testing.T) {
	store, room, journal, file := stageFixture(t)
	defer store.Close()
	result, err := prepareRecoveryStages(store, room, journal, nil)
	if err != nil || result.State != "prepared" {
		t.Fatal("prepare", err)
	}
	original, err := os.ReadFile(file)
	if err != nil || len(original) != 0 {
		t.Fatal("original changed", err)
	}
	retained, err := os.ReadFile(result.Recovery.TextRetained)
	if err != nil || len(retained) != 0 {
		t.Fatal("retained missing", err)
	}
	sidecar := filepath.Join(filepath.Dir(file), ".pedit", "meta", "empty.md.json")
	before, err := os.ReadFile(sidecar)
	if err != nil {
		t.Fatal(err)
	}
	stored, err := os.ReadFile(result.Recovery.MetadataRetained)
	if err != nil || string(stored) != string(before) {
		t.Fatal("metadata retained missing", err)
	}
	dir := filepath.Dir(result.Receipt)
	if err = store.Close(); err != nil {
		t.Fatal(err)
	}
	child := exec.Command(os.Args[0], "-test.run=^TestRecoveryStagesChild$")
	child.Env = append(os.Environ(), "PEDIT_STAGE_STORE="+dir, "PEDIT_STAGE_ROOM="+room, "PEDIT_STAGE_RECEIPT="+result.Receipt)
	if output, err := child.CombinedOutput(); err != nil {
		t.Fatalf("restart: %v %s", err, output)
	}
	store, err = hoststate.Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	if err = os.WriteFile(file, []byte("external"), 0600); err != nil {
		t.Fatal(err)
	}
	conflicted, err := inspectRecoveryStages(store, room, result.Receipt)
	if err == nil || conflicted.State != "uncertain" || conflicted.Recovery.TextRetained != result.Recovery.TextRetained {
		t.Fatal("late edit accepted", err)
	}
	data, err := os.ReadFile(result.Recovery.TextRetained)
	if err != nil || string(data) != "external" {
		t.Fatal("late inode write lost", err)
	}
}

func TestRecoveryStagesChild(t *testing.T) {
	dir := os.Getenv("PEDIT_STAGE_STORE")
	if dir == "" {
		t.Skip("subprocess only")
	}
	store, err := hoststate.Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	result, err := inspectRecoveryStages(store, os.Getenv("PEDIT_STAGE_ROOM"), os.Getenv("PEDIT_STAGE_RECEIPT"))
	if err != nil || result.State != "prepared" {
		t.Fatal(err)
	}
}

func TestRecoveryStagesCrashLeavesDiscoverableArtifacts(t *testing.T) {
	for _, point := range []string{"stage-created", "stage-written", "retained-linked", "receipt"} {
		t.Run(point, func(t *testing.T) {
			store, room, journal, file := stageFixture(t)
			initial, err := inspectRecoveryTransaction(store, room, journal)
			if err != nil {
				t.Fatal(err)
			}
			stateDir := filepath.Dir(journal)
			if err = store.Close(); err != nil {
				t.Fatal(err)
			}
			child := exec.Command(os.Args[0], "-test.run=^TestRecoveryStagesCrashChild$")
			child.Env = append(os.Environ(), "PEDIT_STAGE_STORE="+stateDir, "PEDIT_STAGE_ROOM="+room, "PEDIT_STAGE_JOURNAL="+journal, "PEDIT_STAGE_POINT="+point)
			err = child.Run()
			if e, ok := err.(*exec.ExitError); !ok || e.ExitCode() != 31 {
				t.Fatal("child did not stop", err)
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
			var receipt string
			for _, p := range paths {
				raw, e := store.ReadCandidate(room, p)
				if e != nil {
					t.Fatal(e)
				}
				var marker struct {
					Kind string `json:"kind"`
				}
				if json.Unmarshal(raw, &marker) == nil && marker.Kind == "recovery-stage" {
					receipt = p
				}
			}
			if point == "receipt" {
				view, e := inspectRecoveryStages(store, room, receipt)
				if e != nil || view.State != "prepared" {
					t.Fatal("receipt lost", e)
				}
			} else {
				view, e := inspectRecoveryTransaction(store, room, journal)
				if e == nil || view.State != "conflict" || view.TextStage != initial.TextStage || view.TextRetained != initial.TextRetained {
					t.Fatal("missing uncertain paths", e)
				}
				if _, e = os.Stat(initial.TextStage); e != nil {
					t.Fatal("stage disappeared", e)
				}
			}
			raw, e := os.ReadFile(file)
			if e != nil || len(raw) != 0 {
				t.Fatal("original changed", e)
			}
		})
	}
}

func TestRecoveryStagesCrashChild(t *testing.T) {
	point := os.Getenv("PEDIT_STAGE_POINT")
	if point == "" {
		t.Skip("subprocess only")
	}
	store, err := hoststate.Open(os.Getenv("PEDIT_STAGE_STORE"))
	if err != nil {
		t.Fatal(err)
	}
	_, err = prepareRecoveryStages(store, os.Getenv("PEDIT_STAGE_ROOM"), os.Getenv("PEDIT_STAGE_JOURNAL"), func(p string) {
		if p == point {
			os.Exit(31)
		}
	})
	t.Fatal("stop point not reached", err)
}

func TestRecoveryStagesRetainsOriginalAcrossExternalReplacement(t *testing.T) {
	store, room, journal, file := stageFixture(t)
	defer store.Close()
	old, err := os.OpenFile(file, os.O_WRONLY, 0)
	if err != nil {
		t.Fatal(err)
	}
	defer old.Close()
	count := 0
	result, err := prepareRecoveryStages(store, room, journal, func(point string) {
		if point != "retained-linked" {
			return
		}
		count++
		if count != 1 {
			return
		}
		if e := os.Rename(file, file+".moved"); e != nil {
			t.Fatal(e)
		}
		if e := os.WriteFile(file, []byte("external"), 0600); e != nil {
			t.Fatal(e)
		}
		if _, e := old.Write([]byte("late")); e != nil {
			t.Fatal(e)
		}
	})
	if err == nil || result.State != "uncertain" || result.Recovery.TextRetained == "" {
		t.Fatal("replacement accepted", err)
	}
	retained, e := os.ReadFile(result.Recovery.TextRetained)
	if e != nil || string(retained) != "late" {
		t.Fatal("late write not retained", e)
	}
	current, e := os.ReadFile(file)
	if e != nil || string(current) != "external" {
		t.Fatal("external file changed", e)
	}
}

func TestRecoveryStagesRejectMissingMetadataWithoutCreatingStage(t *testing.T) {
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
	if err != nil {
		t.Fatal(err)
	}
	result, err := prepareRecoveryStages(store, room, j.Journal, nil)
	if err == nil || result.State != "uncertain" || result.Recovery.Intent != intent {
		t.Fatal("missing metadata accepted", err)
	}
	if raw, e := os.ReadFile(file); e != nil || len(raw) != 0 {
		t.Fatal("original changed", e)
	}
	if _, e := os.Lstat(j.TextStage); !os.IsNotExist(e) {
		t.Fatal("unexpected stage", e)
	}
}

func TestRecoveryStagesRejectOccupiedReservedName(t *testing.T) {
	store, room, journal, file := stageFixture(t)
	defer store.Close()
	view, err := inspectRecoveryTransaction(store, room, journal)
	if err != nil {
		t.Fatal(err)
	}
	if err = os.WriteFile(view.TextStage, []byte("occupied"), 0600); err != nil {
		t.Fatal(err)
	}
	result, err := prepareRecoveryStages(store, room, journal, nil)
	if err == nil || result.Recovery.TextStage != view.TextStage {
		t.Fatal("occupied stage accepted", err)
	}
	if raw, e := os.ReadFile(view.TextStage); e != nil || string(raw) != "occupied" {
		t.Fatal("occupied stage changed", e)
	}
	if raw, e := os.ReadFile(file); e != nil || len(raw) != 0 {
		t.Fatal("original changed", e)
	}
}

func TestRecoveryStagesFailsClosedWhenStageSyncPreconditionFails(t *testing.T) {
	store, room, journal, file := stageFixture(t)
	defer store.Close()
	view, err := inspectRecoveryTransaction(store, room, journal)
	if err != nil {
		t.Fatal(err)
	}
	result, err := prepareRecoveryStages(store, room, journal, func(point string) {
		if point == "stage-written" {
			if e := os.Chmod(view.TextStage, 0644); e != nil {
				t.Fatal(e)
			}
		}
	})
	if err == nil || result.State != "uncertain" || result.Recovery.TextStage != view.TextStage {
		t.Fatal("unsafe stage accepted", err)
	}
	if raw, e := os.ReadFile(file); e != nil || len(raw) != 0 {
		t.Fatal("original changed", e)
	}
}

func TestRecoveryStagesRejectModifiedCandidateAndPreservePaths(t *testing.T) {
	store, room, journal, _ := stageFixture(t)
	defer store.Close()
	result, err := prepareRecoveryStages(store, room, journal, nil)
	if err != nil {
		t.Fatal(err)
	}
	if err = os.WriteFile(result.Recovery.MetadataStage, []byte("tampered"), 0600); err != nil {
		t.Fatal(err)
	}
	view, err := inspectRecoveryStages(store, room, result.Receipt)
	if err == nil || view.State != "uncertain" || view.Recovery.MetadataStage != result.Recovery.MetadataStage || view.Recovery.TextRetained != result.Recovery.TextRetained {
		t.Fatal("modified candidate accepted", err)
	}
}
