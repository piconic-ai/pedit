//go:build !unix

package interop

import (
	"os/exec"
	"time"
)

// Kept-room tests skip outside Unix; these only let the package build there.

func keptGroup(*exec.Cmd) {}

func stopKeptGroup(cmd *exec.Cmd, exited <-chan struct{}) {
	cmd.Process.Kill()
	select {
	case <-exited:
	case <-time.After(5 * time.Second):
	}
}

func keptGroupAlive(int) bool { return false }
