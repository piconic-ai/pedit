//go:build unix

package attach

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"testing"

	"github.com/piconic-ai/pedit/internal/protocol"
	"golang.org/x/sys/unix"
)

func TestPrivateAttachmentPermissions(t *testing.T) {
	const marker = "PEDIT_TEST_ATTACHMENT_UMASK"
	if value := os.Getenv(marker); value != "" {
		mask, err := strconv.ParseUint(value, 8, 32)
		if err != nil {
			t.Fatal(err)
		}
		dir := t.TempDir()
		// Existing traversable directories must not defeat file privacy.
		if err := os.Chmod(dir, 0o755); err != nil {
			t.Fatal(err)
		}
		assets := filepath.Join(dir, Dir)
		if err := os.Mkdir(assets, 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.Chmod(assets, 0o755); err != nil {
			t.Fatal(err)
		}
		unix.Umask(int(mask))
		root, err := os.OpenRoot(dir)
		if err != nil {
			t.Fatal(err)
		}
		defer root.Close()
		a := &Attachments{root: root}
		rel, _, err := a.save(protocol.ContentHash(png), ".png", png)
		if err != nil {
			t.Fatal(err)
		}
		info, err := os.Stat(filepath.Join(dir, filepath.FromSlash(rel)))
		if err != nil {
			t.Fatal(err)
		}
		want := os.FileMode(0o600) &^ os.FileMode(mask)
		if info.Mode().Perm() != want {
			t.Fatalf("mode = %o, want %o", info.Mode().Perm(), want)
		}
		return
	}
	for _, mask := range []int{0, 0o022, 0o077, 0o777} {
		t.Run(fmt.Sprintf("umask=%03o", mask), func(t *testing.T) {
			cmd := exec.Command(os.Args[0], "-test.run=^TestPrivateAttachmentPermissions$")
			cmd.Env = append(os.Environ(), fmt.Sprintf("%s=%03o", marker, mask))
			if out, err := cmd.CombinedOutput(); err != nil {
				t.Fatalf("%v\n%s", err, out)
			}
		})
	}
}
