//go:build windows

package serve

import (
	"os/exec"
	"path/filepath"
	"testing"
	"time"
)

func icacls(t *testing.T, args ...string) {
	t.Helper()
	if out, err := exec.Command("icacls", args...).CombinedOutput(); err != nil {
		t.Fatalf("icacls %v: %v\n%s", args, err, out)
	}
}

func testRecord() stateRecord {
	return stateRecord{Version: stateVersion, Generation: "g", Saved: time.Now(), Doc: []byte{0}}
}

// A directory the user made (inheriting the profile's access list) passes, and
// so does one pedit made; an extra write grant on the directory or the file is
// refused, because another user could then replace the state.
func TestStateRefusesAnExtraWriter(t *testing.T) {
	for name, dir := range map[string]string{
		"made by the user": t.TempDir(),
		"made by pedit":    filepath.Join(t.TempDir(), "new", "state"),
	} {
		t.Run(name, func(t *testing.T) {
			path := filepath.Join(dir, "a.json")
			if err := writeState(path, testRecord()); err != nil {
				t.Fatal(err)
			}
			if readState(path) == nil {
				t.Fatal("a private state was refused")
			}

			icacls(t, dir, "/grant", "*S-1-1-0:(M)") // Everyone: modify, on the directory only
			if readState(path) != nil {
				t.Fatal("a state in a directory others can write was used")
			}
			icacls(t, dir, "/remove:g", "*S-1-1-0")
			if readState(path) == nil {
				t.Fatal("the state was refused after the extra grant was removed")
			}

			icacls(t, path, "/grant", "*S-1-1-0:(M)") // the same on the file
			if readState(path) != nil {
				t.Fatal("a state file others can write was used")
			}
		})
	}
}
