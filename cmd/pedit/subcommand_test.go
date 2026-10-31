package main

import (
	"encoding/json"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"
)

func TestSubcommandHelp(t *testing.T) {
	t.Chdir(t.TempDir())
	for _, c := range []struct {
		args []string
		want string
	}{
		{[]string{"close", "--help"}, "Usage: pedit close [room|link]"},
		{[]string{"close", "-h"}, "Usage: pedit close [room|link]"},
		{[]string{"rooms", "--help"}, "Usage: pedit rooms [--json]"},
		{[]string{"--help"}, "Commands:\n  pedit close [room|link]"},
	} {
		var stdout, stderr strings.Builder
		if code := run(c.args, &stdout, &stderr); code != 0 || !strings.Contains(stdout.String(), c.want) {
			t.Errorf("run(%q) = %d\nstdout: %s\nstderr: %s", c.args, code, stdout.String(), stderr.String())
		}
	}
}

func TestCloseSubcommandArguments(t *testing.T) {
	for args, want := range map[string]commandArgs{
		"":                             {Close: true, ResumeAny: true},
		testRoom:                       {Close: true, Resume: testRoom},
		"-AAAAAAAAAAAAAAAAAAAAA":       {Close: true, Resume: "-AAAAAAAAAAAAAAAAAAAAA"},
		"-- " + testRoom:               {Close: true, Resume: testRoom},
		"https://x.test/r/" + testRoom: {Close: true, Resume: "https://x.test/r/" + testRoom},
	} {
		got, err := parseCloseArgs(strings.Fields(args))
		if err != nil || got.Close != want.Close || got.Resume != want.Resume || got.ResumeAny != want.ResumeAny {
			t.Fatalf("%q: %+v %v", args, got, err)
		}
	}
	for _, args := range [][]string{{"short"}, {"a.md"}, {"--json"}, {testRoom, testRoom}} {
		if _, err := parseCloseArgs(args); err == nil {
			t.Fatalf("accepted %v", args)
		}
	}
}

func TestSubcommandsWithoutKeptRooms(t *testing.T) {
	root := keptProject(t, "")
	put(t, filepath.Join(root, "close"), "a file named like a command\n")
	for _, c := range []struct {
		args           []string
		code           int
		stdout, stderr string
	}{
		{[]string{"rooms"}, 0, "No kept rooms in this project.", ""},
		{[]string{"rooms", "--json"}, 0, "[]", ""},
		{[]string{"rooms", "a.md"}, 2, "", "Usage: pedit rooms"},
		{[]string{"rooms", "--json", "--json"}, 2, "", "Usage: pedit rooms"},
		{[]string{"close"}, 1, "", "no kept room in this project"},
		{[]string{"close", testRoom}, 1, "", "no kept room " + testRoom},
		{[]string{"close", "a.md"}, 2, "", "Usage: pedit close"},
		// The alias says where the verb went, then does the same.
		{[]string{"--close", testRoom}, 1, "", "--close is now pedit close " + testRoom + ";"},
		// A command's name after another word, or after --, is a file.
		{[]string{"a.md", "rooms"}, 1, "", "rooms does not exist."},
		{[]string{"--", "rooms"}, 1, "", "rooms does not exist."},
	} {
		var stdout, stderr strings.Builder
		code := run(c.args, &stdout, &stderr)
		if code != c.code || !strings.Contains(stdout.String(), c.stdout) || !strings.Contains(stderr.String(), c.stderr) {
			t.Errorf("run(%q) = %d\nstdout: %s\nstderr: %s", c.args, code, stdout.String(), stderr.String())
		}
	}
}

func TestRoomsListsTheKeptRooms(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("kept rooms are not supported on Windows")
	}
	root := keptProject(t, "")
	until := time.Now().Add(time.Hour).Truncate(time.Second)
	keptHere(t, root, testRoom, true, until, filepath.Join(root, "a.md"), filepath.Join(root, "b.md"))

	var stdout, stderr strings.Builder
	if code := run([]string{"rooms"}, &stdout, &stderr); code != 0 ||
		!strings.Contains(stdout.String(), testRoom+"  a.md, b.md  until "+until.Format(time.RFC3339)) {
		t.Fatalf("rooms = %d\nstdout: %s\nstderr: %s", code, stdout.String(), stderr.String())
	}

	stdout.Reset()
	if code := run([]string{"rooms", "--json"}, &stdout, &stderr); code != 0 {
		t.Fatalf("rooms --json = %d: %s", code, stderr.String())
	}
	var rooms []map[string]any
	if err := json.Unmarshal([]byte(stdout.String()), &rooms); err != nil {
		t.Fatalf("not JSON: %v\n%s", err, stdout.String())
	}
	want := []any{filepath.Join(root, "a.md"), filepath.Join(root, "b.md")}
	if len(rooms) != 1 || rooms[0]["room"] != testRoom || rooms[0]["until"] != until.UTC().Format(time.RFC3339) ||
		len(rooms[0]) != 3 || !equalAny(rooms[0]["files"], want) {
		t.Fatalf("rooms --json: %s", stdout.String())
	}
}

func equalAny(got any, want []any) bool {
	list, ok := got.([]any)
	if !ok || len(list) != len(want) {
		return false
	}
	for i := range list {
		if list[i] != want[i] {
			return false
		}
	}
	return true
}

func TestUINamesTheRoom(t *testing.T) {
	var out strings.Builder
	u := newUI(&out, false, false)
	u.joined("01-notes.md", "https://pedit.example.com/r/"+testRoom+"#key", true, false)
	u.stopLive()
	if !strings.Contains(out.String(), "    01-notes.md\n    Room: "+testRoom+"\n") {
		t.Fatalf("join output: %q", out.String())
	}
	if strings.Contains(out.String(), "#key") {
		t.Fatal("the key is printed with the room")
	}

	out.Reset()
	u = newUI(&out, false, false)
	u.keptHint(time.UnixMilli(1700000000000).UTC(), testRoom, false, "notes.md")
	if !strings.HasPrefix(out.String(), "  Room: "+testRoom+"\n  Room stays open until") {
		t.Fatalf("kept output: %q", out.String())
	}
}
