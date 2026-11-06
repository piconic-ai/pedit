package main

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/piconic-ai/pedit/internal/protocol"
	"github.com/piconic-ai/pedit/internal/session"
)

const cmsOrigin = "https://cms.example.com"

// shareKeptAt shares with a keep and the CMS origin, at the test's relay.
func (a *app) shareKeptAt(env *shareEnv, origins string) map[string]any {
	a.t.Helper()
	return a.shareKept(fmt.Sprintf(`,"relay":%q,"origins":[%q]`, env.server.URL, origins))
}

func keptEnv(t *testing.T) *shareEnv {
	t.Helper()
	if runtime.GOOS == "windows" {
		t.Skip("kept rooms need Unix file permissions")
	}
	env := newShareEnv(t)
	env.relay.Keep = 3600
	return env
}

func TestServeShareResumesAKeptRoomOnceInOneHistory(t *testing.T) {
	env := keptEnv(t)
	file := writeFile(t, "hello\n")
	a := startApp(t, file)
	generation := a.event("listening", 1)["generation"]
	first := a.shareKeptAt(env, cmsOrigin)
	room := first["room"].(string)

	// The app's page edits, and a guest's; the file holds both.
	page := a.openPage(1)
	eventually(t, "the page's text", func() bool { return page.get() == "hello\n" })
	page.insert(0, "app: ")
	g := env.join(t, linkOf(first, "edit"), "ada")
	eventually(t, "the guest sees the page's edit", func() bool { return guestText(g) == "app: hello\n" })
	guestInsert(g, len("app: hello\n"), "guest\n")
	eventually(t, "the file", func() bool { return holds(file, "app: hello\nguest\n") })

	a.command(`{"cmd":"unshare"}`)
	eventually(t, "the guest sees the room kept", func() bool { return g.Client.Status() == protocol.StatusKept })
	waitLeft(t, room)
	if code := a.stop(); code != 0 {
		t.Fatalf("code %d, stderr %s", code, a.stderr.String())
	}

	// While the host is away a guest writes an entry.
	guestInsert(g, 0, "away; ")
	eventually(t, "the entry in the relay's log", func() bool { return len(env.relay.Log()) > 0 })

	b := startApp(t, file)
	if got := b.event("listening", 1)["generation"]; got != generation {
		t.Fatalf("generation %v, want %v", got, generation)
	}
	// Other origins are refused, and nothing is resumed by it.
	b.command(fmt.Sprintf(`{"cmd":"share","keep":"1h","relay":%q,"origins":["https://other.example.com"]}`, env.server.URL))
	if e := b.event("error", 1); e["cmd"] != "share" || !strings.Contains(e["message"].(string), "origins") {
		t.Fatalf("%v", e)
	}
	b.command(fmt.Sprintf(`{"cmd":"share","keep":"1h","relay":%q}`, env.server.URL))
	if e := b.event("error", 2); !strings.Contains(e["message"].(string), "origins") {
		t.Fatalf("%v", e)
	}

	second := b.shareKeptAt(env, cmsOrigin)
	if second["resumed"] != true || second["room"] != room || fmt.Sprint(second["links"]) != fmt.Sprint(first["links"]) {
		t.Fatalf("resumed share %v, first %v", second, first)
	}
	const want = "away; app: hello\nguest\n"
	eventually(t, "the file holds the away entry once", func() bool { return holds(file, want) })
	page2 := b.openPage(1)
	eventually(t, "the page's text", func() bool { return page2.get() == want })
	eventually(t, "the guest sees the room live again", func() bool { return guestText(g) == want && g.Client.Status() == protocol.StatusConnected })
	if code := b.stop(); code != 0 {
		t.Fatalf("code %d, stderr %s", code, b.stderr.String())
	}
	if got := readText(t, file); got != want {
		t.Fatalf("file %q", got)
	}
}

// A record that pedit <file> --keep wrote has no generation: its document was
// made on its own, so serve's never merges with it, whatever the text.
func TestServeShareNeverMergesWithACLIKeptRecord(t *testing.T) {
	env := keptEnv(t)
	file := writeFile(t, "hello\n")
	// The project as serve finds it, with the links of its path resolved; the
	// file keeps the path it was given.
	project, err := filepath.EvalSymlinks(filepath.Dir(file))
	if err != nil {
		t.Fatal(err)
	}
	s, err := session.Start(context.Background(), session.Options{
		File: file, Project: project, Server: env.server.URL, Keep: time.Hour,
		Dial: env.relay.Dial, WriteDelay: 20 * time.Millisecond,
	})
	if err != nil {
		t.Fatal(err)
	}
	room := roomOf(s.URL)
	waitForKeptRecord(t, room)
	if err := s.Stop(); err != nil {
		t.Fatal(err)
	}

	a := startApp(t, file)
	a.command(fmt.Sprintf(`{"cmd":"share","keep":"1h","relay":%q}`, env.server.URL))
	e := a.event("error", 1)
	if e["cmd"] != "share" || !strings.Contains(e["message"].(string), "kept room "+room) || !strings.Contains(e["message"].(string), "another history") {
		t.Fatalf("%v", e)
	}
	if rec := keptRecord(t, room); rec["Generation"] != nil {
		t.Fatalf("record %v", rec)
	}
	if code := a.stop(); code != 0 {
		t.Fatalf("code %d, stderr %s", code, a.stderr.String())
	}
}

func waitForKeptRecord(t *testing.T, room string) {
	t.Helper()
	eventually(t, "the record", func() bool {
		config, _ := os.UserConfigDir()
		paths, _ := filepath.Glob(filepath.Join(config, "pedit", "keep", "*", room+".json"))
		if len(paths) != 1 {
			return false
		}
		b, _ := os.ReadFile(paths[0])
		var rec map[string]any
		return json.Unmarshal(b, &rec) == nil && rec["Initialized"] == true
	})
}
