package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/url"
	"slices"
	"strings"
	"time"

	"github.com/piconic-ai/pedit/internal/protocol"
	"github.com/piconic-ai/pedit/internal/serve"
)

// The commands an app sends to `pedit serve` as kind 5 frames (serve version
// 2, docs/design/embedding.md "Commands").
const (
	cmdShare   = "share"
	cmdUnshare = "unshare"
	cmdClose   = "close"
	cmdStatus  = "status"
	cmdKeep    = "keep"

	// Comments from the app (docs/design/embedding.md, "Comments from the app").
	cmdComment = "comment"
	cmdReply   = "reply"
	cmdResolve = "resolve"
)

// commandQueue is how many commands wait for the one that is running. The
// read loop never waits for room: a command that finds none is refused.
const commandQueue = 16

// command is one JSON object of a kind 5 frame. Fields other than cmd belong
// to share.
type command struct {
	Cmd string `json:"cmd"`
	// ID names the command; every event that answers it carries the same id.
	ID      *string  `json:"id"`
	Origins []string `json:"origins"`
	Keep    *string  `json:"keep"`
	Relay   *string  `json:"relay"`
	Choice  *string  `json:"choice"`
	// The fields of comment, reply and resolve.
	From     *int    `json:"from"`
	To       *int    `json:"to"`
	Body     *string `json:"body"`
	Thread   *string `json:"thread"`
	Resolved *bool   `json:"resolved"`
}

// hasCommentFields tells whether the command carries a field of comment,
// reply or resolve.
func (c command) hasCommentFields() bool {
	return c.From != nil || c.To != nil || c.Body != nil || c.Thread != nil || c.Resolved != nil
}

// hasShareFields tells whether the command carries a field of share or keep.
func (c command) hasShareFields() bool {
	return c.Origins != nil || c.Keep != nil || c.Relay != nil || c.Choice != nil
}

// shareRequest is a share command that passed the checks.
type shareRequest struct {
	Origins []string
	// Keep is how long the room is kept after the host leaves; 0 is a live room.
	Keep time.Duration
	// KeepSet says the command named a keep, rather than leaving the default.
	// A share that takes up a kept room changes its keep only then.
	KeepSet bool
	// Relay is empty for the default server.
	Relay string
	// Choice is what the app's user chose: "room", "app", "later" or "".
	Choice string
}

// maxCommandID is the longest id a command may carry, in bytes.
const maxCommandID = 64

type cmdIDKey struct{}

// answerWith adds the id of the command ctx runs, if it has one, to an event
// that answers it. Events nobody asked for carry none.
func answerWith(ctx context.Context, fields map[string]any) map[string]any {
	if id, ok := ctx.Value(cmdIDKey{}).(string); ok {
		fields["id"] = id
	}
	return fields
}

// sharer is what the commands act on. Its errors are answered as error events.
type sharer interface {
	Share(context.Context, shareRequest) error
	Unshare() error
	Close(context.Context) error
	// Status answers a status event; Keep changes the keep of the room shared
	// now and answers with one.
	Status(context.Context) error
	Keep(context.Context, time.Duration) error
	// Comment, Reply and Resolve write as the host while the file is shared
	// and the host is connected, and answer with an event.
	Comment(ctx context.Context, from, to int, body string) error
	Reply(ctx context.Context, thread, body string) error
	Resolve(ctx context.Context, thread string, resolved bool) error
}

// noSharer answers every command with an error, until sharing is built in.
type noSharer struct{}

var errNoSharing = errors.New("sharing is not available in this build yet")

func (noSharer) Share(context.Context, shareRequest) error { return errNoSharing }
func (noSharer) Unshare() error                            { return errNoSharing }
func (noSharer) Close(context.Context) error               { return errNoSharing }
func (noSharer) Status(context.Context) error              { return errNoSharing }
func (noSharer) Keep(context.Context, time.Duration) error { return errNoSharing }
func (noSharer) Comment(context.Context, int, int, string) error {
	return errNoSharing
}
func (noSharer) Reply(context.Context, string, string) error { return errNoSharing }
func (noSharer) Resolve(context.Context, string, bool) error { return errNoSharing }

// commandError is a command that was refused, with the command it named when
// that is one pedit knows.
type commandError struct {
	cmd string
	id  *string
	err error
}

func (e *commandError) Error() string { return e.err.Error() }

// parseCommand decodes one command strictly: unknown fields and trailing data
// are errors, and so is a field the command does not take.
//
// A share gives its request; a keep command gives one holding only its Keep.
func parseCommand(payload []byte) (command, *shareRequest, error) {
	var c command
	dec := json.NewDecoder(bytes.NewReader(payload))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&c); err != nil {
		return c, nil, &commandError{knownCmd(payload), knownID(payload), fmt.Errorf("not a command: %w", err)}
	}
	if _, err := dec.Token(); !errors.Is(err, io.EOF) {
		return c, nil, &commandError{knownCmd(payload), knownID(payload), errors.New("not a command: data after the JSON object")}
	}
	fail := func(err error) error {
		return &commandError{knownCmd(payload), c.ID, err}
	}
	if c.ID != nil && len(*c.ID) > maxCommandID {
		return c, nil, fail(fmt.Errorf("id is longer than %d bytes", maxCommandID))
	}
	var req *shareRequest
	var err error
	switch c.Cmd {
	case cmdShare:
		req, err = parseShare(c)
	case cmdUnshare, cmdClose, cmdStatus:
		if c.hasShareFields() || c.hasCommentFields() {
			err = fmt.Errorf("%s takes no fields but cmd", c.Cmd)
		}
	case cmdComment, cmdReply, cmdResolve:
		err = parseComment(c)
	case cmdKeep:
		req, err = parseKeepCommand(c)
	default:
		return c, nil, &commandError{"", c.ID, errors.New("unknown cmd")}
	}
	if err != nil {
		return c, nil, fail(err)
	}
	return c, req, nil
}

// parseKeepCommand checks a keep command: it gives a request holding only
// its Keep, which must not be 0 (a kept room cannot become live).
func parseKeepCommand(c command) (*shareRequest, error) {
	if c.Origins != nil || c.Relay != nil || c.Choice != nil || c.hasCommentFields() {
		return nil, errors.New("keep takes no fields but cmd, id and keep")
	}
	if c.Keep == nil {
		return nil, errors.New("keep: missing")
	}
	if *c.Keep == "0" {
		return nil, errors.New("keep: 0 is not allowed; a room cannot become live")
	}
	d, err := parseKeepDuration(*c.Keep)
	if err != nil {
		return nil, fmt.Errorf("keep: %w", err)
	}
	return &shareRequest{Keep: d}, nil
}

// parseComment checks the fields of a comment, reply or resolve command: those
// it takes are there, and no other is. The text of what is written is checked
// where it is written.
func parseComment(c command) error {
	if c.hasShareFields() {
		return fmt.Errorf("%s takes no share fields", c.Cmd)
	}
	want := map[string][]bool{
		cmdComment: {c.From != nil, c.To != nil, c.Body != nil},
		cmdReply:   {c.Thread != nil, c.Body != nil},
		cmdResolve: {c.Thread != nil, c.Resolved != nil},
	}[c.Cmd]
	names := map[string]string{cmdComment: "from, to and body", cmdReply: "thread and body", cmdResolve: "thread and resolved"}
	if slices.Contains(want, false) || c.givenCommentFields() != len(want) {
		return fmt.Errorf("%s takes exactly %s", c.Cmd, names[c.Cmd])
	}
	if c.Cmd == cmdComment && (*c.From < 0 || *c.To <= *c.From) {
		return errors.New("from and to must make a range that is not empty: 0 <= from < to")
	}
	return nil
}

// givenCommentFields counts the comment fields the command carries.
func (c command) givenCommentFields() int {
	n := 0
	for _, given := range []bool{c.From != nil, c.To != nil, c.Body != nil, c.Thread != nil, c.Resolved != nil} {
		if given {
			n++
		}
	}
	return n
}

// parseShare checks a share command's fields and gives its request.
func parseShare(c command) (*shareRequest, error) {
	if c.hasCommentFields() {
		return nil, errors.New("share takes no comment fields")
	}
	req := &shareRequest{Keep: defaultKeep}
	origins, err := protocol.ParseOrigins(c.Origins)
	if err != nil {
		return nil, fmt.Errorf("origins: %w", err)
	}
	req.Origins = origins
	if c.Keep != nil {
		req.KeepSet = true
		if *c.Keep == "0" {
			req.Keep = 0
		} else if req.Keep, err = parseKeepDuration(*c.Keep); err != nil {
			return nil, fmt.Errorf("keep: %w", err)
		}
	}
	if c.Relay != nil {
		if err := checkRelay(*c.Relay); err != nil {
			return nil, fmt.Errorf("relay: %w", err)
		}
		req.Relay = *c.Relay
	}
	if c.Choice != nil {
		switch *c.Choice {
		case "room", "app", "later":
			req.Choice = *c.Choice
		default:
			return nil, errors.New(`choice must be "room", "app" or "later"`)
		}
	}
	return req, nil
}

// knownCmd is the cmd of a payload if it names a command pedit knows, so that
// an error can say which command it answers; "" otherwise.
func knownCmd(payload []byte) string {
	var c struct {
		Cmd string `json:"cmd"`
	}
	_ = json.NewDecoder(bytes.NewReader(payload)).Decode(&c) // the first value only
	switch c.Cmd {
	case cmdShare, cmdUnshare, cmdClose, cmdStatus, cmdKeep, cmdComment, cmdReply, cmdResolve:
		return c.Cmd
	}
	return ""
}

// knownID is the id of a payload if it has a short string one, so that an error
// can say which command it answers; nil otherwise.
func knownID(payload []byte) *string {
	var c struct {
		ID *string `json:"id"`
	}
	_ = json.NewDecoder(bytes.NewReader(payload)).Decode(&c)
	if c.ID == nil || len(*c.ID) > maxCommandID {
		return nil
	}
	return c.ID
}

// checkRelay accepts an absolute https URL, or http on this machine, with no
// path beyond "/", no credentials, no query and no fragment.
func checkRelay(relay string) error {
	u, err := url.Parse(relay)
	if err != nil || u.Host == "" || u.Opaque != "" {
		return errors.New("must be an absolute URL")
	}
	local := u.Hostname() == "localhost" || u.Hostname() == "127.0.0.1"
	switch {
	case u.Scheme == "https" || (u.Scheme == "http" && local):
	case u.Scheme == "http":
		return errors.New("http is only for localhost and 127.0.0.1")
	default:
		return errors.New("must be an https URL")
	}
	if u.User != nil || u.RawQuery != "" || u.ForceQuery || u.Fragment != "" || strings.Contains(relay, "#") || (u.Path != "" && u.Path != "/") {
		return errors.New("must be just a scheme, host and port")
	}
	return nil
}

// commands runs the app's commands one at a time, in order, on one goroutine.
type commands struct {
	st     *serve.Stdio
	sharer sharer
	queue  chan []byte
}

func newCommands(st *serve.Stdio, sh sharer) *commands {
	return &commands{st: st, sharer: sh, queue: make(chan []byte, commandQueue)}
}

// Enqueue is Stdio's OnCommand: it never blocks the read loop.
func (c *commands) Enqueue(payload []byte) {
	select {
	case c.queue <- payload:
	default:
		c.fail("", knownID(payload), errors.New("too many commands waiting; wait for the answers"))
	}
}

// Run handles commands until ctx ends.
func (c *commands) Run(ctx context.Context) {
	for {
		select {
		case payload := <-c.queue:
			c.handle(ctx, payload)
		case <-ctx.Done():
			return
		}
	}
}

func (c *commands) fail(cmd string, id *string, err error) {
	ev := map[string]any{"cmd": cmd, "message": strings.Join(strings.Fields(err.Error()), " ")}
	if id != nil {
		ev["id"] = *id
	}
	c.st.Event("error", ev)
}

func (c *commands) handle(ctx context.Context, payload []byte) {
	cmd, req, err := parseCommand(payload)
	if err == nil {
		if cmd.ID != nil {
			ctx = context.WithValue(ctx, cmdIDKey{}, *cmd.ID)
		}
		switch cmd.Cmd {
		case cmdShare:
			err = c.sharer.Share(ctx, *req)
		case cmdUnshare:
			if err = c.sharer.Unshare(); err == nil {
				c.st.Event("unshared", answerWith(ctx, map[string]any{}))
			}
		case cmdClose:
			err = c.sharer.Close(ctx)
		case cmdStatus:
			err = c.sharer.Status(ctx)
		case cmdKeep:
			err = c.sharer.Keep(ctx, req.Keep)
		case cmdComment:
			err = c.sharer.Comment(ctx, *cmd.From, *cmd.To, strings.TrimSpace(*cmd.Body))
		case cmdReply:
			err = c.sharer.Reply(ctx, *cmd.Thread, strings.TrimSpace(*cmd.Body))
		case cmdResolve:
			err = c.sharer.Resolve(ctx, *cmd.Thread, *cmd.Resolved)
		}
		if err != nil {
			err = &commandError{cmd.Cmd, cmd.ID, err}
		}
	}
	if err != nil {
		var ce *commandError
		errors.As(err, &ce)
		c.fail(ce.cmd, ce.id, ce.err)
	}
}
