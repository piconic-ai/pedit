package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/signal"
	"runtime"
	"strings"
	"syscall"
	"time"

	"github.com/piconic-ai/pedit/internal/protocol"
	"github.com/piconic-ai/pedit/internal/serve"
)

const serveUsage = `Usage: pedit serve --stdio [--root <dir>] [--app <name>] [--no-update-check] -- <file>

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
code and a reason), 4 event (pedit: stream 0, one JSON event) and 5 command
(app: stream 0, one JSON object of at most 64 KiB: share, unshare or close).
share is {"cmd":"share","origins":[…],"keep":"0","relay":"<url>"} and opens a
room: live with keep "0", otherwise kept by the relay for that long after
unshare (Unix only). The shared event's keptUntil is when the relay ends a kept
room, in Unix ms, or 0 if it keeps nothing (an old relay). A file whose kept
room has another history (one pedit <file> made) is answered with a
resume_choice event; send share again with "choice": "room", "app" or "later".
The project is found as for pedit <file>, without creating a configuration.
unshare ends a live room and leaves a kept one kept, and is answered with an
unshared event. close takes in the edits
of a kept room, saves them and ends it for good, shared now or not, and is
answered with a room_ended event of reason closed; on a live room it is unshare
(an unshared event).
A bad command is answered with an error event and does not end pedit. Stream
ids start at 1 and only increase; at most 8 are open at once. See
docs/design/serve.md.

pedit runs until stdin is closed or Ctrl+C; it then saves the file and removes
the lock. A frame that breaks the format also ends it, with exit code 1. A
second pedit serve on the same file is refused, naming the process that serves
it.

Options:
  --stdio      Talk over stdin and stdout (required)
  --app <name> Name the app, so a refusal can say who holds the file
  --no-update-check
               Do not look for a newer release (at most one request a day)
  --root <dir> Take <file> as a path relative to <dir>, and refuse one that
               leaves it (an absolute path, "..", or a link in a directory)

Events (JSON in event frames):
  {"event":"listening","generation":"<hex>","version":"vX.Y.Z","serve":N}
                                            serving; the first event.
                                              generation names the document: a
                                              restart that resumed the saved
                                              state keeps it, and a document
                                              started afresh has a new one.
                                              serve is the version of this
                                              interface (see --version --json)
  {"event":"saved","bytes":N}               pedit wrote the file
  {"event":"external_save"}                 a save by another editor was taken in
  {"event":"update_available","version":"vX.Y.Z","url":"<release page>","security":false}
                                            a newer release exists; sent at
                                            most once, after listening
  {"event":"held","pid":N,"app":"<name>"}   another process serves the file
  {"event":"shared","room":"<id>","links":{"edit":"<room>.<key>","comment":"…","read":"…"},"keptUntil":0,"resumed":false}
                                            share succeeded; the app puts its
                                              page URL and "#" before a link.
                                              comment is left out when the room
                                              offers no comments
  {"event":"peers","peers":[{"name":"…","access":"edit"|"comment"|"read"}],"more":N}
                                            who is in the room, when it changed;
                                              at most 64 people, names cut to
                                              64 bytes, more counts the rest
  {"event":"unshared"}                      unshare (or close on a live room)
                                              left the room
  {"event":"room_ended","reason":"closed"|"expired"|"maintenance"}
                                            the relay ended the room, or
                                              close did; share again to open
                                              a new one
  {"event":"resume_choice","room":"<id>","choices":[{"choice":"room","text":N},{"choice":"app","text":N},{"choice":"later"}]}
                                            share found a kept room of another
                                              history; text is the characters
                                              each side holds. Answer with
                                              share and "choice"
  {"event":"error","message":"<one line>"}  any other failure
  {"event":"error","cmd":"<cmd or empty>","message":"<one line>"}
                                            a command was refused; pedit keeps
                                            serving

Exit codes: 0 normal, 1 error, 2 usage, 3 refused because another process
serves the file.`

type serveArgs struct {
	file, app, root string
	stdio           bool
	noUpdateCheck   bool
}

// serveWriteDelay is serve's write delay; zero is its default. Tests set it.
var serveWriteDelay time.Duration

func parseServeArgs(args []string) (serveArgs, error) {
	var opts serveArgs
	var files []string
	for i := 0; i < len(args); i++ {
		switch arg := args[i]; {
		case arg == "--stdio":
			opts.stdio = true
		case arg == "--no-update-check":
			opts.noUpdateCheck = true
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

// serveVersion is the version of the `pedit serve --stdio` surface: the
// framing and the events. It changes only additively within a value; an app
// checks it instead of comparing pedit versions. See docs/design/serve.md.
const serveVersion = 2

// serveUpdateCheck sends update_available once if a newer release is out. It
// is silent when the check cannot be made or fails. Development builds and CI
// are never checked.
func serveUpdateCheck(ctx context.Context, st *serve.Stdio, current string, newChecker func() (updateChecker, error)) {
	if current == "dev" || os.Getenv("CI") != "" {
		return
	}
	c, err := newChecker()
	if err != nil {
		return
	}
	r, err := c.check(ctx, current)
	if err != nil || r == nil {
		return
	}
	st.Event("update_available", map[string]any{"version": r.Version, "url": r.URL, "security": r.Security})
}

// versionJSON is what `pedit --version --json` prints: the pedit version and
// the version of each surface an app may pin.
func versionJSON() string {
	data, _ := json.Marshal(map[string]any{
		"version": getVersion(),
		"wire":    protocol.ProtocolVersion,
		"serve":   serveVersion,
		"state":   serve.StateVersion,
	})
	return string(data)
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
		WriteDelay:     serveWriteDelay,
		OnError:        func(err error) { fmt.Fprintln(stderr, "pedit:", err) },
		OnWritten:      func(n int) { st.Event("saved", map[string]any{"bytes": n}) },
		OnExternalSave: func() { st.Event("external_save", map[string]any{}) },
	}
	if runtime.GOOS != "windows" {
		// Kept rooms need Unix file permissions.
		so.RecordFor = serveRecordFor
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
	st.Event("listening", map[string]any{"generation": s.Generation(), "version": getVersion(), "serve": serveVersion})
	if !opts.noUpdateCheck {
		go serveUpdateCheck(ctx, st, getVersion(), newUpdateChecker)
	}
	// One goroutine handles the commands, so the read loop keeps the streams
	// flowing while a command is handled.
	sharer := newLiveSharer(s, st, stderr)
	cmds := newCommands(st, sharer)
	st.OnCommand = cmds.Enqueue
	cmdsDone := make(chan struct{})
	go func() {
		defer close(cmdsDone)
		cmds.Run(ctx)
	}()
	violation := make(chan error, 1)
	go func() {
		violation <- st.Serve(s, serveStdin)
		cancel()
	}()
	<-ctx.Done()
	<-cmdsDone
	// Leave the room first, so that its last edits are in the file saved below.
	_ = sharer.Unshare()
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
