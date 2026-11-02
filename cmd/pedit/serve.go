package main

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"github.com/piconic-ai/pedit/internal/serve"
)

const serveUsage = `Usage: pedit serve --stdio [--root <dir>] [--app <name>] -- <file>

EXPERIMENTAL: the interface may change or go away.

Hold the text file's Yjs document for a local app, with no room and no relay.
The app starts pedit and talks to it over its standard input and output, one
stream per page, speaking the y-websocket protocol (sync and awareness,
unencrypted) with the text in the Y.Text named "content", as a live room's
document has it. pedit alone writes the file, and takes in saves made by other
editors as edits. Nothing else can reach it: no socket, no port.

stdout carries frames and nothing else; messages for people go to stderr. Each
frame is: kind (1 byte) | stream (uint32, big-endian) | length (uint32,
big-endian) | payload. The kinds are 1 open (app: one byte, 0 edit or 1 read),
2 data (both: one y-websocket message), 3 close (app: empty; pedit: a uint16
code and a reason) and 4 event (pedit: stream 0, one JSON event). Stream ids
start at 1 and only increase; at most 8 are open at once. See
docs/design/serve.md.

pedit runs until stdin is closed or Ctrl+C; it then saves the file and removes
the lock. A frame that breaks the format also ends it, with exit code 1. A
second pedit serve on the same file is refused, naming the process that serves
it.

Options:
  --stdio      Talk over stdin and stdout (required)
  --app <name> Name the app, so a refusal can say who holds the file
  --root <dir> Take <file> as a path relative to <dir>, and refuse one that
               leaves it (an absolute path, "..", or a link in a directory)

Events (JSON in event frames):
  {"event":"listening","generation":"<hex>"}  serving; the first event.
                                              generation names the document: a
                                              restart that resumed the saved
                                              state keeps it, and a document
                                              started afresh has a new one
  {"event":"saved","bytes":N}               pedit wrote the file
  {"event":"external_save"}                 a save by another editor was taken in
  {"event":"held","pid":N,"app":"<name>"}   another process serves the file
  {"event":"error","message":"<one line>"}  any other failure

Exit codes: 0 normal, 1 error, 2 usage, 3 refused because another process
serves the file.`

type serveArgs struct {
	file, app, root string
	stdio           bool
}

func parseServeArgs(args []string) (serveArgs, error) {
	var opts serveArgs
	var files []string
	for i := 0; i < len(args); i++ {
		switch arg := args[i]; {
		case arg == "--stdio":
			opts.stdio = true
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
	if !opts.stdio {
		return opts, errors.New("serve needs --stdio")
	}
	if len(files) != 1 {
		return opts, errors.New("serve takes one file")
	}
	opts.file = files[0]
	return opts, nil
}

// serveDrainWait is how long the exit waits for the app to take the frames
// still queued for it.
const serveDrainWait = 2 * time.Second

// serveStdin is what ends pedit serve when it closes.
var serveStdin io.Reader = os.Stdin

// failure reports err as an event and returns the exit code for it.
func failure(st *serve.Stdio, err error) int {
	var held *serve.HeldError
	if errors.As(err, &held) {
		st.Event("held", map[string]any{"pid": held.Holder.PID, "app": held.Holder.App})
		return 3
	}
	st.Event("error", map[string]any{"message": strings.Join(strings.Fields(err.Error()), " ")})
	return 1
}

func runServe(args []string, stdout, stderr io.Writer) int {
	opts, err := parseServeArgs(args)
	if err != nil {
		return usageError(stderr, serveUsage, err)
	}
	ignoreSIGPIPE()
	st := serve.NewStdio(stdout)
	defer st.Close(serveDrainWait)
	fail := func(err error) int {
		fmt.Fprintln(stderr, "pedit:", err)
		return failure(st, err)
	}
	so := serve.Options{
		App:            opts.app,
		OnError:        func(err error) { fmt.Fprintln(stderr, "pedit:", err) },
		OnWritten:      func(n int) { st.Event("saved", map[string]any{"bytes": n}) },
		OnExternalSave: func() { st.Event("external_save", map[string]any{}) },
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
	st.Event("listening", map[string]any{"generation": s.Generation()})
	violation := make(chan error, 1)
	go func() {
		violation <- st.Serve(s, serveStdin)
		cancel()
	}()
	<-ctx.Done()
	closeErr := s.Close()
	var broke error
	select {
	case err := <-violation:
		if err != nil {
			broke = fmt.Errorf("the app broke the framing: %w", err)
		}
	default:
	}
	// A violation and a failed last save are both reported.
	if err := errors.Join(broke, closeErr); err != nil {
		return fail(err)
	}
	return 0
}
