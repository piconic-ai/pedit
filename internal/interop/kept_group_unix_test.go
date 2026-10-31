//go:build unix

package interop

import (
	"errors"
	"os/exec"
	"strconv"
	"syscall"
	"testing"
	"time"
)

// keptGrace is how long a process group has to end on SIGTERM before it is
// killed.
const keptGrace = 5 * time.Second

// keptGroup starts cmd in a process group of its own, so the processes it
// starts (wrangler's workerd and esbuild) can be signalled along with it. A
// context timeout asks the whole group to stop.
func keptGroup(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	cmd.Cancel = func() error { return syscall.Kill(-cmd.Process.Pid, syscall.SIGTERM) }
	cmd.WaitDelay = keptGrace
}

// stopKeptGroup sends SIGTERM to cmd's process group, then SIGKILL to what is
// left of it after keptGrace, and returns once no process of the group runs.
func stopKeptGroup(cmd *exec.Cmd, exited <-chan struct{}) {
	pid := cmd.Process.Pid
	syscall.Kill(-pid, syscall.SIGTERM)
	select {
	case <-exited:
	case <-time.After(keptGrace):
	}
	// Children may outlive the process that started them.
	deadline := time.Now().Add(keptGrace)
	for keptGroupAlive(pid) && time.Now().Before(deadline) {
		syscall.Kill(-pid, syscall.SIGKILL)
		time.Sleep(50 * time.Millisecond)
	}
	<-exited
}

// keptGroupAlive reports whether any process of the group led by pid runs.
func keptGroupAlive(pid int) bool {
	return !errors.Is(syscall.Kill(-pid, 0), syscall.ESRCH)
}

// A process the command starts, which also ignores SIGTERM, is gone once the
// test that started it has cleaned up.
func TestKeptCommandStopsItsGroup(t *testing.T) {
	var leader, child int
	t.Run("start", func(t *testing.T) {
		p := keptCommand(t, t.TempDir(), "sh", "-c", `trap '' TERM; sleep 300 & echo $!; wait`)
		leader = p.cmd.Process.Pid
		var err error
		if child, err = strconv.Atoi(p.line(t)); err != nil {
			t.Fatal(err)
		}
	})
	if keptGroupAlive(leader) {
		t.Errorf("process group %d still runs", leader)
	}
	if err := syscall.Kill(child, 0); !errors.Is(err, syscall.ESRCH) {
		t.Errorf("child %d still runs: %v", child, err)
	}
}
