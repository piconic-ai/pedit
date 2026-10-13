//go:build unix

package filewriter

import (
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"testing"

	"golang.org/x/sys/unix"
)

// writeBound saves through a BoundFile opened for this one write.
func writeBound(path, content string) error {
	f, err := OpenBound(path)
	if err != nil {
		return err
	}
	// The file as it is now is what this write expects to replace.
	expected, _ := f.Read()
	return errors.Join(f.Write(expected, content), f.Close())
}

// TestPrivateFilePermissions checks both ways of saving: an existing file
// keeps its mode, and a new one is created 0600 less the umask, even a umask
// that takes the owner's own bits. Saving twice checks that the second save
// keeps what the first made, such as a file without owner write.
func TestPrivateFilePermissions(t *testing.T) {
	const marker = "PEDIT_TEST_FILE_UMASK"
	if value := os.Getenv(marker); value != "" {
		mask, err := strconv.ParseUint(value, 8, 32)
		if err != nil {
			t.Fatal(err)
		}
		for _, writer := range []struct {
			name  string
			write func(path, content string) error
		}{
			{"WriteAtomic", WriteAtomic},
			{"BoundFile.Write", writeBound},
		} {
			dir := t.TempDir()
			preserved := filepath.Join(dir, "existing")
			if err := os.WriteFile(preserved, []byte("old"), 0o640); err != nil {
				t.Fatal(err)
			}
			if err := os.Chmod(preserved, 0o640); err != nil {
				t.Fatal(err)
			}
			fresh := filepath.Join(dir, "new")
			old := unix.Umask(int(mask))
			for _, content := range []string{"one", "two"} {
				for _, path := range []string{fresh, preserved} {
					if err := writer.write(path, content); err != nil {
						t.Fatalf("%s %s: %v", writer.name, filepath.Base(path), err)
					}
				}
				for path, want := range map[string]os.FileMode{fresh: 0o600 &^ os.FileMode(mask), preserved: 0o640} {
					info, err := os.Lstat(path)
					if err != nil {
						t.Fatal(err)
					}
					if info.Mode().Perm() != want {
						t.Fatalf("%s: %s mode = %o after writing %q, want %o", writer.name, filepath.Base(path), info.Mode().Perm(), content, want)
					}
				}
			}
			unix.Umask(old)
		}
		return
	}
	// Umask is process-wide; isolate it from timers and other tests.
	for _, mask := range []int{0, 0o022, 0o077, 0o277, 0o777} {
		t.Run(fmt.Sprintf("umask=%03o", mask), func(t *testing.T) {
			cmd := exec.Command(os.Args[0], "-test.run=^TestPrivateFilePermissions$")
			cmd.Env = append(os.Environ(), fmt.Sprintf("%s=%03o", marker, mask))
			if out, err := cmd.CombinedOutput(); err != nil {
				t.Fatalf("%v\n%s", err, out)
			}
		})
	}
}
