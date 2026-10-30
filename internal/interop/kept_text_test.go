package interop

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/piconic-ai/pedit/internal/protocol/prototest"
)

type keptProcess struct {
	cmd   *exec.Cmd
	lines chan string
	done  chan error
	input io.WriteCloser
	log   string
}

func keptCommand(t *testing.T, directory string, args ...string) *keptProcess {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
	cmd := exec.CommandContext(ctx, args[0], args[1:]...)
	cmd.Dir = directory
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		t.Fatal(err)
	}
	input, err := cmd.StdinPipe()
	if err != nil {
		t.Fatal(err)
	}
	log, err := os.CreateTemp(t.TempDir(), "process-log")
	if err != nil {
		t.Fatal(err)
	}
	cmd.Stderr = log
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	p := &keptProcess{cmd: cmd, lines: make(chan string, 64), done: make(chan error, 1), input: input, log: log.Name()}
	go func() {
		scanner := bufio.NewScanner(stdout)
		for scanner.Scan() {
			p.lines <- scanner.Text()
		}
		close(p.lines)
	}()
	go func() { p.done <- cmd.Wait() }()
	t.Cleanup(func() { cancel(); cmd.Process.Kill(); input.Close(); log.Close() })
	return p
}
func (p *keptProcess) line(t *testing.T) string {
	t.Helper()
	select {
	case line, ok := <-p.lines:
		if !ok {
			data, _ := os.ReadFile(p.log)
			t.Fatalf("process ended before expected output: %s", data)
		}
		return line
	case <-time.After(15 * time.Second):
		t.Fatal("timed out waiting for process output")
	}
	return ""
}
func (p *keptProcess) link(t *testing.T) string {
	t.Helper()
	for i := 0; i < 20; i++ {
		for _, field := range strings.Fields(p.line(t)) {
			if strings.HasPrefix(field, "http") {
				u, err := url.Parse(field)
				if err == nil && strings.HasPrefix(u.Path, "/r/") && u.Fragment != "" {
					return field
				}
			}
		}
	}
	t.Fatal("CLI did not print a share link")
	return ""
}
func (p *keptProcess) stop(t *testing.T) string {
	t.Helper()
	if err := p.cmd.Process.Signal(os.Interrupt); err != nil {
		t.Fatal(err)
	}
	select {
	case err := <-p.done:
		if err != nil {
			t.Fatalf("CLI stop: %v", err)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("CLI did not stop")
	}
	var lines []string
	for line := range p.lines {
		lines = append(lines, line)
	}
	return strings.Join(lines, "\n")
}
func keptRelay(t *testing.T) string {
	t.Helper()
	root, err := filepath.Abs("../..")
	if err != nil {
		t.Fatal(err)
	}
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	port := listener.Addr().(*net.TCPAddr).Port
	listener.Close()
	binary := filepath.Join(root, "packages/worker/node_modules/.bin/wrangler")
	if _, err := os.Stat(binary); err != nil {
		t.Fatal("run pnpm install before kept-room interop test")
	}
	relay := keptCommand(t, filepath.Join(root, "packages/worker"), binary, "dev", "--local", "--config", filepath.Join(root, "internal/interop/testdata/keep-relay/wrangler.jsonc"), "--port", fmt.Sprint(port), "--persist-to", t.TempDir())
	go func() {
		for range relay.lines {
		}
	}()
	origin := fmt.Sprintf("http://127.0.0.1:%d", port)
	prototest.WaitFor(t, 15*time.Second, func() bool {
		r, err := http.Get(origin)
		if err != nil {
			return false
		}
		r.Body.Close()
		return true
	}, "local Worker relay")
	return origin
}
func TestKeptTextVerticalSlice(t *testing.T) {
	dir := protocolDir(t)
	relay := keptRelay(t)
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
	file := filepath.Join(project, "notes.md")
	if err := os.WriteFile(file, []byte("notes"), 0600); err != nil {
		t.Fatal(err)
	}
	host := keptCommand(t, project, binary, "--keep", "7d", "notes.md")
	link := host.link(t)
	if !strings.Contains(host.line(t), "60s") {
		t.Fatal("relay keep cap was not reported")
	}
	script := filepath.Join(root, "internal/interop/testdata/kept-text.mjs")
	old := keptCommand(t, project, "node", script, dir, link)
	type guestState struct {
		Text       string
		HostAway   bool
		KeepUntil  int64
		LogEntries int
	}
	read := func(p *keptProcess) guestState {
		t.Helper()
		var state guestState
		if err := json.Unmarshal([]byte(p.line(t)), &state); err != nil {
			t.Fatal(err)
		}
		return state
	}
	command := func(p *keptProcess, body string) guestState {
		t.Helper()
		if _, err := fmt.Fprintln(p.input, body); err != nil {
			t.Fatal(err)
		}
		return read(p)
	}
	if read(old).Text != "notes" {
		t.Fatal("initial browser document")
	}
	if got := command(old, `{"append":" online"}`); got.Text != "notes online" {
		t.Fatal("online edit")
	}
	prototest.WaitFor(t, 5*time.Second, func() bool { b, _ := os.ReadFile(file); return string(b) == "notes online" }, "online edit saved by host")
	if message := host.stop(t); !strings.Contains(message, "stays open until") {
		t.Fatal("Ctrl+C did not explain retention deadline")
	}
	away := command(old, `{"append":" away"}`)
	if away.Text != "notes online away" || !away.HostAway || away.KeepUntil <= time.Now().UnixMilli() {
		t.Fatal("existing guest cannot edit while host is away")
	}
	newcomer := keptCommand(t, project, "node", script, dir, link)
	if got := read(newcomer); got.Text != away.Text || !got.HostAway {
		t.Fatal("new guest cannot open current text while host away")
	}
	final := "notes online away newcomer"
	if got := command(newcomer, `{"append":" newcomer"}`); got.Text != final {
		t.Fatal("new guest edit")
	}
	resumed := keptCommand(t, project, binary, "--resume", link)
	resumed.link(t)
	prototest.WaitFor(t, 5*time.Second, func() bool { b, _ := os.ReadFile(file); return string(b) == final }, "all edits merged after host restart")
	if state := command(newcomer, `{"replay":true}`); state.Text != final {
		t.Fatal("replayed frame changed document")
	}
	prototest.WaitFor(t, 5*time.Second, func() bool { return command(newcomer, `{}`).LogEntries == 0 }, "relay log truncated after host save")
	resumed.stop(t)
	entries, err := os.ReadDir(filepath.Join(project, ".pedit"))
	if err != nil {
		t.Fatal(err)
	}
	credentials := 0
	for _, entry := range entries {
		if strings.HasSuffix(entry.Name(), ".keep.json") {
			credentials++
			info, err := entry.Info()
			if err != nil || info.Mode().Perm() != 0600 {
				t.Fatal("host resume state must be mode0600")
			}
		}
	}
	if credentials != 1 {
		t.Fatal("host resume state was not retained")
	}
	if err := os.WriteFile(filepath.Join(project, "expire.md"), []byte("expires"), 0600); err != nil {
		t.Fatal(err)
	}
	expiring := keptCommand(t, project, binary, "--keep", "1s", "expire.md")
	expiredLink := expiring.link(t)
	expiring.line(t)
	checkURL, _ := url.Parse(expiredLink)
	response, err := http.Get(relay + "/__test/kept/" + strings.TrimPrefix(checkURL.Path, "/r/"))
	if err != nil {
		t.Fatal(err)
	}
	var before struct{ Bytes int }
	if err := json.NewDecoder(response.Body).Decode(&before); err != nil || before.Bytes == 0 {
		response.Body.Close()
		t.Fatal("expiring room did not store ciphertext")
	}
	response.Body.Close()
	expiring.stop(t)
	expiredURL, _ := url.Parse(expiredLink)
	id := strings.TrimPrefix(expiredURL.Path, "/r/")
	prototest.WaitFor(t, 5*time.Second, func() bool {
		response, err := http.Get(relay + "/__test/kept/" + id)
		if err != nil {
			return false
		}
		defer response.Body.Close()
		var state struct{ Bytes int }
		return json.NewDecoder(response.Body).Decode(&state) == nil && state.Bytes == 0
	}, "expired room ciphertext deleted without a host or guest request")
}
