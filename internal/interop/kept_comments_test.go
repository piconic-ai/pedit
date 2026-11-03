package interop

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/piconic-ai/pedit/internal/protocol/prototest"
)

// An agent answers a comment from the command line while the host is away
// (#212): it joins the kept room with pedit <link> --json, replies with pedit
// comments reply, and the host finds the reply when it resumes.
func TestKeptRoomCommentsFromTheCommandLine(t *testing.T) {
	r := newKeptRoom(t)
	saved := `{"version":1,"path":"notes.md","comments":{"c0":{"anchor":{"type":"text","exact":"notes","prefix":"","suffix":"\n","offset":0},"quote":"notes","resolved":false,"messages":{"m0":{"author":"Host","time":"2026-10-20T00:00:00Z","body":"Which notes?"}}}}}`
	metaFile := filepath.Join(r.project, ".pedit", "meta", "notes.md.json")
	if err := os.MkdirAll(filepath.Dir(metaFile), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(metaFile, []byte(saved), 0o600); err != nil {
		t.Fatal(err)
	}
	host, link := r.host()
	host.stop(t)

	agent := r.pedit(link, "--json", "--name", "agent")
	for {
		var ev struct{ Event, Status string }
		line := agent.line(t)
		if json.Unmarshal([]byte(line), &ev) != nil {
			t.Fatalf("stdout holds more than JSON: %q\n%s", line, agent.stderr())
		}
		if ev.Event == "ready" {
			break
		}
	}
	reply := r.pedit("comments", "reply", "--id", "agentReply1", "c0", "From the agent")
	var out []string
	for line := range reply.lines {
		out = append(out, line)
	}
	if err := reply.wait(); err != nil || strings.Join(out, "\n") != "agentReply1" {
		t.Fatalf("pedit comments reply: %v %q\n%s", err, out, reply.stderr())
	}
	agent.stop(t)

	resumed := r.pedit("resume")
	resumed.link(t)
	prototest.WaitFor(t, 20*time.Second, func() bool {
		data, err := os.ReadFile(metaFile)
		return err == nil && strings.Contains(string(data), `"body": "From the agent"`) && strings.Contains(string(data), `"author": "agent"`)
	}, "the agent's reply saved by the host")
	resumed.stop(t)
}
