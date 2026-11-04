package main

import (
	"bytes"
	"context"
	"encoding/binary"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"regexp"
	"runtime"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/piconic-ai/pedit/internal/protocol"
	"github.com/piconic-ai/pedit/internal/serve"
)

func TestServeHelpIsExperimental(t *testing.T) {
	var stdout, stderr strings.Builder
	if code := run([]string{"serve", "--help"}, &stdout, &stderr); code != 0 ||
		!strings.Contains(stdout.String(), "Usage: pedit serve --stdio") ||
		!strings.Contains(stdout.String(), "EXPERIMENTAL") {
		t.Fatalf("code %d\nstdout: %s\nstderr: %s", code, stdout.String(), stderr.String())
	}
}

func TestParseServeArgs(t *testing.T) {
	got, err := parseServeArgs([]string{"--stdio", "--app", "sample", "--", "a.md"})
	if err != nil || got != (serveArgs{file: "a.md", app: "sample", stdio: true}) {
		t.Fatalf("%+v %v", got, err)
	}
	if got, err := parseServeArgs([]string{"--stdio", "--", "--odd.md"}); err != nil || got.file != "--odd.md" {
		t.Fatalf("%+v %v", got, err)
	}
	for _, args := range [][]string{{"a.md"}, {"--stdio"}, {"--stdio", "a", "b"}, {"--stdio", "a", "--app"}, {"--stdio", "a", "--tcp"}, {"--stdio", "a", "--json"}} {
		if _, err := parseServeArgs(args); err == nil {
			t.Errorf("accepted %v", args)
		}
	}
	var stdout, stderr strings.Builder
	if code := run([]string{"serve"}, &stdout, &stderr); code != 2 || !strings.Contains(stderr.String(), "Usage: pedit serve") {
		t.Fatalf("code %d, stderr %s", code, stderr.String())
	}
}

type lockedBuilder struct {
	mu sync.Mutex
	b  bytes.Buffer
}

func (l *lockedBuilder) Write(p []byte) (int, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.b.Write(p)
}

func (l *lockedBuilder) String() string {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.b.String()
}

// frames parses all of out as frames; anything else fails the test.
func frames(t *testing.T, out string) []frame {
	t.Helper()
	var got []frame
	b := []byte(out)
	for len(b) > 0 {
		if len(b) < 9 {
			t.Fatalf("stdout has %d stray bytes: %q", len(b), b)
		}
		n := int(binary.BigEndian.Uint32(b[5:]))
		if len(b) < 9+n {
			t.Fatalf("frame cut short in stdout: %q", b)
		}
		got = append(got, frame{kind: b[0], stream: binary.BigEndian.Uint32(b[1:]), payload: b[9 : 9+n]})
		b = b[9+n:]
	}
	return got
}

type frame struct {
	kind    byte
	stream  uint32
	payload []byte
}

// eventFrames are the events in out, which must hold event frames only.
func eventFrames(t *testing.T, out string) []map[string]any {
	t.Helper()
	var events []map[string]any
	for _, f := range frames(t, out) {
		var e map[string]any
		if f.kind != 4 || f.stream != 0 || json.Unmarshal(f.payload, &e) != nil {
			t.Fatalf("not an event frame: %+v", f)
		}
		events = append(events, e)
	}
	return events
}

// waitFor polls out until it holds at least n events, and returns them.
func waitFor(t *testing.T, out *lockedBuilder, n int) []map[string]any {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for {
		s := out.String()
		if len(s) >= 9 {
			// Only whole frames count.
			var events []map[string]any
			b := []byte(s)
			for len(b) >= 9 && len(b) >= 9+int(binary.BigEndian.Uint32(b[5:])) {
				var e map[string]any
				_ = json.Unmarshal(b[9:9+int(binary.BigEndian.Uint32(b[5:]))], &e)
				events = append(events, e)
				b = b[9+int(binary.BigEndian.Uint32(b[5:])):]
			}
			if len(events) >= n {
				return events
			}
		}
		if time.Now().After(deadline) {
			t.Fatalf("want %d events, have %q", n, out.String())
		}
		time.Sleep(5 * time.Millisecond)
	}
}

func startServe(t *testing.T, args ...string) (stdout, stderr *lockedBuilder, stdin *io.PipeWriter, stop func() int) {
	t.Helper()
	pr, pw := io.Pipe()
	serveStdin = pr
	t.Cleanup(func() { serveStdin = os.Stdin })
	stdout, stderr = &lockedBuilder{}, &lockedBuilder{}
	done := make(chan int, 1)
	go func() { done <- run(append([]string{"serve", "--stdio"}, args...), stdout, stderr) }()
	return stdout, stderr, pw, func() int { _ = pw.Close(); return <-done }
}

func writeFile(t *testing.T, content string) string {
	t.Helper()
	file := filepath.Join(t.TempDir(), "a.md")
	if err := os.WriteFile(file, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
	return file
}

func TestServeRunsUntilStdinCloses(t *testing.T) {
	file := writeFile(t, "hi\n")
	stdout, stderr, _, stop := startServe(t, "--app", "t", "--", file)
	event := waitFor(t, stdout, 1)[0]
	if event["event"] != "listening" || event["socket"] != nil {
		t.Fatalf("event %+v", event)
	}
	if matched, _ := regexp.MatchString(`^[0-9a-f]{32}$`, event["generation"].(string)); !matched {
		t.Fatalf("generation %q, want 32 hex digits", event["generation"])
	}

	// A second one is refused, naming the first.
	var out2, err2 strings.Builder
	if code := runServe([]string{"--stdio", "--app", "second", "--", file}, &out2, &err2); code != 3 || !strings.Contains(err2.String(), `app "t"`) {
		t.Fatalf("second serve: code %d, stderr %s", code, err2.String())
	}

	if code := stop(); code != 0 {
		t.Fatalf("code %d, stderr %s", code, stderr.String())
	}
	if _, err := os.Stat(filepath.Join(filepath.Dir(file), ".a.md.pedit-lock")); !os.IsNotExist(err) {
		t.Fatalf("lock left behind: %v", err)
	}
}

func TestServeStdoutIsFramesOnly(t *testing.T) {
	file := writeFile(t, "hi\n")
	stdout, stderr, stdin, stop := startServe(t, "--", file)
	waitFor(t, stdout, 1)
	// A stream, an edit that is saved, and a close: all of it frames.
	open := []byte{1, 0, 0, 0, 1, 0, 0, 0, 1, 0}
	if _, err := stdin.Write(open); err != nil {
		t.Fatal(err)
	}
	waitFor(t, stdout, 2)
	if err := os.WriteFile(file, []byte("hi there\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(5 * time.Second)
	for !strings.Contains(stdout.String(), "external_save") && time.Now().Before(deadline) {
		time.Sleep(5 * time.Millisecond)
	}
	if code := stop(); code != 0 {
		t.Fatalf("code %d, stderr %s", code, stderr.String())
	}
	kinds := map[byte]int{}
	for _, f := range frames(t, stdout.String()) {
		kinds[f.kind]++
	}
	if kinds[4] < 2 || kinds[2] == 0 {
		t.Fatalf("kinds %v: want events and data", kinds)
	}
}

func TestServeFormatViolationExitsOneAfterSaving(t *testing.T) {
	file := writeFile(t, "hi\n")
	stdout, stderr, stdin, stop := startServe(t, "--", file)
	waitFor(t, stdout, 1)
	if _, err := stdin.Write([]byte{9, 0, 0, 0, 1, 0, 0, 0, 0}); err != nil {
		t.Fatal(err)
	}
	if code := stop(); code != 1 || !strings.Contains(stderr.String(), "framing") {
		t.Fatalf("code %d, stderr %s", code, stderr.String())
	}
	if _, err := os.Stat(filepath.Join(filepath.Dir(file), ".a.md.pedit-lock")); !os.IsNotExist(err) {
		t.Fatalf("lock left behind: %v", err)
	}
	events := eventFrames(t, stdout.String())
	if last := events[len(events)-1]; last["event"] != "error" {
		t.Fatalf("events %v", events)
	}
}

func TestServeEventsInOrder(t *testing.T) {
	file := writeFile(t, "hi\n")
	stdout, stderr, _, stop := startServe(t, "--", file)
	waitFor(t, stdout, 1)
	if err := os.WriteFile(file, []byte("hi there\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	waitFor(t, stdout, 2)
	if code := stop(); code != 0 {
		t.Fatalf("code %d, stderr %s", code, stderr.String())
	}
	if got := eventFrames(t, stdout.String()); got[0]["event"] != "listening" || got[1]["event"] != "external_save" {
		t.Fatalf("events %v", got)
	}
}

func TestServeErrorEventExitsOne(t *testing.T) {
	var stdout, stderr bytes.Buffer
	missing := filepath.Join(t.TempDir(), "missing.md")
	if code := runServe([]string{"--stdio", "--", missing}, &stdout, &stderr); code != 1 {
		t.Fatalf("code %d", code)
	}
	e := eventFrames(t, stdout.String())
	msg, _ := e[0]["message"].(string)
	if len(e) != 1 || e[0]["event"] != "error" || msg == "" || strings.Contains(msg, "\n") {
		t.Fatalf("events %v", e)
	}
}

func TestServeHeldEventExitsThree(t *testing.T) {
	file := writeFile(t, "hi\n")
	stdout, _, _, stop := startServe(t, "--app", "first", "--", file)
	waitFor(t, stdout, 1)
	var out2 bytes.Buffer
	var err2 strings.Builder
	if code := runServe([]string{"--stdio", "--", file}, &out2, &err2); code != 3 {
		t.Fatalf("code %d, stderr %s", code, err2.String())
	}
	e := eventFrames(t, out2.String())
	if len(e) != 1 || e[0]["event"] != "held" || e[0]["app"] != "first" || e[0]["pid"] != float64(os.Getpid()) {
		t.Fatalf("events %v", e)
	}
	stop()
}

func TestServeRootRefusesPathsOutside(t *testing.T) {
	base := t.TempDir()
	root, outside := filepath.Join(base, "root"), filepath.Join(base, "outside")
	for _, d := range []string{root, outside, filepath.Join(root, "sub")} {
		if err := os.MkdirAll(d, 0o755); err != nil {
			t.Fatal(err)
		}
	}
	for _, f := range []string{filepath.Join(base, "x"), filepath.Join(outside, "y.md"), filepath.Join(root, "sub", "ok.md")} {
		if err := os.WriteFile(f, []byte("hi\n"), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.Symlink(outside, filepath.Join(root, "link")); err != nil {
		t.Skip("no symlinks:", err)
	}
	for _, name := range []string{"../x", filepath.Join(base, "x"), "link/y.md"} {
		var stdout bytes.Buffer
		var stderr strings.Builder
		code := runServe([]string{"--stdio", "--root", root, "--", name}, &stdout, &stderr)
		if code != 1 || !strings.Contains(stderr.String(), "is outside") || !strings.Contains(stdout.String(), "error") {
			t.Errorf("%s: code %d, stdout %q, stderr %q", name, code, stdout.String(), stderr.String())
		}
	}

	stdout, stderr, _, stop := startServe(t, "--root", root, "--", filepath.Join("sub", "ok.md"))
	waitFor(t, stdout, 1)
	if _, err := os.Stat(filepath.Join(root, "sub", ".ok.md.pedit-lock")); err != nil {
		t.Error(err)
	}
	if code := stop(); code != 0 {
		t.Fatalf("code %d, stderr %s", code, stderr.String())
	}
}

// runMainEnv makes the test binary run the CLI's entry point instead of the tests.
const runMainEnv = "PEDIT_TEST_RUN_MAIN"

func TestMain(m *testing.M) {
	// A test may start this binary as pedit itself: no go build, no network.
	if os.Getenv(runMainEnv) == "1" {
		os.Exit(run(os.Args[1:], os.Stdout, os.Stderr))
	}
	// serve keeps its state under the user's config directory: not the real one.
	dir, err := os.MkdirTemp("", "pedit-cmd-test")
	if err != nil {
		panic(err)
	}
	_ = os.Setenv("HOME", dir)
	_ = os.Setenv("XDG_CONFIG_HOME", filepath.Join(dir, "xdg"))
	code := m.Run()
	_ = os.RemoveAll(dir)
	os.Exit(code)
}

func TestServeGenerationSurvivesARestart(t *testing.T) {
	file := writeFile(t, "hi\n")
	var seen []any
	for range 2 {
		stdout, stderr, _, stop := startServe(t, "--", file)
		g := waitFor(t, stdout, 1)[0]["generation"]
		if code := stop(); code != 0 {
			t.Fatalf("code %d, stderr %s", code, stderr.String())
		}
		seen = append(seen, g)
	}
	if seen[0] == "" || seen[0] != seen[1] {
		t.Fatalf("generations %q, want the same twice", seen)
	}
}

// The app that started pedit serve may exit first, closing the pipes it read
// stdout and stderr from. A later event (here: an external save, which is
// reported as `external_save`) is then a write to a broken pipe, which must
// not end pedit with SIGPIPE: it goes on, and ends normally when stdin closes.
func TestServeSurvivesAParentThatStoppedReading(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("SIGPIPE is a Unix signal")
	}
	// The test binary re-executed as pedit: same run() as main, in its own process.
	bin, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	dir := t.TempDir()
	file := filepath.Join(dir, "a.md")
	if err := os.WriteFile(file, []byte("hi\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	cmd := exec.Command(bin, "serve", "--stdio", "--app", "t", "--", file)
	cmd.Env = append(os.Environ(), "HOME="+t.TempDir(), runMainEnv+"=1")
	stdin, err := cmd.StdinPipe()
	if err != nil {
		t.Fatal(err)
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		t.Fatal(err)
	}
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	var first [4096]byte
	n, err := stdout.Read(first[:])
	if err != nil || !strings.Contains(string(first[:n]), "listening") {
		t.Fatalf("first line %q: %v", first[:n], err)
	}
	// The parent is gone: nobody reads stdout any more.
	_ = stdout.Close()
	// A save by another editor makes pedit report external_save to the broken pipe.
	tmp := filepath.Join(dir, ".a.md.tmp")
	if err := os.WriteFile(tmp, []byte("hi there\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.Rename(tmp, file); err != nil {
		t.Fatal(err)
	}
	time.Sleep(500 * time.Millisecond)
	_ = stdin.Close()
	done := make(chan error, 1)
	go func() { done <- cmd.Wait() }()
	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("pedit serve ended with %v, want a normal exit", err)
		}
	case <-time.After(10 * time.Second):
		_ = cmd.Process.Kill()
		t.Fatal("pedit serve did not end after stdin closed")
	}
	if _, err := os.Stat(filepath.Join(dir, ".a.md.pedit-lock")); !os.IsNotExist(err) {
		t.Fatalf("lock left behind: %v", err)
	}
}

func TestVersionJSON(t *testing.T) {
	var stdout, stderr bytes.Buffer
	if code := run([]string{"--version", "--json"}, &stdout, &stderr); code != 0 {
		t.Fatalf("code %d, stderr %s", code, stderr.String())
	}
	var got map[string]any
	if err := json.Unmarshal(stdout.Bytes(), &got); err != nil {
		t.Fatalf("%q: %v", stdout.String(), err)
	}
	want := map[string]any{"version": getVersion(), "wire": float64(protocol.ProtocolVersion), "serve": float64(serveVersion), "state": float64(serve.StateVersion)}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got %v, want %v", got, want)
	}
	if bytes.Count(stdout.Bytes(), []byte("\n")) != 1 {
		t.Fatalf("want one line, got %q", stdout.String())
	}
}

func TestServeListeningReportsVersionAndSurface(t *testing.T) {
	stdout, _, _, stop := startServe(t, "--no-update-check", "--", writeFile(t, "hi\n"))
	got := waitFor(t, stdout, 1)[0]
	stop()
	if got["event"] != "listening" || got["version"] != getVersion() || got["serve"] != float64(serveVersion) {
		t.Fatalf("listening = %v", got)
	}
}

// fakeRelease serves a newer release and counts the requests.
func fakeRelease(t *testing.T, body string) (newChecker func() (updateChecker, error), requests *atomic.Int32) {
	t.Helper()
	requests = new(atomic.Int32)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests.Add(1)
		_ = json.NewEncoder(w).Encode(release{Version: "v9.9.9", URL: "https://example.test/v9.9.9", Body: body})
	}))
	t.Cleanup(srv.Close)
	return func() (updateChecker, error) { return testChecker(t, srv.URL, time.Now()), nil }, requests
}

func TestServeUpdateCheckEmitsUpdateAvailable(t *testing.T) {
	t.Setenv("CI", "")
	newChecker, _ := fakeRelease(t, "## Security\n* fix\n")
	var out lockedBuilder
	st := serve.NewStdio(&out)
	serveUpdateCheck(context.Background(), st, "v0.0.1", newChecker)
	st.Close(time.Second)
	got := eventFrames(t, out.String())
	want := map[string]any{"event": "update_available", "version": "v9.9.9", "url": "https://example.test/v9.9.9", "security": true}
	if len(got) != 1 || !reflect.DeepEqual(got[0], want) {
		t.Fatalf("events %v", got)
	}
}

func TestServeUpdateCheckSkips(t *testing.T) {
	newChecker, requests := fakeRelease(t, "")
	t.Setenv("CI", "")
	for name, current := range map[string]string{"dev": "dev", "up to date": "v9.9.9"} {
		var out lockedBuilder
		st := serve.NewStdio(&out)
		serveUpdateCheck(context.Background(), st, current, newChecker)
		st.Close(time.Second)
		if got := eventFrames(t, out.String()); len(got) != 0 {
			t.Errorf("%s: events %v", name, got)
		}
	}
	if requests.Load() != 1 { // only "up to date" asks
		t.Errorf("requests = %d, want 1", requests.Load())
	}
	t.Setenv("CI", "true")
	var out lockedBuilder
	st := serve.NewStdio(&out)
	serveUpdateCheck(context.Background(), st, "v0.0.1", newChecker)
	st.Close(time.Second)
	if got := eventFrames(t, out.String()); len(got) != 0 || requests.Load() != 1 {
		t.Errorf("CI: events %v, requests %d", got, requests.Load())
	}
}

func TestServeFlagNoUpdateCheck(t *testing.T) {
	opts, err := parseServeArgs([]string{"--stdio", "--no-update-check", "f"})
	if err != nil || !opts.noUpdateCheck {
		t.Fatalf("%+v, %v", opts, err)
	}
}
