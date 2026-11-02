// Command fakepedit stands in for pedit in the @pedit/serve tests. It runs the
// Node script beside it (<this file>.js) with the same arguments, so one fake
// works on Windows too, where a shell script or a shebang cannot be spawned.
package main

import (
	"errors"
	"fmt"
	"os"
	"os/exec"
)

func main() {
	self, err := os.Executable()
	if err != nil {
		fail(err)
	}
	node, err := exec.LookPath("node")
	if err != nil {
		fail(err)
	}
	cmd := exec.Command(node, append([]string{self + ".js"}, os.Args[1:]...)...)
	cmd.Stdin, cmd.Stdout, cmd.Stderr = os.Stdin, os.Stdout, os.Stderr
	err = cmd.Run()
	var exit *exec.ExitError
	if errors.As(err, &exit) {
		os.Exit(exit.ExitCode())
	}
	if err != nil {
		fail(err)
	}
}

func fail(err error) {
	fmt.Fprintln(os.Stderr, err)
	os.Exit(127)
}
