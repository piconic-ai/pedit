package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/signal"
	"strings"
	"sync"
	"syscall"

	"github.com/piconic-ai/pedit/internal/serve"
)

const serveUsage = `Usage: pedit serve [--root <dir>] <file> [--json] [--app <name>]

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
  --json       Print one JSON event per line instead of messages (see below)
  --app <name> Name the app, so a refusal can say who holds the file
  --root <dir> Take <file> as a path relative to <dir>, and refuse one that
               leaves it (an absolute path, "..", or a link in a directory)

With --json, stdout has these events, each on a line of its own:
  {"event":"listening","socket":"<path>"}   serving; the first event
  {"event":"saved","bytes":N}               pedit wrote the file
  {"event":"external_save"}                 a save by another editor was taken in
  {"event":"held","pid":N,"app":"<name>"}   another process serves the file
  {"event":"error","message":"<one line>"}  any other failure

Exit codes: 0 normal, 1 error, 2 usage, 3 refused because another process
serves the file.`

type serveArgs struct {
	file, app, root string
	json            bool
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
		case arg == "--root":
			i++
			if i == len(args) || args[i] == "" {
				return opts, errors.New("--root needs a directory")
			}
			opts.root = args[i]
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

// events writes the --json events, one line each, from any goroutine.
type events struct {
	json bool
	w    io.Writer
	mu   sync.Mutex
}

func (e *events) emit(event string, fields map[string]any) {
	if !e.json {
		return
	}
	fields["event"] = event
	line, _ := json.Marshal(fields)
	e.mu.Lock()
	defer e.mu.Unlock()
	fmt.Fprintln(e.w, string(line))
}

// failure reports err as an event and returns the exit code for it.
func (e *events) failure(err error) int {
	var held *serve.HeldError
	if errors.As(err, &held) {
		e.emit("held", map[string]any{"pid": held.Holder.PID, "app": held.Holder.App})
		return 3
	}
	e.emit("error", map[string]any{"message": strings.Join(strings.Fields(err.Error()), " ")})
	return 1
}

func runServe(args []string, stdout, stderr io.Writer) int {
	opts, err := parseServeArgs(args)
	if err != nil {
		return usageError(stderr, serveUsage, err)
	}
	ev := &events{json: opts.json, w: stdout}
	emit := ev.emit
	fail := func(err error) int {
		fmt.Fprintln(stderr, "pedit:", err)
		return ev.failure(err)
	}
	so := serve.Options{
		App:            opts.app,
		OnError:        func(err error) { fmt.Fprintln(stderr, "pedit:", err) },
		OnWritten:      func(n int) { emit("saved", map[string]any{"bytes": n}) },
		OnExternalSave: func() { emit("external_save", map[string]any{}) },
	}
	if opts.root != "" {
		root, err := os.OpenRoot(opts.root)
		if err != nil {
			return fail(err)
		}
		defer root.Close()
		so.Root = root
	}
	s, err := serve.Open(opts.file, so)
	if err != nil {
		return fail(err)
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
		emit("listening", map[string]any{"socket": s.SocketPath()})
	} else {
		fmt.Fprintln(stdout, s.SocketPath())
	}
	<-ctx.Done()
	if err := s.Close(); err != nil {
		return fail(err)
	}
	return 0
}
