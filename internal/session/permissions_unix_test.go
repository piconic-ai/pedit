//go:build unix

package session

import (
	"fmt"
	"os"
	"os/exec"
	"strconv"
	"testing"

	"github.com/piconic-ai/pedit/internal/protocol/prototest"
	"golang.org/x/sys/unix"
)

// TestNewFilesFollowTheUmask checks the files a session creates itself: the
// joined copy, and the host's file when it is deleted while sharing. Each is
// created 0600 less the umask, and later saves keep that mode, also when it
// has no owner write.
func TestNewFilesFollowTheUmask(t *testing.T) {
	const marker = "PEDIT_TEST_SESSION_UMASK"
	value := os.Getenv(marker)
	if value == "" {
		// Umask is process-wide; isolate it from timers and other tests.
		cmd := exec.Command(os.Args[0], "-test.run=^TestNewFilesFollowTheUmask$")
		cmd.Env = append(os.Environ(), marker+"=0277")
		if out, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("%v\n%s", err, out)
		}
		return
	}
	mask, err := strconv.ParseUint(value, 8, 32)
	if err != nil {
		t.Fatal(err)
	}
	want := os.FileMode(0o600) &^ os.FileMode(mask)
	checkMode := func(t *testing.T, path string) {
		t.Helper()
		info, err := os.Lstat(path)
		if err != nil {
			t.Fatal(err)
		}
		if info.Mode().Perm() != want {
			t.Fatalf("%s mode = %o, want %o", path, info.Mode().Perm(), want)
		}
	}
	// Not readFile: it fails the test on a missing file, and WaitFor polls while
	// the file may not exist yet.
	hasContent := func(path, content string) bool {
		b, err := os.ReadFile(path)
		return err == nil && string(b) == content
	}

	for _, initial := range []string{"", "one\n"} {
		t.Run(fmt.Sprintf("joined copy of %q", initial), func(t *testing.T) {
			f := setup(t, initial, setupOpts{})
			browser := joinAsGuest(t, f.relay, f.session.URL)
			prototest.WaitFor(t, wait, func() bool { return browser.String() == initial }, "browser to sync")
			dir := t.TempDir()
			old := unix.Umask(int(mask))
			defer unix.Umask(old)
			g, err := joinFromCLI(t, f, joinCLIOpts{JoinOptions: JoinOptions{dir: dir}})
			if err != nil {
				t.Fatal(err)
			}
			prototest.WaitFor(t, wait, func() bool { return hasContent(g.File(), initial) }, "the copy")
			checkMode(t, g.File())
			// The second save replaces the first one's file.
			browser.insert(len(initial), "two\n")
			prototest.WaitFor(t, wait, func() bool { return hasContent(g.File(), initial+"two\n") }, "the copy with the edit")
			checkMode(t, g.File())
		})
	}

	t.Run("host file deleted while sharing", func(t *testing.T) {
		f := setup(t, "one\n", setupOpts{})
		browser := joinAsGuest(t, f.relay, f.session.URL)
		prototest.WaitFor(t, wait, func() bool { return browser.String() == "one\n" }, "browser to sync")
		old := unix.Umask(int(mask))
		defer unix.Umask(old)
		if err := os.Remove(f.file); err != nil {
			t.Fatal(err)
		}
		// The next save creates the file again, as a new one.
		browser.insert(len("one\n"), "two\n")
		prototest.WaitFor(t, wait, func() bool { return hasContent(f.file, "one\ntwo\n") }, "the file to be created again")
		checkMode(t, f.file)
		browser.insert(len("one\ntwo\n"), "three\n")
		prototest.WaitFor(t, wait, func() bool { return hasContent(f.file, "one\ntwo\nthree\n") }, "the file with the next edit")
		checkMode(t, f.file)
	})
}
