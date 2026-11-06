package main

import (
	"encoding/binary"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// recordGone is whether the room has no record in the user's config directory.
func recordGone(room string) bool {
	config, _ := os.UserConfigDir()
	paths, _ := filepath.Glob(filepath.Join(config, "pedit", "keep", "*", room+".json"))
	return len(paths) == 0
}

// closedWith is the close code pedit sent on a stream, if it did.
func (a *app) closedWith(stream uint32) (uint16, bool) {
	for _, f := range wholeFrames(a.out.String()) {
		if f.kind == 3 && f.stream == stream && len(f.payload) >= 2 {
			return binary.BigEndian.Uint16(f.payload), true
		}
	}
	return 0, false
}

// both is whether text holds the app's edit and the room's, once each. Where
// the two inserts at the start of the text land is up to the merge.
func both(text string) bool {
	return len(text) == len("app: away; hello\n") && strings.Count(text, "app: ") == 1 && strings.Count(text, "away; ") == 1 && strings.HasSuffix(text, "hello\n")
}

func (a *app) shareRaw(env *shareEnv, extra string) {
	a.t.Helper()
	a.command(fmt.Sprintf(`{"cmd":"share","keep":"1h","relay":%q%s}`, env.server.URL, extra))
}

func TestServeCloseWhileSharedTakesTheEditsInAndEndsTheRoom(t *testing.T) {
	env := keptEnv(t)
	file := writeFile(t, "hello\n")
	a := startApp(t, file)
	first := a.shareKeptAt(env, cmsOrigin)
	room := first["room"].(string)

	page := a.openPage(1)
	eventually(t, "the page's text", func() bool { return page.get() == "hello\n" })
	page.insert(0, "app: ")
	g := env.join(t, linkOf(first, "edit"), "ada")
	eventually(t, "the guest sees the page's edit", func() bool { return guestText(g) == "app: hello\n" })
	guestInsert(g, len("app: hello\n"), "guest\n")
	eventually(t, "the file", func() bool { return holds(file, "app: hello\nguest\n") })

	a.command(`{"cmd":"close"}`)
	if e := a.event("room_ended", 1); e["reason"] != "closed" {
		t.Fatalf("%v", e)
	}
	if env.closed.Load() != 1 || !recordGone(room) {
		t.Fatalf("relay asked %d times, record gone: %v", env.closed.Load(), recordGone(room))
	}
	if got := readText(t, file); got != "app: hello\nguest\n" {
		t.Fatalf("file %q", got)
	}
	// Serve goes on: the page is not ended, and a new share has new links.
	page.insert(0, "more: ")
	eventually(t, "the file", func() bool { return holds(file, "more: app: hello\nguest\n") })
	env.relay.SetRefuse(0)
	second := a.shareKeptAt(env, cmsOrigin)
	if second["room"] == room || second["resumed"] != false {
		t.Fatalf("%v", second)
	}
	if code := a.stop(); code != 0 {
		t.Fatalf("code %d, stderr %s", code, a.stderr.String())
	}
}

func TestServeCloseOfAKeptRoomAfterARestart(t *testing.T) {
	env := keptEnv(t)
	file := writeFile(t, "hello\n")
	a := startApp(t, file)
	first := a.shareKeptAt(env, cmsOrigin)
	room := first["room"].(string)
	g := env.join(t, linkOf(first, "edit"), "ada")
	eventually(t, "the guest's text", func() bool { return guestText(g) == "hello\n" })
	guestInsert(g, 0, "one ")
	eventually(t, "the file", func() bool { return holds(file, "one hello\n") })
	a.command(`{"cmd":"unshare"}`)
	waitLeft(t, room)
	if code := a.stop(); code != 0 {
		t.Fatalf("code %d, stderr %s", code, a.stderr.String())
	}
	guestInsert(g, 0, "away; ")
	eventually(t, "the entry in the relay's log", func() bool { return len(env.relay.Log()) > 0 })

	b := startApp(t, file)
	b.command(`{"cmd":"close"}`)
	if e := b.event("room_ended", 1); e["reason"] != "closed" {
		t.Fatalf("%v", e)
	}
	if env.closed.Load() != 1 || !recordGone(room) {
		t.Fatalf("relay asked %d times, record gone: %v", env.closed.Load(), recordGone(room))
	}
	eventually(t, "the file has the away entry", func() bool { return holds(file, "away; one hello\n") })
	if code := b.stop(); code != 0 {
		t.Fatalf("code %d, stderr %s", code, b.stderr.String())
	}
	if got := readText(t, file); got != "away; one hello\n" {
		t.Fatalf("file %q", got)
	}
}

func TestServeCloseOfALiveRoomIsUnshare(t *testing.T) {
	env := newShareEnv(t)
	file := writeFile(t, "hi\n")
	a := startApp(t, file)
	a.share(fmt.Sprintf(`,"relay":%q`, env.server.URL))
	a.command(`{"cmd":"close"}`)
	// The share ended: another one is not "already shared".
	a.share(fmt.Sprintf(`,"relay":%q`, env.server.URL))
	if env.closed.Load() != 0 {
		t.Fatalf("the relay was asked to end a room %d times", env.closed.Load())
	}
	if code := a.stop(); code != 0 {
		t.Fatalf("code %d, stderr %s", code, a.stderr.String())
	}
}

func TestServeCloseKeepsTheRecordWhenTheRelayIsBusy(t *testing.T) {
	env := keptEnv(t)
	file := writeFile(t, "hello\n")
	a := startApp(t, file)
	first := a.shareKeptAt(env, cmsOrigin)
	room := first["room"].(string)
	g := env.join(t, linkOf(first, "edit"), "ada")
	eventually(t, "the guest's text", func() bool { return guestText(g) == "hello\n" })

	env.busy.Store(409)
	a.command(`{"cmd":"close","id":"c1"}`)
	e := a.event("error", 1)
	// The share ended before the relay refused: an unshared with no id, then the error with it.
	if u := a.event("unshared", 1); u["id"] != nil {
		t.Fatalf("%v", u)
	}
	if e["id"] != "c1" {
		t.Fatalf("%v", e)
	}
	if e["cmd"] != "close" || !strings.Contains(e["message"].(string), "try again") {
		t.Fatalf("%v", e)
	}
	if recordGone(room) {
		t.Fatal("the record is gone")
	}
	env.busy.Store(0)
	a.command(`{"cmd":"close"}`)
	a.event("room_ended", 1)
	if !recordGone(room) {
		t.Fatal("the record outlived the room")
	}
	if code := a.stop(); code != 0 {
		t.Fatalf("code %d, stderr %s", code, a.stderr.String())
	}
}

// choiceSetup is a CLI record whose room a guest wrote to while away, and an
// app whose page edited the file.
func choiceSetup(t *testing.T) (env *shareEnv, file, room, link string, a *app, page *page) {
	t.Helper()
	env = keptEnv(t)
	file = writeFile(t, "hello\n")
	room, link, g := cliRoom(t, env, file)
	guestInsert(g, 0, "away; ")
	eventually(t, "the entry in the relay's log", func() bool { return len(env.relay.Log()) > 0 })

	a = startApp(t, file)
	page = a.openPage(1)
	eventually(t, "the page's text", func() bool { return page.get() == "hello\n" })
	page.insert(0, "app: ")
	eventually(t, "the file", func() bool { return holds(file, "app: hello\n") })
	return env, file, room, link, a, page
}

func TestServeShareChoiceRoomKeepsTheRoomAndMergesTheAppsText(t *testing.T) {
	env, file, room, link, a, _ := choiceSetup(t)
	oldGeneration := a.event("listening", 1)["generation"]

	a.shareRaw(env, ``)
	a.event("resume_choice", 1)
	a.shareRaw(env, `,"choice":"room"`)
	shared := a.event("shared", 1)
	if shared["resumed"] != true || shared["room"] != room || linkOf(shared, "edit") != link {
		t.Fatalf("shared %v, want room %s link %s", shared, room, link)
	}
	eventually(t, "the page's stream is closed as gone", func() bool { c, ok := a.closedWith(1); return ok && c == 4001 })

	eventually(t, "the file holds both", func() bool { return both(readText(t, file)) })
	want := readText(t, file)
	// The record now names serve's new generation, so later resumes match.
	rec := keptRecord(t, room)
	if rec["Generation"] == nil || rec["Generation"] == oldGeneration {
		t.Fatalf("record generation %v, serve's was %v", rec["Generation"], oldGeneration)
	}
	// A page that comes back sees the merged document.
	page2 := a.openPage(2)
	eventually(t, "the new page's text", func() bool { return page2.get() == want })
	a.command(`{"cmd":"unshare"}`)
	waitLeft(t, room)
	if code := a.stop(); code != 0 {
		t.Fatalf("code %d, stderr %s", code, a.stderr.String())
	}
	if got := readText(t, file); got != want {
		t.Fatalf("file %q", got)
	}

	// The room is one history with serve now: a restart resumes it as usual.
	b := startApp(t, file)
	again := func() map[string]any {
		b.shareRaw(env, ``)
		return b.event("shared", 1)
	}()
	if again["resumed"] != true || again["room"] != room {
		t.Fatalf("%v", again)
	}
	if code := b.stop(); code != 0 {
		t.Fatalf("code %d, stderr %s", code, b.stderr.String())
	}
}

func TestServeShareChoiceAppTakesTheRoomsEditsAndEndsIt(t *testing.T) {
	env, file, room, _, a, page := choiceSetup(t)

	a.shareRaw(env, `,"choice":"app"`)
	if e := a.event("room_ended", 1); e["reason"] != "closed" {
		t.Fatalf("%v", e)
	}
	if env.closed.Load() != 1 || !recordGone(room) {
		t.Fatalf("relay asked %d times, record gone: %v", env.closed.Load(), recordGone(room))
	}
	eventually(t, "the file holds both", func() bool { return both(readText(t, file)) })
	want := readText(t, file)
	// The app's page was not ended: the room's edits reached it as any edit.
	eventually(t, "the page's text", func() bool { return page.get() == want })
	if _, ok := a.closedWith(1); ok {
		t.Fatal("the page's stream was closed")
	}

	env.relay.SetRefuse(0)
	a.shareRaw(env, ``)
	second := a.event("shared", 1)
	if second["room"] == room || second["resumed"] != false {
		t.Fatalf("%v", second)
	}
	if code := a.stop(); code != 0 {
		t.Fatalf("code %d, stderr %s", code, a.stderr.String())
	}
}

func TestServeShareChoiceLaterChangesNothing(t *testing.T) {
	env, file, room, _, a, _ := choiceSetup(t)

	a.shareRaw(env, `,"choice":"later"`)
	e := a.event("error", 1)
	if e["cmd"] != "share" || !strings.Contains(e["message"].(string), "waits for a choice") {
		t.Fatalf("%v", e)
	}
	if env.closed.Load() != 0 || recordGone(room) || keptRecord(t, room)["Generation"] != nil {
		t.Fatalf("relay asked %d times, record %v", env.closed.Load(), keptRecord(t, room))
	}
	if got := readText(t, file); got != "app: hello\n" {
		t.Fatalf("file %q", got)
	}
	if _, ok := a.closedWith(1); ok {
		t.Fatal("the page's stream was closed")
	}
	if code := a.stop(); code != 0 {
		t.Fatalf("code %d, stderr %s", code, a.stderr.String())
	}
}

func TestServeShareChoiceRoomRefusesOtherOriginsBeforeChangingAnything(t *testing.T) {
	env, _, room, _, a, _ := choiceSetup(t)

	a.shareRaw(env, `,"choice":"room","origins":["https://other.example.com"]`)
	if e := a.event("error", 1); !strings.Contains(e["message"].(string), "origins") {
		t.Fatalf("%v", e)
	}
	if keptRecord(t, room)["Generation"] != nil {
		t.Fatal("the record was changed")
	}
	if _, ok := a.closedWith(1); ok {
		t.Fatal("the page's stream was closed")
	}
	if code := a.stop(); code != 0 {
		t.Fatalf("code %d, stderr %s", code, a.stderr.String())
	}
}
