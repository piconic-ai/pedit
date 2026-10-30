package interop

import (
	"bufio"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
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
	seen  []string
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
	t.Cleanup(func() {
		cancel()
		cmd.Process.Kill()
		input.Close()
		// A process still writing into a temporary directory fails its removal.
		select {
		case <-p.done:
		case <-time.After(5 * time.Second):
		}
		log.Close()
	})
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
		p.seen = append(p.seen, line)
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
	// Preserve the toolchain caches before isolating the user configuration home.
	for _, key := range []string{"GOMODCACHE", "GOCACHE"} {
		if os.Getenv(key) == "" {
			raw, e := exec.Command("go", "env", key).Output()
			if e != nil {
				t.Fatal(e)
			}
			t.Setenv(key, strings.TrimSpace(string(raw)))
		}
	}
	userConfig := t.TempDir()
	t.Setenv("XDG_CONFIG_HOME", userConfig)
	if runtime.GOOS == "darwin" {
		t.Setenv("HOME", userConfig)
	}
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
	file := filepath.Join(project, "日本語😀.md")
	if err := os.WriteFile(file, []byte("notes"), 0600); err != nil {
		t.Fatal(err)
	}
	git := func(args ...string) string {
		command := exec.Command("git", args...)
		command.Dir = project
		raw, e := command.CombinedOutput()
		if e != nil {
			t.Fatalf("git %v: %s", args, raw)
		}
		return string(raw)
	}
	git("init", "-q")
	git("add", "-f", ".pedit/config.yaml", "日本語😀.md")
	beforeProjectState := git("status", "--porcelain", "--", ".pedit")
	host := keptCommand(t, project, binary, "--keep-polling", "7d", "日本語😀.md")
	link := host.link(t)
	if !strings.Contains(host.line(t), "capped keep time to 1m") {
		t.Fatal("relay keep cap was not reported")
	}
	script := filepath.Join(root, "internal/interop/testdata/kept-text.mjs")
	old := keptCommand(t, project, "node", script, dir, link)
	type guestState struct {
		Text       string
		Filename   string
		HostAway   bool
		KeepUntil  int64
		LogEntries int
		Skipped    int
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
	if got := read(old); got.Text != "notes" || got.Filename != filepath.Base(file) {
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
	if got := command(old, `{"garbage":true}`); got.Text != away.Text || got.Skipped != 1 {
		t.Fatal("invalid entry poisoned existing guest or skipped count missing")
	}
	if got := command(old, `{"extraRoot":true}`); got.Text != away.Text || got.Skipped != 2 {
		t.Fatal("unsupported signed root poisoned existing guest or skipped count missing")
	}
	newcomer := keptCommand(t, project, "node", script, dir, link)
	if got := read(newcomer); got.Text != away.Text || got.Filename != filepath.Base(file) || !got.HostAway || got.Skipped != 2 {
		t.Fatal("new guest cannot open current text while host away")
	}
	final := "notes online away newcomer"
	if got := command(newcomer, `{"append":" newcomer"}`); got.Text != final {
		t.Fatal("new guest edit")
	}
	// The host also edits the file in their own editor while away.
	if err := os.WriteFile(file, []byte("local\nnotes online"), 0600); err != nil {
		t.Fatal(err)
	}
	hostFinal := "local\n" + final
	resumed := keptCommand(t, project, binary, "--resume", link)
	resumed.link(t)
	prototest.WaitFor(t, 5*time.Second, func() bool { b, _ := os.ReadFile(file); return string(b) == hostFinal }, "local and guest edits merged after host restart")
	if state := command(newcomer, `{"replay":true}`); state.Text != final {
		t.Fatal("replayed frame changed document")
	}
	roomURL, _ := url.Parse(link)
	prototest.WaitFor(t, 5*time.Second, func() bool {
		response, err := http.Get(relay + "/__test/kept/" + strings.TrimPrefix(roomURL.Path, "/r/"))
		if err != nil {
			return false
		}
		defer response.Body.Close()
		var state struct{ Entries int }
		return json.NewDecoder(response.Body).Decode(&state) == nil && state.Entries == 0
	}, "relay log truncated after host save")
	checkpointGuest := keptCommand(t, project, "node", script, dir, link)
	if got := read(checkpointGuest); got.Text != hostFinal || got.Filename != filepath.Base(file) || got.Skipped != 0 {
		t.Fatal("brand-new browser cannot load host checkpoint after rejecting invalid roots")
	}
	if !strings.Contains(strings.Join(resumed.seen, "\n"), "Skipped 2 invalid updates.") {
		t.Fatal("CLI did not report skipped entry")
	}
	resumed.stop(t)
	if after := git("status", "--porcelain", "--", ".pedit"); after != beforeProjectState {
		t.Fatalf("kept credentials changed project git status: %q -> %q", beforeProjectState, after)
	}
	configRoot, err := os.UserConfigDir()
	if err != nil {
		t.Fatal(err)
	}
	projectAbs, err := filepath.Abs(project)
	if err != nil {
		t.Fatal(err)
	}
	projectDigest := sha256.Sum256([]byte(filepath.Clean(projectAbs)))
	stateDirectory := filepath.Join(configRoot, "pedit", "keep", hex.EncodeToString(projectDigest[:])[:16])
	entries, err := os.ReadDir(stateDirectory)
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 1 {
		t.Fatal("host resume state was not retained outside project")
	}
	info, err := entries[0].Info()
	if err != nil || info.Mode().Perm() != 0600 {
		t.Fatal("host resume state must be mode0600")
	}
	if err := os.WriteFile(filepath.Join(project, "expire.md"), []byte("expires"), 0600); err != nil {
		t.Fatal(err)
	}
	expiring := keptCommand(t, project, binary, "--keep-polling", "1s", "expire.md")
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

func TestKeptMultipleFilesRoundTrip(t *testing.T) {
	if os.Getenv("PEDIT_INTEROP") != "1" {
		t.Skip("set PEDIT_INTEROP=1")
	}
	if runtime.GOOS == "windows" {
		t.Skip("kept host requires Unix permissions")
	}
	cache, cacheErr := exec.Command("go", "env", "GOMODCACHE").Output()
	if cacheErr != nil {
		t.Fatal(cacheErr)
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
	for name, text := range map[string]string{"notes.md": "notes", "todo.md": "todo"} {
		if err := os.WriteFile(filepath.Join(project, name), []byte(text), 0600); err != nil {
			t.Fatal(err)
		}
	}
	host := keptCommand(t, project, binary, "--keep-polling", "7d", "notes.md", "todo.md")
	link := host.link(t)
	script := filepath.Join(root, "internal/interop/testdata/kept-text.mjs")
	guest := keptCommand(t, project, "node", script, dir, link)
	type state struct {
		Documents map[string]string
		Files     []struct {
			ID   uint32
			Path string
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
	if initial.HostAway || len(initial.Files) != 4 || initial.Files[0].Path != "notes.md" || initial.Files[1].Path != "todo.md" || initial.Documents["0"] != "notes" || initial.Documents["1"] != "todo" {
		t.Fatalf("host online: %+v", initial)
	}
	send(guest, `{"file":0,"append":" online"}`)
	send(guest, `{"file":1,"append":" online"}`)
	saved := func(notes, todo string) bool {
		a, _ := os.ReadFile(filepath.Join(project, "notes.md"))
		b, _ := os.ReadFile(filepath.Join(project, "todo.md"))
		return string(a) == notes && string(b) == todo
	}
	prototest.WaitFor(t, 5*time.Second, func() bool { return saved("notes online", "todo online") }, "both online files saved")
	host.stop(t)
	send(guest, `{"file":0,"append":" away"}`)
	away := send(guest, `{"file":1,"append":" away"}`)
	if !away.HostAway || away.Documents["0"] != "notes online away" || away.Documents["1"] != "todo online away" {
		t.Fatalf("away guest: %+v", away)
	}
	if !saved("notes online", "todo online") {
		t.Fatal("offline edits reached an absent host")
	}
	newcomer := keptCommand(t, project, "node", script, dir, link)
	opened := read(newcomer)
	if !opened.HostAway || opened.Documents["0"] != away.Documents["0"] || opened.Documents["1"] != away.Documents["1"] {
		t.Fatalf("offline newcomer: %+v", opened)
	}
	send(newcomer, `{"file":0,"append":" newcomer"}`)
	send(newcomer, `{"file":1,"append":" newcomer"}`)
	resumed := keptCommand(t, project, binary, "--resume", link)
	resumed.link(t)
	prototest.WaitFor(t, 5*time.Second, func() bool { return saved("notes online away newcomer", "todo online away newcomer") }, "both resumed files durably saved")
	prototest.WaitFor(t, 5*time.Second, func() bool { return send(newcomer, `{}`).LogEntries == 0 }, "bundle log truncated after all file saves")
	fresh := keptCommand(t, project, "node", script, dir, link)
	final := read(fresh)
	if final.Documents["0"] != "notes online away newcomer" || final.Documents["1"] != "todo online away newcomer" || len(final.Files) != 4 {
		t.Fatalf("new guest checkpoint: %+v", final)
	}
	send(newcomer, `{"replay":true}`)
	prototest.WaitFor(t, 5*time.Second, func() bool { return saved("notes online away newcomer", "todo online away newcomer") }, "replayed multi-file update is idempotent")
	resumed.stop(t)
}
