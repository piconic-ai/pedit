package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/url"
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
)

// commandQueue is how many commands wait for the one that is running. The
// read loop never waits for room: a command that finds none is refused.
const commandQueue = 16

// command is one JSON object of a kind 5 frame. Fields other than cmd belong
// to share.
type command struct {
	Cmd     string   `json:"cmd"`
	Origins []string `json:"origins"`
	Keep    *string  `json:"keep"`
	Relay   *string  `json:"relay"`
	Choice  *string  `json:"choice"`
}

// shareRequest is a share command that passed the checks.
type shareRequest struct {
	Origins []string
	// Keep is how long the room is kept after the host leaves; 0 is a live room.
	Keep time.Duration
	// Relay is empty for the default server.
	Relay string
	// Choice is what the app's user chose: "room", "app", "later" or "".
	Choice string
}

// sharer is what the commands act on. Its errors are answered as error events.
type sharer interface {
	Share(context.Context, shareRequest) error
	Unshare() error
	Close(context.Context) error
}

// noSharer answers every command with an error, until sharing is built in.
type noSharer struct{}

var errNoSharing = errors.New("sharing is not available in this build yet")

func (noSharer) Share(context.Context, shareRequest) error { return errNoSharing }
func (noSharer) Unshare() error                            { return errNoSharing }
func (noSharer) Close(context.Context) error               { return errNoSharing }

// commandError is a command that was refused, with the command it named when
// that is one pedit knows.
type commandError struct {
	cmd string
	err error
}

func (e *commandError) Error() string { return e.err.Error() }

// parseCommand decodes one command strictly: unknown fields and trailing data
// are errors, and so is a field the command does not take.
func parseCommand(payload []byte) (command, *shareRequest, error) {
	var c command
	dec := json.NewDecoder(bytes.NewReader(payload))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&c); err != nil {
		return c, nil, &commandError{knownCmd(payload), fmt.Errorf("not a command: %w", err)}
	}
	if _, err := dec.Token(); !errors.Is(err, io.EOF) {
		return c, nil, &commandError{knownCmd(payload), errors.New("not a command: data after the JSON object")}
	}
	fail := func(format string, args ...any) error {
		return &commandError{knownCmd(payload), fmt.Errorf(format, args...)}
	}
	switch c.Cmd {
	case cmdShare:
	case cmdUnshare, cmdClose:
		if c.Origins != nil || c.Keep != nil || c.Relay != nil || c.Choice != nil {
			return c, nil, fail("%s takes no fields but cmd", c.Cmd)
		}
		return c, nil, nil
	default:
		return c, nil, &commandError{"", errors.New("unknown cmd")}
	}
	req := &shareRequest{Keep: defaultKeep}
	origins, err := protocol.ParseOrigins(c.Origins)
	if err != nil {
		return c, nil, fail("origins: %w", err)
	}
	req.Origins = origins
	if c.Keep != nil {
		if *c.Keep == "0" {
			req.Keep = 0
		} else if req.Keep, err = parseKeepDuration(*c.Keep); err != nil {
			return c, nil, fail("keep: %w", err)
		}
	}
	if c.Relay != nil {
		if err := checkRelay(*c.Relay); err != nil {
			return c, nil, fail("relay: %w", err)
		}
		req.Relay = *c.Relay
	}
	if c.Choice != nil {
		switch *c.Choice {
		case "room", "app", "later":
			req.Choice = *c.Choice
		default:
			return c, nil, fail(`choice must be "room", "app" or "later"`)
		}
	}
	return c, req, nil
}

// knownCmd is the cmd of a payload if it names a command pedit knows, so that
// an error can say which command it answers; "" otherwise.
func knownCmd(payload []byte) string {
	var c struct {
		Cmd string `json:"cmd"`
	}
	_ = json.NewDecoder(bytes.NewReader(payload)).Decode(&c) // the first value only
	switch c.Cmd {
	case cmdShare, cmdUnshare, cmdClose:
		return c.Cmd
	}
	return ""
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
		c.fail("", errors.New("too many commands waiting; wait for the answers"))
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

func (c *commands) fail(cmd string, err error) {
	c.st.Event("error", map[string]any{"cmd": cmd, "message": strings.Join(strings.Fields(err.Error()), " ")})
}

func (c *commands) handle(ctx context.Context, payload []byte) {
	cmd, req, err := parseCommand(payload)
	if err == nil {
		switch cmd.Cmd {
		case cmdShare:
			err = c.sharer.Share(ctx, *req)
		case cmdUnshare:
			err = c.sharer.Unshare()
		case cmdClose:
			err = c.sharer.Close(ctx)
		}
		if err != nil {
			err = &commandError{cmd.Cmd, err}
		}
	}
	if err != nil {
		var ce *commandError
		errors.As(err, &ce)
		c.fail(ce.cmd, ce.err)
	}
}
