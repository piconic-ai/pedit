package interop

import (
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/piconic-ai/pedit/internal/meta"
	"github.com/piconic-ai/pedit/internal/protocol/prototest"
)

// A guest comments while the host is away; on resume the host writes the
// thread, with its anchor, to .pedit/meta/, and the shared file stays text.
func TestKeptCommentsRoundTrip(t *testing.T) {
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
	if err := os.WriteFile(notes, []byte("hello world"), 0600); err != nil {
		t.Fatal(err)
	}
	host := keptCommand(t, project, binary, "--keep", "7d", "notes.md")
	link := host.link(t)
	script := filepath.Join(root, "internal/interop/testdata/kept-text.mjs")
	guest := keptCommand(t, project, "node", script, dir, link)
	type state struct {
		Documents map[string]string
		Threads   map[string][]string
		Files     []struct {
			ID     uint32
			Path   string
			Format string
		}
		HostAway   bool
		LogEntries int
	}
	read := func(p *keptProcess) state {
		t.Helper()
		var s state
		if err := json.Unmarshal([]byte(p.line(t)), &s); err != nil {
			t.Fatal(err)
		}
		return s
	}
	send := func(p *keptProcess, command string) state {
		t.Helper()
		if _, err := fmt.Fprintln(p.input, command); err != nil {
			t.Fatal(err)
		}
		return read(p)
	}
	initial := read(guest)
	if len(initial.Files) != 2 || initial.Files[1].Format != "meta" || initial.Files[1].Path != ".pedit/meta/notes.md.json" {
		t.Fatalf("the room does not list the paired comments doc: %+v", initial.Files)
	}
	host.stop(t)
	away := send(guest, `{"thread":{"file":0,"from":6,"to":11,"quote":"world","body":"Which world?"}}`)
	if !away.HostAway || len(away.Threads[fmt.Sprint(initial.Files[1].ID)]) != 1 {
		t.Fatalf("thread while away: %+v", away)
	}
	metaName := filepath.Join(project, ".pedit/meta/notes.md.json")
	if _, err := os.Stat(metaName); err == nil {
		t.Fatal("comments reached disk while the host was away")
	}
	resumed := keptCommand(t, project, binary, "--resume", link)
	resumed.link(t)
	var written []byte
	prototest.WaitFor(t, 10*time.Second, func() bool { written, _ = os.ReadFile(metaName); return len(written) > 0 }, "comments written on resume")
	parsed, err := meta.Parse(written)
	if err != nil || len(parsed.Comments) != 1 {
		t.Fatalf("metadata file: %s (%v)", written, err)
	}
	for _, thread := range parsed.Comments {
		if thread.Anchor.Text == nil || thread.Anchor.Text.Exact != "world" || thread.Anchor.Text.Offset != 6 || thread.Messages["m1"].Body != "Which world?" {
			t.Fatalf("thread lost its anchor or comment: %s", written)
		}
	}
	if text, _ := os.ReadFile(notes); string(text) != "hello world" {
		t.Fatalf("comments reached the shared file: %q", text)
	}
	prototest.WaitFor(t, 5*time.Second, func() bool { return send(guest, `{}`).LogEntries == 0 }, "log truncated after the save")
	send(guest, `{"replay":true}`)
	time.Sleep(time.Second)
	if again, _ := os.ReadFile(metaName); string(again) != string(written) {
		t.Fatalf("replay changed the metadata file:\n%s\n%s", written, again)
	}
	resumed.stop(t)
}
