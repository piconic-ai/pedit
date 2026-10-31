package interop

import (
	"bytes"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/piconic-ai/pedit/internal/meta"
	"github.com/piconic-ai/pedit/internal/protocol/prototest"
	"github.com/piconic-ai/pedit/internal/session"
)

// roomGuest is a Node guest (testdata/kept-away.mjs): the real RoomClient of
// packages/protocol, as the browser runs it.
type roomGuest struct {
	t *testing.T
	p *keptProcess
}

type roomState struct {
	Status       string
	Statuses     []string
	Text         string
	Threads      []string
	Sync         string
	Skipped      int
	Replayed     bool
	KeptUntil    int64
	ClosedByHost bool
	Image        *struct {
		Hash   string
		OK     bool
		Status int
	}
}

func (g *roomGuest) read() roomState {
	g.t.Helper()
	var s roomState
	if err := json.Unmarshal([]byte(g.p.line(g.t)), &s); err != nil {
		g.t.Fatal(err)
	}
	return s
}

func (g *roomGuest) send(command string) roomState {
	g.t.Helper()
	if _, err := fmt.Fprintln(g.p.input, command); err != nil {
		g.t.Fatal(err)
	}
	return g.read()
}

// until polls the guest's state until cond holds.
func (g *roomGuest) until(what string, cond func(roomState) bool) roomState {
	g.t.Helper()
	var s roomState
	prototest.WaitFor(g.t, 20*time.Second, func() bool {
		s = g.send(`{}`)
		return cond(s)
	}, what)
	return s
}

// editAway makes the guest write one text edit and one comment thread, and
// waits until the relay has logged both.
func (g *roomGuest) editAway(r *keptRoom, link string) {
	g.t.Helper()
	g.until("the room to be kept", func(s roomState) bool { return s.Status == "kept" && s.Replayed })
	g.send(`{"append":"edited away\n"}`)
	g.send(`{"thread":{"from":0,"to":5,"quote":"notes","body":"Which notes?"}}`)
	g.until("the relay to keep the edits", func(s roomState) bool {
		return s.Sync == "kept" && strings.Contains(s.Text, "edited away") && len(s.Threads) == 1
	})
	// The sync label can describe the first edit while the second is still
	// being sealed: the relay's own log says both are kept.
	prototest.WaitFor(g.t, 15*time.Second, func() bool { return r.logEntries(link) >= 2 }, "both edits in the relay's log")
}

type keptRoom struct {
	t       *testing.T
	relay   string
	binary  string
	project string
	file    string
	dir     string
}

func newKeptRoom(t *testing.T) *keptRoom {
	t.Helper()
	if os.Getenv("PEDIT_INTEROP") != "1" {
		t.Skip("set PEDIT_INTEROP=1")
	}
	if runtime.GOOS == "windows" {
		t.Skip("kept host requires Unix permissions")
	}
	cache, err := exec.Command("go", "env", "GOMODCACHE").Output()
	if err != nil {
		t.Fatal(err)
	}
	t.Setenv("GOMODCACHE", strings.TrimSpace(string(cache)))
	userConfig := t.TempDir()
	t.Setenv("XDG_CONFIG_HOME", userConfig)
	if runtime.GOOS == "darwin" {
		t.Setenv("HOME", userConfig)
	}
	r := &keptRoom{t: t, dir: protocolDir(t), relay: keptRelay(t)}
	root, err := filepath.Abs("../..")
	if err != nil {
		t.Fatal(err)
	}
	r.binary = filepath.Join(t.TempDir(), "pedit")
	build := exec.Command("go", "build", "-o", r.binary, "./cmd/pedit")
	build.Dir = root
	if output, err := build.CombinedOutput(); err != nil {
		t.Fatalf("build CLI: %v\n%s", err, output)
	}
	r.project = t.TempDir()
	if err := os.Mkdir(filepath.Join(r.project, ".pedit"), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(r.project, ".pedit/config.yaml"), []byte("server: "+r.relay+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	r.file = filepath.Join(r.project, "notes.md")
	if err := os.WriteFile(r.file, []byte("notes\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	return r
}

func (r *keptRoom) pedit(args ...string) *keptProcess {
	return keptCommand(r.t, r.project, append([]string{r.binary}, args...)...)
}

// host starts `pedit --keep 1h notes.md` and waits until the relay has
// answered the keep (the test relay caps it to a minute).
func (r *keptRoom) host() (*keptProcess, string) {
	host := r.pedit("--keep", "1h", "notes.md")
	link := host.link(r.t)
	for i := 0; i < 30 && !strings.Contains(strings.Join(host.seen, "\n"), "capped keep time to 1m"); i++ {
		host.line(r.t)
	}
	return host, link
}

func (r *keptRoom) guest(link string) *roomGuest {
	r.t.Helper()
	u, err := url.Parse(link)
	if err != nil {
		r.t.Fatal(err)
	}
	socket := "ws" + strings.TrimPrefix(r.relay, "http") + "/api/rooms/" + strings.TrimPrefix(u.Path, "/r/") + "/ws"
	script, err := filepath.Abs("testdata/kept-away.mjs")
	if err != nil {
		r.t.Fatal(err)
	}
	return &roomGuest{t: r.t, p: keptCommand(r.t, r.project, "node", script, r.dir, socket, u.Fragment)}
}

func (r *keptRoom) text() string {
	b, _ := os.ReadFile(r.file)
	return string(b)
}

// logEntries is how many entries the relay's log holds for the room.
func (r *keptRoom) logEntries(link string) int {
	u, _ := url.Parse(link)
	response, err := http.Get(r.relay + "/__test/kept/" + strings.TrimPrefix(u.Path, "/r/"))
	if err != nil {
		return -1
	}
	defer response.Body.Close()
	var state struct{ Entries int }
	if json.NewDecoder(response.Body).Decode(&state) != nil {
		return -1
	}
	return state.Entries
}

// takenIn checks what a returning host wrote and that the guests are live.
func (r *keptRoom) takenIn(link string, guests ...*roomGuest) {
	t := r.t
	t.Helper()
	prototest.WaitFor(t, 15*time.Second, func() bool { return strings.Contains(r.text(), "edited away") }, "the guest's edit in notes.md")
	metaName := filepath.Join(r.project, ".pedit/meta/notes.md.json")
	var written []byte
	prototest.WaitFor(t, 15*time.Second, func() bool { written, _ = os.ReadFile(metaName); return len(written) > 0 }, "the thread in .pedit/meta")
	parsed, err := meta.Parse(written)
	if err != nil || len(parsed.Comments) != 1 {
		t.Fatalf("metadata file: %s (%v)", written, err)
	}
	for _, thread := range parsed.Comments {
		if thread.Anchor.Text == nil || thread.Anchor.Text.Exact != "notes" || thread.Messages["m1"].Body != "Which notes?" {
			t.Fatalf("thread lost its anchor or comment: %s", written)
		}
	}
	prototest.WaitFor(t, 15*time.Second, func() bool { return r.logEntries(link) == 0 }, "the relay's log to be truncated")
	for _, g := range guests {
		s := g.until("host back", func(s roomState) bool { return s.Status == "connected" })
		if !slices.Contains(s.Statuses, "kept") {
			t.Fatalf("a guest never saw the room kept: %v", s.Statuses)
		}
	}
	// A live edit of a guest reaches the file.
	guests[0].send(`{"append":"live again\n"}`)
	prototest.WaitFor(t, 15*time.Second, func() bool { return strings.Contains(r.text(), "live again") }, "a live edit in notes.md")
}

func TestKeptRoomEndToEnd(t *testing.T) {
	r := newKeptRoom(t)
	host, link := r.host()
	first := r.guest(link)
	if s := first.read(); !strings.Contains(s.Text, "notes") {
		t.Fatalf("the guest does not see the text: %+v", s)
	}
	if out := host.stop(t); !strings.Contains(out, "Room stays open until") {
		t.Fatalf("Ctrl+C did not say how long the room stays:\n%s", out)
	}
	first.editAway(r, link)
	if r.logEntries(link) < 2 {
		t.Fatalf("the relay holds %d entries", r.logEntries(link))
	}
	// A second guest joins while the host is away and sees both.
	second := r.guest(link)
	s := second.until("the kept edits", func(s roomState) bool {
		return s.Status == "kept" && strings.Contains(s.Text, "edited away") && len(s.Threads) == 1
	})
	if s.KeptUntil <= time.Now().UnixMilli() {
		t.Fatalf("kept until %d", s.KeptUntil)
	}
	if got := r.text(); strings.Contains(got, "edited away") {
		t.Fatalf("the file changed while the host was away: %q", got)
	}

	resumed := r.pedit("--resume")
	resumed.link(t)
	r.takenIn(link, first, second)
	resumed.stop(t)

	// The host closes the room: the guests are told, and the record is gone.
	if records, err := session.ListKeptText(r.project); err != nil || len(records) != 1 {
		t.Fatalf("records before --close: %v, %v", records, err)
	}
	closer := r.pedit("--close")
	var closing []string
	for line := range closer.lines {
		closing = append(closing, line)
	}
	if err := closer.wait(); err != nil || !strings.Contains(strings.Join(closing, "\n"), "Closed the room") {
		t.Fatalf("--close: %v\n%s", err, strings.Join(closing, "\n"))
	}
	for _, g := range []*roomGuest{first, second} {
		s := g.until("the room to end", func(s roomState) bool { return s.Status == "closed" })
		if !s.ClosedByHost {
			t.Fatalf("the guest was not told the host closed the room: %+v", s)
		}
	}
	if records, err := session.ListKeptText(r.project); err != nil || len(records) != 0 {
		t.Fatalf("records after --close: %v, %v", records, err)
	}
}

func TestKeptRoomWhenTheHostDrops(t *testing.T) {
	r := newKeptRoom(t)
	host, link := r.host()
	guest := r.guest(link)
	guest.read()
	if err := host.cmd.Process.Kill(); err != nil {
		t.Fatal(err)
	}
	// The relay waits its grace (2s in the test relay), then keeps the room.
	guest.editAway(r, link)
	resumed := r.pedit("--resume")
	resumed.link(t)
	r.takenIn(link, guest)
	resumed.stop(t)
}

// A guest pastes an image into a kept room while the host is away. When the
// host comes back with pedit <file>, it finds the reference in the text, saves
// the image beside the file and only then cuts the relay log; a guest who
// joins later still sees the image.
func TestKeptRoomImagesPastedWhileAwayAreSavedOnResume(t *testing.T) {
	r := newKeptRoom(t)
	host, link := r.host()
	guest := r.guest(link)
	guest.read()
	host.stop(t)
	guest.until("the room to be kept", func(s roomState) bool { return s.Status == "kept" && s.Replayed })

	png := []byte("\x89PNG\r\n\x1a\n pasted while away")
	sum := sha256.Sum256(png)
	hash := hex.EncodeToString(sum[:16])
	reference := "![](assets/" + hash + ".png)"
	away := guest.send(fmt.Sprintf(`{"image":%q}`, base64.StdEncoding.EncodeToString(png)))
	if away.Image == nil || away.Image.Hash != hash || !strings.Contains(away.Text, reference) {
		t.Fatalf("paste while away: %+v", away)
	}
	prototest.WaitFor(t, 15*time.Second, func() bool { return r.logEntries(link) >= 1 }, "the relay to log the reference")
	assets := filepath.Join(r.project, "assets", hash+".png")
	if _, err := os.Stat(assets); err == nil {
		t.Fatal("the image reached the disk while the host was away")
	}

	// pedit <file> takes up the kept room that holds the file.
	resumed := r.pedit("notes.md")
	resumed.link(t)
	prototest.WaitFor(t, 15*time.Second, func() bool {
		saved, _ := os.ReadFile(assets)
		return strings.Contains(r.text(), reference) && bytes.Equal(saved, png)
	}, "the reference and the image saved on resume")
	if info, err := os.Stat(assets); err != nil || info.Mode().Perm() != 0o600 {
		t.Fatalf("image mode: %v %v", info, err)
	}
	prototest.WaitFor(t, 15*time.Second, func() bool { return r.logEntries(link) == 0 }, "the log to be cut after the save")

	fresh := r.guest(link)
	fresh.read()
	seen := fresh.send(fmt.Sprintf(`{"fetchImage":%q}`, hash))
	if !strings.Contains(seen.Text, reference) || seen.Image == nil || !seen.Image.OK {
		t.Fatalf("a guest who joins later cannot see the image: %+v", seen)
	}
	resumed.stop(t)
}
