package interop

import (
	"bytes"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/piconic-ai/pedit/internal/protocol/prototest"
)

// A guest pastes an image into a kept room while the host is away. On resume
// the host finds the reference in the text, saves the image beside the file
// and only then cuts the relay log; a guest who joins later still sees it.
func TestKeptImagesRoundTrip(t *testing.T) {
	if os.Getenv("PEDIT_INTEROP") != "1" {
		t.Skip("set PEDIT_INTEROP=1")
	}
	if runtime.GOOS == "windows" {
		t.Skip("kept host requires Unix permissions")
	}
	cache, err := exec.Command("go", "env", "GOMODCACHE").Output()
	if err != nil {
		t.Fatal(err)
	}
	t.Setenv("GOMODCACHE", strings.TrimSpace(string(cache)))
	userConfig := t.TempDir()
	t.Setenv("XDG_CONFIG_HOME", userConfig)
	if runtime.GOOS == "darwin" {
		t.Setenv("HOME", userConfig)
	}
	dir, relay := protocolDir(t), keptRelay(t)
	root, err := filepath.Abs("../..")
	if err != nil {
		t.Fatal(err)
	}
	binary := filepath.Join(t.TempDir(), "pedit")
	build := exec.Command("go", "build", "-o", binary, "./cmd/pedit")
	build.Dir = root
	if output, err := build.CombinedOutput(); err != nil {
		t.Fatalf("build CLI: %v\n%s", err, output)
	}
	project := t.TempDir()
	if err := os.Mkdir(filepath.Join(project, ".pedit"), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(project, ".pedit/config.yaml"), []byte("server: "+relay+"\n"), 0600); err != nil {
		t.Fatal(err)
	}
	notes := filepath.Join(project, "notes.md")
	if err := os.WriteFile(notes, []byte("hello"), 0600); err != nil {
		t.Fatal(err)
	}
	host := keptCommand(t, project, binary, "--keep-polling", "7d", "notes.md")
	link := host.link(t)
	script := filepath.Join(root, "internal/interop/testdata/kept-text.mjs")
	guest := keptCommand(t, project, "node", script, dir, link)
	type state struct {
		Text       string
		HostAway   bool
		LogEntries int
		Image      *struct {
			Hash   string
			OK     bool
			Status int
		}
	}
	send := func(p *keptProcess, command string) state {
		t.Helper()
		if _, err := fmt.Fprintln(p.input, command); err != nil {
			t.Fatal(err)
		}
		var s state
		if err := json.Unmarshal([]byte(p.line(t)), &s); err != nil {
			t.Fatal(err)
		}
		return s
	}
	if err := json.Unmarshal([]byte(guest.line(t)), &state{}); err != nil {
		t.Fatal(err)
	}
	host.stop(t)

	png := []byte("\x89PNG\r\n\x1a\n pasted while away")
	sum := sha256.Sum256(png)
	hash := hex.EncodeToString(sum[:16])
	away := send(guest, fmt.Sprintf(`{"image":%q}`, base64.StdEncoding.EncodeToString(png)))
	reference := "![](assets/" + hash + ".png)"
	if !away.HostAway || away.Image == nil || away.Image.Hash != hash || !strings.Contains(away.Text, reference) {
		t.Fatalf("paste while away: %+v", away)
	}
	assets := filepath.Join(project, "assets", hash+".png")
	if _, err := os.Stat(assets); err == nil {
		t.Fatal("the image reached the disk while the host was away")
	}

	resumed := keptCommand(t, project, binary, "--resume", link)
	resumed.link(t)
	prototest.WaitFor(t, 10*time.Second, func() bool {
		text, _ := os.ReadFile(notes)
		saved, _ := os.ReadFile(assets)
		return strings.Contains(string(text), reference) && bytes.Equal(saved, png)
	}, "the reference and the image saved on resume")
	if info, err := os.Stat(assets); err != nil || info.Mode().Perm() != 0o600 {
		t.Fatalf("image mode: %v %v", info, err)
	}
	prototest.WaitFor(t, 5*time.Second, func() bool { return send(guest, `{}`).LogEntries == 0 }, "log truncated after the save")
	fresh := keptCommand(t, project, "node", script, dir, link)
	if err := json.Unmarshal([]byte(fresh.line(t)), &state{}); err != nil {
		t.Fatal(err)
	}
	seen := send(fresh, fmt.Sprintf(`{"fetchImage":%q}`, hash))
	if !strings.Contains(seen.Text, reference) || seen.Image == nil || !seen.Image.OK {
		t.Fatalf("a guest who joins later cannot see the image: %+v", seen)
	}
	resumed.stop(t)
}
