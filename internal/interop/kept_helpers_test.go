package interop

import (
	"bufio"
	"context"
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
