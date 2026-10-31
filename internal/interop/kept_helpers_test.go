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
	// exited closes once the process has ended; err is then its Wait result.
	exited chan struct{}
	err    error
	input  io.WriteCloser
	log    string
	seen   []string
}

func keptCommand(t *testing.T, directory string, args ...string) *keptProcess {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
	cmd := exec.CommandContext(ctx, args[0], args[1:]...)
	cmd.Dir = directory
	keptGroup(cmd)
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
	p := &keptProcess{cmd: cmd, lines: make(chan string, 64), exited: make(chan struct{}), input: input, log: log.Name()}
	go func() {
		scanner := bufio.NewScanner(stdout)
		for scanner.Scan() {
			p.lines <- scanner.Text()
		}
		close(p.lines)
	}()
	go func() {
		p.err = cmd.Wait()
		close(p.exited)
	}()
	t.Cleanup(func() {
		input.Close()
		// Stop the whole group, not only wrangler's node: the workerd and
		// esbuild it starts would otherwise outlive the test (#362). A process
		// still writing into a temporary directory also fails its removal.
		stopKeptGroup(cmd, p.exited)
		cancel()
		log.Close()
	})
	return p
}

// wait returns once the process has ended, with its Wait result.
func (p *keptProcess) wait() error {
	<-p.exited
	return p.err
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
	case <-p.exited:
		if p.err != nil {
			t.Fatalf("CLI stop: %v", p.err)
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
	var relay *keptProcess
	// Cleanups run last first, so this one checks after the relay's own.
	t.Cleanup(func() {
		if relay != nil && keptGroupAlive(relay.cmd.Process.Pid) {
			t.Errorf("local relay left processes running after cleanup")
		}
	})
	relay = keptCommand(t, filepath.Join(root, "packages/worker"), binary, "dev", "--local", "--config", filepath.Join(root, "internal/interop/testdata/keep-relay/wrangler.jsonc"), "--port", fmt.Sprint(port), "--persist-to", t.TempDir())
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
