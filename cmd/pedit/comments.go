package main

import (
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"slices"
	"strings"
	"time"

	"github.com/piconic-ai/pedit/internal/meta"
	"github.com/piconic-ai/pedit/internal/protocol"
	"github.com/piconic-ai/pedit/internal/session"
	"github.com/piconic-ai/pedit/internal/sessiondir"
)

const commentsUsage = `Usage: pedit comments [list] [--room ID] [--file PATH] [--all] [--json]
       pedit comments reply [--room ID] [--file PATH] [--id ID] <thread> <text | ->
       pedit comments resolve|reopen [--room ID] [--file PATH] <thread>

Read and answer the comments of a room from the command line, through a
pedit session running on this machine: start one with pedit <file> --json, or
pedit <share link> --json. These commands never connect to the room
themselves. See docs/design/comments-cli.md.

  list     The open threads: id, file, where, and each comment
  reply    Add a comment to a thread; - reads the text from stdin. Prints the
           comment's id
  resolve  Resolve a thread
  reopen   Reopen a resolved thread

Options:
  --room ID    The room (or session) to use, when several sessions run
  --file PATH  The file of the thread, as the room shows it
  --all        List resolved threads too
  --json       Print the threads as JSON
  --id ID      The id of the reply (default: a new one). Run a reply again
               with the id it printed, and it is written once

Exit codes: 0 done, 1 error (nothing written), 2 usage, 3 written but not yet
confirmed as reaching the host, 4 the session took the request but did not
answer in time. After 3 or 4, the same reply with --id is safe to run again.`

// waitAnswer is how long a command waits for its session: past the 15
// seconds in which the session answers every request it takes. Tests
// shorten it.
var waitAnswer = 30 * time.Second

// sessionBase is where sessions register; tests set their own.
var sessionBase = sessiondir.Base

// commentSession is what pedit comments asks of a session.
type commentSession interface {
	Comments() []session.FileThreads
	Reply(file, thread, id, body string) (session.WriteResult, error)
	Resolve(file, thread string, resolved bool) (session.WriteResult, error)
}

type commentsArgs struct {
	op, room, file, id, thread, body string
	all, json                        bool
}

func parseCommentsArgs(args []string, stdin io.Reader) (commentsArgs, error) {
	a := commentsArgs{op: sessiondir.OpList}
	if len(args) > 0 && !strings.HasPrefix(args[0], "-") {
		switch args[0] {
		case sessiondir.OpList, sessiondir.OpReply, sessiondir.OpResolve, sessiondir.OpReopen:
			a.op, args = args[0], args[1:]
		default:
			return a, fmt.Errorf("unknown command %q", args[0])
		}
	}
	rest, err := a.takeOptions(args)
	if err != nil {
		return a, err
	}
	return a, a.takeArguments(rest, stdin)
}

// takeOptions takes the options of args, and returns the other arguments.
func (a *commentsArgs) takeOptions(args []string) ([]string, error) {
	var rest []string
	for i := 0; i < len(args); i++ {
		option, value, hasValue := strings.Cut(args[i], "=")
		if !hasValue && slices.Contains([]string{"--room", "--file", "--id"}, option) {
			i++
			value = optionValue(args, i)
		}
		var err error
		switch option {
		case "--room":
			err = setValue(&a.room, option, value)
		case "--file":
			err = setValue(&a.file, option, value)
		case "--id":
			err = setValue(&a.id, option, value)
		case "--all", "--json":
			err = a.setFlag(option, hasValue)
		case "--":
			return append(rest, args[i+1:]...), nil
		default:
			if option != "-" && strings.HasPrefix(option, "-") {
				return nil, fmt.Errorf("unknown option %s", option)
			}
			rest = append(rest, args[i])
		}
		if err != nil {
			return nil, err
		}
	}
	return rest, nil
}

func setValue(to *string, option, value string) error {
	if value == "" {
		return errors.New(option + " requires a value")
	}
	*to = value
	return nil
}

func (a *commentsArgs) setFlag(option string, hasValue bool) error {
	if hasValue {
		return errors.New(option + " takes no value")
	}
	a.all = a.all || option == "--all"
	a.json = a.json || option == "--json"
	return nil
}

// takeArguments takes the thread and the text the op needs, reading the
// text from stdin when it is -.
func (a *commentsArgs) takeArguments(rest []string, stdin io.Reader) error {
	want := map[string]int{sessiondir.OpList: 0, sessiondir.OpReply: 2, sessiondir.OpResolve: 1, sessiondir.OpReopen: 1}[a.op]
	switch {
	case len(rest) != want:
		return fmt.Errorf("%s takes %d arguments, not %d", a.op, want, len(rest))
	case a.op != sessiondir.OpList && (a.all || a.json):
		return errors.New("--all and --json are for list")
	case a.op != sessiondir.OpReply && a.id != "":
		return errors.New("--id is for reply")
	case want == 0:
		return nil
	}
	a.thread = rest[0]
	if a.op != sessiondir.OpReply {
		return nil
	}
	a.body = rest[1]
	if a.body == "-" {
		data, err := io.ReadAll(io.LimitReader(stdin, sessiondir.MaxRequestBytes))
		if err != nil {
			return err
		}
		a.body = strings.TrimSuffix(string(data), "\n")
	}
	if a.id == "" {
		a.id = newCommentID()
	}
	return nil
}

// newCommentID is a comment id as the browser makes one: 16 characters of
// base64url.
func newCommentID() string {
	var b [12]byte
	_, _ = rand.Read(b[:])
	return base64.RawURLEncoding.EncodeToString(b[:])
}

func runComments(args []string, stdout, stderr io.Writer) int {
	a, err := parseCommentsArgs(args, os.Stdin)
	if err != nil {
		return usageError(stderr, commentsUsage, err)
	}
	live, err := chooseSession(a.room)
	if err != nil {
		fmt.Fprintln(stderr, "pedit:", err)
		return 1
	}
	answer, err := live.Call(sessiondir.Request{Op: a.op, File: a.file, Thread: a.thread, Message: a.id, Body: a.body}, waitAnswer)
	switch {
	case errors.Is(err, sessiondir.ErrUnknown):
		fmt.Fprintln(stderr, "pedit:", err)
		if a.op == sessiondir.OpReply {
			fmt.Fprintf(stderr, "To try again safely: pedit comments reply --id %s %s ...\n", a.id, a.thread)
		}
		return 4
	case err != nil:
		fmt.Fprintln(stderr, "pedit:", err)
		return 1
	case !answer.OK:
		fmt.Fprintln(stderr, "pedit:", answer.Error)
		return 1
	}
	if a.op == sessiondir.OpList {
		return printThreads(stdout, answer.Threads, a.all, a.json)
	}
	if a.op == sessiondir.OpReply {
		fmt.Fprintln(stdout, answer.Message)
	}
	if answer.Delivered != nil && !*answer.Delivered {
		fmt.Fprintln(stderr, "pedit: written, but not yet confirmed as reaching the host; it is sent when the host is back")
		if a.op == sessiondir.OpReply {
			fmt.Fprintf(stderr, "To try again safely: pedit comments reply --id %s %s ...\n", a.id, a.thread)
		}
		return 3
	}
	return 0
}

// chooseSession is the session to ask: the only one running, or the one of
// room (a room or session id).
func chooseSession(room string) (sessiondir.Live, error) {
	base, err := sessionBase()
	if err != nil {
		return sessiondir.Live{}, err
	}
	all, err := sessiondir.List(base)
	if err != nil {
		return sessiondir.Live{}, err
	}
	var found []sessiondir.Live
	for _, l := range all {
		if room == "" || l.Info.Room == room || l.ID == room {
			found = append(found, l)
		}
	}
	switch {
	case len(found) == 1:
		return found[0], nil
	case len(found) == 0 && room != "":
		return sessiondir.Live{}, fmt.Errorf("no pedit session of room %s runs here", room)
	case len(found) == 0:
		return sessiondir.Live{}, errors.New("no pedit session runs here: start one with pedit <file> --json, or pedit <share link> --json")
	}
	var b strings.Builder
	b.WriteString("several pedit sessions run here; choose one with --room:")
	for _, l := range found {
		fmt.Fprintf(&b, "\n  --room %s  (session %s, %s as %s: %s)", l.Info.Room, l.ID, l.Info.Access, l.Info.Name, strings.Join(l.Info.Files, ", "))
	}
	return sessiondir.Live{}, errors.New(b.String())
}

// printThreads prints the open threads, or all with all, as pedit comments
// list does.
func printThreads(w io.Writer, threads []sessiondir.Thread, all, asJSON bool) int {
	shown := []sessiondir.Thread{}
	for _, t := range threads {
		if all || !t.Resolved {
			shown = append(shown, t)
		}
	}
	if asJSON {
		enc := json.NewEncoder(w)
		enc.SetEscapeHTML(false)
		_ = enc.Encode(shown)
		return 0
	}
	if len(shown) == 0 {
		fmt.Fprintln(w, "No open threads.")
		return 0
	}
	for i, t := range shown {
		if i > 0 {
			fmt.Fprintln(w)
		}
		where := firstLine(t.Quote)
		if t.Anchor.Type == meta.AnchorNode {
			where = "node " + t.Anchor.ID
		}
		state := ""
		if t.Resolved {
			state = " (resolved)"
		}
		fmt.Fprintf(w, "%s  %s  %q%s\n", t.Thread, t.File, where, state)
		for _, m := range t.Messages {
			fmt.Fprintf(w, "  %s, %s:\n", m.Author, m.Time)
			for _, line := range strings.Split(m.Body, "\n") {
				fmt.Fprintf(w, "    %s\n", line)
			}
		}
	}
	return 0
}

func firstLine(s string) string {
	line, _, cut := strings.Cut(s, "\n")
	if cut {
		line += "…"
	}
	return line
}

// commentsChannel lets pedit comments reach the session s while it runs, and
// returns the id it goes by and how to stop it. Without a place to register,
// the session goes on without one, and says so.
func commentsChannel(s commentSession, info sessiondir.Info, stderr io.Writer) (id string, stop func()) {
	base, err := sessionBase()
	var d *sessiondir.Dir
	if err == nil {
		d, err = sessiondir.Register(base, info)
	}
	if err == nil {
		err = d.Serve(func(r sessiondir.Request) sessiondir.Answer { return handleRequest(s, r) })
	}
	if err != nil {
		if d != nil {
			d.Close()
		}
		fmt.Fprintln(stderr, "pedit: pedit comments cannot reach this session:", err)
		return "", func() {}
	}
	return d.ID, d.Close
}

// handleRequest does what a pedit comments command asks of s.
func handleRequest(s commentSession, r sessiondir.Request) sessiondir.Answer {
	var (
		res session.WriteResult
		err error
	)
	switch r.Op {
	case sessiondir.OpList:
		return sessiondir.Answer{OK: true, Threads: threadsOf(filesNamed(s.Comments(), r.File))}
	case sessiondir.OpReply:
		res, err = s.Reply(r.File, r.Thread, r.Message, r.Body)
	case sessiondir.OpResolve, sessiondir.OpReopen:
		res, err = s.Resolve(r.File, r.Thread, r.Op == sessiondir.OpResolve)
	}
	if err != nil {
		return sessiondir.Answer{Error: err.Error()}
	}
	delivered := res.Delivered
	return sessiondir.Answer{OK: true, Message: r.Message, Delivered: &delivered}
}

// filesNamed keeps the threads of the file at path, as the room shows it,
// or of every file when path is empty.
func filesNamed(files []session.FileThreads, path string) []session.FileThreads {
	if path == "" {
		return files
	}
	var out []session.FileThreads
	for _, f := range files {
		if f.File == path {
			out = append(out, f)
		}
	}
	return out
}

func threadsOf(files []session.FileThreads) []sessiondir.Thread {
	out := []sessiondir.Thread{}
	for _, f := range files {
		for _, t := range f.Threads {
			th := sessiondir.Thread{File: f.File, Thread: t.ID, Anchor: sessiondir.Anchor{Type: t.Kind, ID: t.Node}, Quote: t.Quote, Resolved: t.Resolved, Messages: []sessiondir.Message{}}
			for _, m := range t.Messages {
				th.Messages = append(th.Messages, sessiondir.Message{ID: m.ID, Author: m.Author, Time: m.Time, Body: m.Body})
			}
			out = append(out, th)
		}
	}
	return out
}

// channelInfo is what a session tells pedit comments about itself.
func channelInfo(s *session.Session, room string, access protocol.Access, project, name string) sessiondir.Info {
	info := sessiondir.Info{PID: os.Getpid(), Room: room, Access: access.String(), Project: project, Name: name, Files: []string{}}
	for _, f := range s.Files() {
		info.Files = append(info.Files, f.Path)
	}
	return info
}

// announceSession lets pedit comments reach s, with --json, and tells the
// ready event. It returns how to stop the channel.
func announceSession(opts commandArgs, ev *events, s commentSession, info sessiondir.Info, entries []protocol.FileEntry, links map[string]string, stderr io.Writer) (stop func()) {
	if !opts.JSON {
		return func() {}
	}
	id, stop := commentsChannel(s, info, stderr)
	access := protocol.AccessEdit
	if info.Access == protocol.AccessComment.String() {
		access = protocol.AccessComment
	}
	ev.ready(id, info.Room, access, entries, links)
	return stop
}
