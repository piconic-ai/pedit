package main

import (
	"fmt"
	"runtime"
	"testing"
	"time"

	"github.com/piconic-ai/pedit/internal/protocol"
)

// A guest's edit and an unshare inside serve's write delay still leave a
// record that holds the edit and matches the file.
func TestServeShareKeptRecordSurvivesAnUnshareInsideTheWriteDelay(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("kept rooms need Unix file permissions")
	}
	serveWriteDelay = 2 * time.Second
	t.Cleanup(func() { serveWriteDelay = 0 })
	env := newShareEnv(t)
	env.relay.Keep = 3600
	file := writeFile(t, "hello\n")
	a := startApp(t, file)
	shared := a.shareKept(fmt.Sprintf(`,"relay":%q`, env.server.URL))
	g := env.join(t, linkOf(shared, "edit"), "ada")
	eventually(t, "the guest's text", func() bool { return guestText(g) == "hello\n" })
	guestInsert(g, 0, "quick; ")
	a.command(`{"cmd":"unshare"}`)
	eventually(t, "the guest sees the room kept", func() bool { return g.Client.Status() == protocol.StatusKept })

	room := shared["room"].(string)
	waitLeft(t, room)
	f := keptRecord(t, room)["Files"].([]any)[0].(map[string]any)
	if f["Text"] != "quick; hello\n" || readText(t, file) != "quick; hello\n" {
		t.Fatalf("record %v, file %q", f, readText(t, file))
	}
	if code := a.stop(); code != 0 {
		t.Fatalf("code %d, stderr %s", code, a.stderr.String())
	}
}
