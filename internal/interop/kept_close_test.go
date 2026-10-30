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
)

// A guest edits a kept room while the host is away. `pedit --close` takes the
// edit into the file, ends the room and removes the record; the guest's next
// refresh learns that the host closed it.
func TestKeptCloseRoundTrip(t *testing.T) {
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
	guest := keptCommand(t, project, "node", filepath.Join(root, "internal/interop/testdata/kept-text.mjs"), dir, link)
	read := func() map[string]any {
		var state map[string]any
		if err := json.Unmarshal([]byte(guest.line(t)), &state); err != nil {
			t.Fatal(err)
		}
		return state
	}
	read()
	host.stop(t)
	fmt.Fprintln(guest.input, `{"append":" away"}`)
	if read()["text"] != "hello away" {
		t.Fatal("guest edit while the host is away")
	}

	closer := keptCommand(t, project, binary, "--close")
	select {
	case err := <-closer.done:
		if err != nil {
			data, _ := os.ReadFile(closer.log)
			t.Fatalf("--close: %v %s", err, data)
		}
	case <-time.After(30 * time.Second):
		t.Fatal("--close did not finish")
	}
	var out []string
	for line := range closer.lines {
		out = append(out, line)
	}
	if !strings.Contains(strings.Join(out, "\n"), "Closed the room") {
		t.Fatalf("no closing line: %q", out)
	}
	if got, _ := os.ReadFile(notes); string(got) != "hello away" {
		t.Fatalf("the file lacks the guest edit: %q", got)
	}
	fmt.Fprintln(guest.input, `{}`)
	if state := read(); state["gone"] != true || state["byHost"] != true {
		t.Fatalf("the guest was not told the host closed the room: %v", state)
	}
	again := exec.Command(binary, "--resume")
	again.Dir = project
	if output, err := again.CombinedOutput(); err == nil || !strings.Contains(string(output), "no kept room") {
		t.Fatalf("the record is still there: %s", output)
	}
}
