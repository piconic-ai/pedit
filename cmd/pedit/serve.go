package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/signal"
	"syscall"

	"github.com/piconic-ai/pedit/internal/serve"
)

const serveUsage = `Usage: pedit serve <file> [--json] [--app <name>]

EXPERIMENTAL: the interface may change or go away.

Hold the text file's Yjs document for a local app, with no room and no relay.
The app connects to a Unix socket in a directory only you can reach (never TCP)
and speaks the y-websocket protocol (sync and awareness, unencrypted) with the
text in the Y.Text named "content", as a live room's document has it. pedit
alone writes the file, and takes in saves made by other editors as edits.

pedit prints the socket path as a line of its own, and runs until Ctrl+C or
until its standard input is closed; it then saves the file and removes the
socket and the lock. A second pedit serve on the same file is refused, naming
the process that serves it.

Options:
  --json       Print {"event":"listening","socket":"<path>"} instead of the path
  --app <name> Name the app, so a refusal can say who holds the file`

type serveArgs struct {
	file, app string
	json      bool
}

func parseServeArgs(args []string) (serveArgs, error) {
	var opts serveArgs
	var files []string
	for i := 0; i < len(args); i++ {
		switch arg := args[i]; {
		case arg == "--json":
			opts.json = true
		case arg == "--app":
			i++
			if i == len(args) || args[i] == "" {
				return opts, errors.New("--app needs a name")
			}
			opts.app = args[i]
		case arg == "--":
			files = append(files, args[i+1:]...)
			i = len(args)
		case len(arg) > 1 && arg[0] == '-':
			return opts, fmt.Errorf("unknown option: %s", arg)
		default:
			files = append(files, arg)
		}
	}
	if len(files) != 1 {
		return opts, errors.New("serve takes one file")
	}
	opts.file = files[0]
	return opts, nil
}

// serveStdin is what ends pedit serve when it closes.
var serveStdin io.Reader = os.Stdin

func runServe(args []string, stdout, stderr io.Writer) int {
	opts, err := parseServeArgs(args)
	if err != nil {
		return usageError(stderr, serveUsage, err)
	}
	s, err := serve.Open(opts.file, serve.Options{
		App:     opts.app,
		OnError: func(err error) { fmt.Fprintln(stderr, "pedit:", err) },
	})
	if err != nil {
		fmt.Fprintln(stderr, "pedit:", err)
		return 1
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	go func() {
		_, _ = io.Copy(io.Discard, serveStdin)
		cancel()
	}()

	if opts.json {
		line, _ := json.Marshal(map[string]string{"event": "listening", "socket": s.SocketPath()})
		fmt.Fprintln(stdout, string(line))
	} else {
		fmt.Fprintln(stdout, s.SocketPath())
	}
	<-ctx.Done()
	if err := s.Close(); err != nil {
		fmt.Fprintln(stderr, "pedit:", err)
		return 1
	}
	return 0
}
