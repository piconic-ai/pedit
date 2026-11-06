package main

import (
	"bytes"
	"context"
	"encoding/binary"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/piconic-ai/pedit/internal/serve"
)

func TestParseCommand(t *testing.T) {
	ok := []struct {
		name, in string
		want     shareRequest
		cmd      string
	}{
		{"share with defaults", `{"cmd":"share"}`, shareRequest{Keep: defaultKeep}, "share"},
		{"all fields", `{"cmd":"share","origins":["https://a.com","https://a.com","http://localhost:3000"],"keep":"7d","relay":"https://r.example.com/","choice":"app"}`,
			shareRequest{Origins: []string{"https://a.com", "http://localhost:3000"}, Keep: 7 * 24 * time.Hour, Relay: "https://r.example.com/", Choice: "app"}, "share"},
		{"keep 0 is live", `{"cmd":"share","keep":"0"}`, shareRequest{Keep: 0}, "share"},
		{"keep seconds", `{"cmd":"share","keep":"90s"}`, shareRequest{Keep: 90 * time.Second}, "share"},
		{"local relay", `{"cmd":"share","relay":"http://127.0.0.1:8787"}`, shareRequest{Keep: defaultKeep, Relay: "http://127.0.0.1:8787"}, "share"},
		{"localhost relay without port", `{"cmd":"share","relay":"http://localhost"}`, shareRequest{Keep: defaultKeep, Relay: "http://localhost"}, "share"},
		{"choice room", `{"cmd":"share","choice":"room"}`, shareRequest{Keep: defaultKeep, Choice: "room"}, "share"},
		{"choice later", `{"cmd":"share","choice":"later"}`, shareRequest{Keep: defaultKeep, Choice: "later"}, "share"},
		{"unshare", `{"cmd":"unshare"}`, shareRequest{}, "unshare"},
		{"close", ` {"cmd":"close"} `, shareRequest{}, "close"},
	}
	for _, c := range ok {
		t.Run(c.name, func(t *testing.T) {
			cmd, req, err := parseCommand([]byte(c.in))
			if err != nil || cmd.Cmd != c.cmd {
				t.Fatalf("%+v, %v", cmd, err)
			}
			if c.cmd != "share" {
				return
			}
			if !slices.Equal(req.Origins, c.want.Origins) || req.Keep != c.want.Keep || req.Relay != c.want.Relay || req.Choice != c.want.Choice {
				t.Fatalf("got %+v, want %+v", *req, c.want)
			}
		})
	}

	bad := []struct{ name, in, cmd, msg string }{
		{"not JSON", `share`, "", "not a command"},
		{"empty", ``, "", "not a command"},
		{"not an object", `["share"]`, "", "not a command"},
		{"no cmd", `{}`, "", "unknown cmd"},
		{"unknown cmd", `{"cmd":"explode"}`, "", "unknown cmd"},
		{"cmd of another type", `{"cmd":1}`, "", "not a command"},
		{"unknown field", `{"cmd":"share","port":1}`, "share", "unknown field"},
		{"trailing data", `{"cmd":"share"} {"cmd":"close"}`, "share", "data after"},
		{"trailing junk", `{"cmd":"close"}x`, "close", "data after"},
		{"unshare with a field", `{"cmd":"unshare","origins":[]}`, "unshare", "takes no fields"},
		{"close with a field", `{"cmd":"close","keep":"1d"}`, "close", "takes no fields"},
		{"origins not a list", `{"cmd":"share","origins":"https://a.com"}`, "share", "not a command"},
		{"five origins", `{"cmd":"share","origins":["https://a.com","https://b.com","https://c.com","https://d.com","https://e.com"]}`, "share", "origins"},
		{"http origin", `{"cmd":"share","origins":["http://a.com"]}`, "share", "origins"},
		{"origin with a path", `{"cmd":"share","origins":["https://a.com/x"]}`, "share", "origins"},
		{"keep nonsense", `{"cmd":"share","keep":"soon"}`, "share", "keep"},
		{"keep zero days", `{"cmd":"share","keep":"0d"}`, "share", "keep"},
		{"keep negative", `{"cmd":"share","keep":"-1h"}`, "share", "keep"},
		{"keep empty", `{"cmd":"share","keep":""}`, "share", "keep"},
		{"relay http", `{"cmd":"share","relay":"http://r.example.com"}`, "share", "relay"},
		{"relay relative", `{"cmd":"share","relay":"/x"}`, "share", "relay"},
		{"relay with a path", `{"cmd":"share","relay":"https://r.example.com/x"}`, "share", "relay"},
		{"relay with userinfo", `{"cmd":"share","relay":"https://u@r.example.com"}`, "share", "relay"},
		{"relay with a query", `{"cmd":"share","relay":"https://r.example.com/?a=1"}`, "share", "relay"},
		{"relay with a fragment", `{"cmd":"share","relay":"https://r.example.com/#k"}`, "share", "relay"},
		{"relay other scheme", `{"cmd":"share","relay":"ftp://r.example.com"}`, "share", "relay"},
		{"relay empty", `{"cmd":"share","relay":""}`, "share", "relay"},
		{"choice unknown", `{"cmd":"share","choice":"now"}`, "share", "choice"},
	}
	for _, c := range bad {
		t.Run(c.name, func(t *testing.T) {
			_, _, err := parseCommand([]byte(c.in))
			ce, isCE := err.(*commandError)
			if !isCE || ce.cmd != c.cmd || !strings.Contains(ce.err.Error(), c.msg) {
				t.Fatalf("got %#v, want cmd %q and %q", err, c.cmd, c.msg)
			}
		})
	}
}

// recorder is a sharer that notes what it was asked.
type recorder struct {
	calls []string
	err   error
}

func (r *recorder) Share(_ context.Context, q shareRequest) error {
	r.calls = append(r.calls, "share "+q.Choice)
	return r.err
}
func (r *recorder) Unshare() error              { r.calls = append(r.calls, "unshare"); return r.err }
func (r *recorder) Close(context.Context) error { r.calls = append(r.calls, "close"); return r.err }

func runCommands(t *testing.T, sh sharer, payloads ...string) []map[string]any {
	t.Helper()
	var out lockedBuilder
	st := serve.NewStdio(&out)
	cmds := newCommands(st, sh)
	for _, p := range payloads {
		cmds.handle(context.Background(), []byte(p))
	}
	st.Close(time.Second)
	return eventFrames(t, out.String())
}

func TestCommandsGoToTheSharerAndErrorsAreEvents(t *testing.T) {
	r := &recorder{}
	events := runCommands(t, r, `{"cmd":"share","choice":"later"}`, `{"cmd":"unshare"}`, `{"cmd":"close"}`, `{"cmd":"share","keep":"x"}`, `nope`)
	if want := []string{"share later", "unshare", "close"}; !slices.Equal(r.calls, want) {
		t.Fatalf("calls %v", r.calls)
	}
	if len(events) != 2 || events[0]["event"] != "error" || events[0]["cmd"] != "share" || events[1]["cmd"] != "" {
		t.Fatalf("events %v", events)
	}
	for _, e := range events {
		if msg, _ := e["message"].(string); msg == "" || strings.Contains(msg, "\n") {
			t.Fatalf("message in %v", e)
		}
	}
}

func TestSharerErrorsNameTheCommand(t *testing.T) {
	events := runCommands(t, noSharer{}, `{"cmd":"share"}`, `{"cmd":"unshare"}`, `{"cmd":"close"}`)
	if len(events) != 3 {
		t.Fatalf("events %v", events)
	}
	for i, cmd := range []string{"share", "unshare", "close"} {
		if events[i]["event"] != "error" || events[i]["cmd"] != cmd || events[i]["message"] != "sharing is not available in this build yet" {
			t.Fatalf("events %v", events)
		}
	}
}

func TestCommandsAreHandledInOrderAndOnlyOneAtATime(t *testing.T) {
	var out lockedBuilder
	st := serve.NewStdio(&out)
	block := make(chan struct{})
	r := &blocking{block: block}
	cmds := newCommands(st, r)
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() { cmds.Run(ctx); close(done) }()
	cmds.Enqueue([]byte(`{"cmd":"share","choice":"room"}`)) // blocks in Share
	cmds.Enqueue([]byte(`{"cmd":"unshare"}`))
	time.Sleep(50 * time.Millisecond)
	if r.count() != 1 {
		t.Fatalf("a second command ran while the first was handled: %v", r.log())
	}
	close(block)
	deadline := time.Now().Add(5 * time.Second)
	for r.count() < 2 && time.Now().Before(deadline) {
		time.Sleep(5 * time.Millisecond)
	}
	cancel()
	<-done
	if got := r.log(); !slices.Equal(got, []string{"share room", "unshare"}) {
		t.Fatalf("log %v", got)
	}
	st.Close(time.Second)
}

func TestEnqueueRefusesInsteadOfBlockingWhenTheQueueIsFull(t *testing.T) {
	var out lockedBuilder
	st := serve.NewStdio(&out)
	cmds := newCommands(st, noSharer{}) // no Run: nothing takes commands off
	for range commandQueue + 1 {
		cmds.Enqueue([]byte(`{"cmd":"close"}`))
	}
	st.Close(time.Second)
	events := eventFrames(t, out.String())
	if len(events) != 1 || events[0]["event"] != "error" || events[0]["cmd"] != "" {
		t.Fatalf("events %v", events)
	}
}

func TestServeAnswersABadCommandAndKeepsServing(t *testing.T) {
	file := writeFile(t, "hi\n")
	stdout, stderr, stdin, stop := startServe(t, "--no-update-check", "--", file)
	waitFor(t, stdout, 1)
	send := func(kind byte, stream uint32, payload []byte) {
		t.Helper()
		b := []byte{kind, 0, 0, 0, 0, 0, 0, 0, 0}
		binary.BigEndian.PutUint32(b[1:], stream)
		binary.BigEndian.PutUint32(b[5:], uint32(len(payload)))
		if _, err := stdin.Write(append(b, payload...)); err != nil {
			t.Fatal(err)
		}
	}
	send(5, 0, []byte(`{"cmd":"share","bogus":1}`))
	events := waitFor(t, stdout, 2)
	if events[1]["event"] != "error" || events[1]["cmd"] != "share" || !strings.Contains(events[1]["message"].(string), "unknown field") {
		t.Fatalf("events %v", events)
	}
	send(5, 0, []byte(`{"cmd":"unshare"}`))
	events = waitFor(t, stdout, 3)
	if events[2]["cmd"] != "unshare" || !strings.Contains(events[2]["message"].(string), "not shared") {
		t.Fatalf("events %v", events)
	}
	// A stream still works: a sync step 1 is answered with data frames.
	send(1, 1, []byte{0})
	send(2, 1, []byte{0, 1, 0})
	deadline := time.Now().Add(5 * time.Second)
	for {
		data := 0
		for _, f := range frames(t, trimToFrames(stdout.String())) {
			if f.kind == 2 && f.stream == 1 {
				data++
			}
		}
		if data > 0 {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("no data on the stream: %q", stdout.String())
		}
		time.Sleep(5 * time.Millisecond)
	}
	if code := stop(); code != 0 {
		t.Fatalf("code %d, stderr %s", code, stderr.String())
	}
}

func TestServeCommandFrameOffStreamZeroEndsTheChild(t *testing.T) {
	file := writeFile(t, "hi\n")
	stdout, stderr, stdin, stop := startServe(t, "--no-update-check", "--", file)
	waitFor(t, stdout, 1)
	if _, err := stdin.Write([]byte{5, 0, 0, 0, 1, 0, 0, 0, 2, '{', '}'}); err != nil {
		t.Fatal(err)
	}
	if code := stop(); code != 1 || !strings.Contains(stderr.String(), "framing") {
		t.Fatalf("code %d, stderr %s", code, stderr.String())
	}
}

// blocking is a sharer whose Share waits for block.
type blocking struct {
	block chan struct{}
	mu    sync.Mutex
	calls []string
}

func (b *blocking) note(s string) {
	b.mu.Lock()
	b.calls = append(b.calls, s)
	b.mu.Unlock()
}
func (b *blocking) count() int { return len(b.log()) }
func (b *blocking) log() []string {
	b.mu.Lock()
	defer b.mu.Unlock()
	return slices.Clone(b.calls)
}
func (b *blocking) Share(_ context.Context, q shareRequest) error {
	b.note("share " + q.Choice)
	<-b.block
	return nil
}
func (b *blocking) Unshare() error              { b.note("unshare"); return nil }
func (b *blocking) Close(context.Context) error { b.note("close"); return nil }

// trimToFrames drops a partly written last frame from out.
func trimToFrames(out string) string {
	b := []byte(out)
	n := 0
	for len(b[n:]) >= 9 {
		l := 9 + int(binary.BigEndian.Uint32(b[n+5:]))
		if len(b[n:]) < l {
			break
		}
		n += l
	}
	return string(bytes.Clone(b[:n]))
}
