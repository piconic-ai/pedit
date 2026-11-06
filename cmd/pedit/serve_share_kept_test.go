package main

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/piconic-ai/pedit/internal/protocol"
)

// shareKept sends a share that keeps the room for an hour.
func (a *app) shareKept(args string) map[string]any {
	a.t.Helper()
	a.command(`{"cmd":"share","keep":"1h"` + args + `}`)
	a.shares++
	return a.event("shared", a.shares)
}

// keptRecord reads the record of a room from the user's config directory.
func keptRecord(t *testing.T, room string) map[string]any {
	t.Helper()
	config, err := os.UserConfigDir()
	if err != nil {
		t.Fatal(err)
	}
	paths, _ := filepath.Glob(filepath.Join(config, "pedit", "keep", "*", room+".json"))
	if len(paths) != 1 {
		t.Fatalf("records of %s: %v", room, paths)
	}
	b, err := os.ReadFile(paths[0])
	if err != nil {
		t.Fatal(err)
	}
	var rec map[string]any
	if err := json.Unmarshal(b, &rec); err != nil {
		t.Fatal(err)
	}
	return rec
}

// waitLeft waits for the record the host leaves with: it has a deadline, which
// a record written while the host is here does not.
func waitLeft(t *testing.T, room string) {
	t.Helper()
	eventually(t, "the record written on leaving", func() bool {
		config, _ := os.UserConfigDir()
		paths, _ := filepath.Glob(filepath.Join(config, "pedit", "keep", "*", room+".json"))
		if len(paths) != 1 {
			return false
		}
		b, _ := os.ReadFile(paths[0])
		var rec map[string]any
		return json.Unmarshal(b, &rec) == nil && rec["Until"] != float64(0) && rec["Until"] != nil
	})
}

func TestServeShareKeepsTheRoomWhenUnshared(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("kept rooms need Unix file permissions")
	}
	env := newShareEnv(t)
	env.relay.Keep = 3600
	file := writeFile(t, "hello\n")
	a := startApp(t, file)
	generation := a.event("listening", 1)["generation"]

	shared := a.shareKept(fmt.Sprintf(`,"relay":%q,"origins":["https://cms.example.com"]`, env.server.URL))
	room := shared["room"].(string)
	until, _ := shared["keptUntil"].(float64)
	if until < float64(time.Now().Add(30*time.Minute).UnixMilli()) {
		t.Fatalf("shared %v", shared)
	}
	if got := env.relay.Headers()[0].Get(protocol.KeepHeader); got != "3600" {
		t.Fatalf("%s = %q", protocol.KeepHeader, got)
	}

	g := env.join(t, linkOf(shared, "edit"), "ada")
	eventually(t, "the guest's text", func() bool { return guestText(g) == "hello\n" })
	guestInsert(g, 0, "oh, ")
	eventually(t, "the file gets the guest's edit", func() bool { return holds(file, "oh, hello\n") })

	a.command(`{"cmd":"unshare"}`)
	// The relay keeps the room: the guest stays, and what it writes is logged.
	eventually(t, "the guest sees the room kept", func() bool { return g.Client.Status() == protocol.StatusKept })
	guestInsert(g, 0, "still here; ")
	eventually(t, "the guest's entry is in the relay's log", func() bool { return len(env.relay.Log()) > 0 })

	waitLeft(t, room)
	rec := keptRecord(t, room)
	if rec["Generation"] != generation || fmt.Sprint(rec["Origins"]) != "[https://cms.example.com]" || rec["Socket"] != true || rec["Initialized"] != true {
		t.Fatalf("record %v", rec)
	}
	files, _ := rec["Files"].([]any)
	if len(files) != 1 {
		t.Fatalf("record %v", rec)
	}
	f, _ := files[0].(map[string]any)
	if f["Text"] != "oh, hello\n" || f["State"] == "" || !strings.HasSuffix(f["File"].(string), filepath.Base(file)) {
		t.Fatalf("record file %v", f)
	}
	if got := readText(t, file); got != "oh, hello\n" {
		t.Fatalf("file %q", got)
	}

	// A live room is not about the kept one.
	a.shares++
	a.command(fmt.Sprintf(`{"cmd":"share","keep":"0","relay":%q}`, env.server.URL))
	if second := a.event("shared", a.shares); second["room"] == room || second["keptUntil"] != float64(0) {
		t.Fatalf("%v", second)
	}
	if code := a.stop(); code != 0 {
		t.Fatalf("code %d, stderr %s", code, a.stderr.String())
	}
}

// A relay that keeps nothing says so: the room is live and keptUntil is 0.
func TestServeShareKeptWithARelayThatKeepsNothing(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("kept rooms need Unix file permissions")
	}
	env := newShareEnv(t)
	a := startApp(t, writeFile(t, "hi\n"))
	shared := a.shareKept(fmt.Sprintf(`,"relay":%q`, env.server.URL))
	if shared["keptUntil"] != float64(0) {
		t.Fatalf("shared %v", shared)
	}
	if code := a.stop(); code != 0 {
		t.Fatalf("code %d, stderr %s", code, a.stderr.String())
	}
}

func TestServeShareRefusesKeepOnWindows(t *testing.T) {
	if runtime.GOOS != "windows" {
		t.Skip("only Windows refuses kept rooms")
	}
	env := newShareEnv(t)
	a := startApp(t, writeFile(t, "hi\n"))
	a.command(fmt.Sprintf(`{"cmd":"share","keep":"1h","relay":%q}`, env.server.URL))
	if e := a.event("error", 1); e["cmd"] != "share" || !strings.Contains(e["message"].(string), "Windows") {
		t.Fatalf("%v", e)
	}
	if n := len(env.relay.URLs()); n != 0 {
		t.Fatalf("%d connections before the refusal", n)
	}
	// A live room works.
	a.shares++
	a.command(fmt.Sprintf(`{"cmd":"share","keep":"0","relay":%q}`, env.server.URL))
	a.event("shared", a.shares)
	if code := a.stop(); code != 0 {
		t.Fatalf("code %d, stderr %s", code, a.stderr.String())
	}
}
