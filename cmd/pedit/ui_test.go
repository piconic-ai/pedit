package main

import (
	"errors"
	"fmt"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/piconic-ai/pedit/internal/protocol"
	"github.com/piconic-ai/pedit/internal/session"
)

func TestUIWithoutTerminal(t *testing.T) {
	var out strings.Builder
	u := newUI(&out, false, false)
	u.setStatus(protocol.StatusConnected) // not shown before sharing
	u.signIn("pedit.example.com", "https://pedit.example.com/cdn-cgi/access/cli?token=abc")
	u.signedIn("k@example.com")
	u.sharing([]string{"notes.md"}, "https://pedit.example.com/r/AAAA#key", true, false)
	u.setPeople([]string{"Alice"})
	u.setPeople([]string{"Alice"}) // unchanged
	u.setStatus(protocol.StatusDisconnected)
	u.setStatus(protocol.StatusConnected)
	u.setStatus(protocol.StatusWaiting)
	u.setStatus(protocol.StatusConnected)
	u.setPeople([]string{"Alice", "Bob"})
	u.stopLive()
	u.setPeople(nil) // not shown after stopping
	u.saving("notes.md")
	u.saved("notes.md")

	want := `
  Sign in to pedit.example.com
  Your browser opened. Sign in there, then come back here.

  If it did not open, use this link:
  https://pedit.example.com/cdn-cgi/access/cli?token=abc

  Clicked Deny, or changed your mind? Press Ctrl+C to stop.

  ✓ Signed in as k@example.com

  notes.md is ready to write together.

  Send this link to the people you want to invite:
    https://pedit.example.com/r/AAAA#key
    Copied to your clipboard.

  Press Ctrl+C when you are done. Everything is saved to notes.md.

  ● Just you so far
  ● Alice is here
  ○ Offline. Reconnecting…
  ✓ Back online. Changes sync again.
  ● Alice is here
  ○ The host's connection dropped. Waiting for them to come back…
  ✓ Back online. Changes sync again.
  ● Alice is here
  ● Alice and Bob are here

  Saving notes.md…
  ✓ Saved notes.md. The link no longer works.

`
	if out.String() != want {
		t.Fatalf("got:\n%s\nwant:\n%s", out.String(), want)
	}
	if strings.Contains(out.String(), "\x1b[") {
		t.Fatal("escape codes outside a terminal")
	}
}

func TestUIOnTerminal(t *testing.T) {
	var out strings.Builder
	u := newUI(&out, true, false)
	u.sharing([]string{"notes.md"}, "https://pedit.example.com/r/AAAA#key", false, false)
	u.setStatus(protocol.StatusConnected)
	u.stopLive()
	got := out.String()
	for _, want := range []string{
		"\x1b[1mnotes.md is ready to write together.\x1b[0m",
		"    \x1b[36;4mhttps://pedit.example.com/r/AAAA#key\x1b[0m\n",
		// The live line is rewritten in place.
		"\r\x1b[2K  \x1b[33m○\x1b[0m Connecting…",
		"\r\x1b[2K  \x1b[32m●\x1b[0m Just you so far\n",
	} {
		if !strings.Contains(got, want) {
			t.Errorf("missing %q in %q", want, got)
		}
	}
	if strings.Contains(got, "clipboard") {
		t.Error("claims the link was copied")
	}
}

func TestUIImageSaved(t *testing.T) {
	var out strings.Builder
	u := newUI(&out, false, false)
	u.sharing([]string{"notes.md"}, "https://pedit.example.com/r/AAAA#key", false, false)
	u.setStatus(protocol.StatusConnected)
	u.imageSaved("assets/0123.png")
	if !strings.HasSuffix(out.String(), "  ● Just you so far\n  Saved an image to assets/0123.png\n") {
		t.Fatalf("got %q", out.String())
	}

	// On a terminal it goes above the live line, which comes back.
	out.Reset()
	u = newUI(&out, true, false)
	u.sharing([]string{"notes.md"}, "https://pedit.example.com/r/AAAA#key", false, false)
	u.setStatus(protocol.StatusConnected)
	u.imageSaved("assets/0123.png")
	want := "\r\x1b[2K  \x1b[2mSaved an image to assets/0123.png\x1b[0m\n\r\x1b[2K  \x1b[32m●\x1b[0m Just you so far"
	if !strings.HasSuffix(out.String(), want) {
		t.Fatalf("got %q", out.String())
	}
}

func TestUIWithoutColor(t *testing.T) {
	var out strings.Builder
	u := newUI(&out, true, true) // NO_COLOR
	u.sharing([]string{"notes.md"}, "https://pedit.example.com/r/AAAA#key", true, false)
	u.saved("notes.md")
	if got := out.String(); strings.Contains(got, "\x1b[1m") || strings.Contains(got, "\x1b[3") {
		t.Fatalf("colors despite NO_COLOR: %q", got)
	}
}

func TestUIScratch(t *testing.T) {
	var out strings.Builder
	u := newUI(&out, false, false)
	u.sharing([]string{"pedit-2026-09-26-143012.md"}, "https://pedit.example.com/r/AAAA#key", false, true)
	u.stopLive()
	u.saved("pedit-2026-09-26-143012.md")
	u.scratch("pedit-2026-09-26-143012.md")
	want := `
  pedit-2026-09-26-143012.md is ready to write together.

  Send this link to the people you want to invite:
    https://pedit.example.com/r/AAAA#key

  Press Ctrl+C when you are done. Everything is saved to pedit-2026-09-26-143012.md.

  Resume with: pedit pedit-2026-09-26-143012.md

  ○ Connecting…
  ✓ Saved pedit-2026-09-26-143012.md. The link no longer works.

  Saved to pedit-2026-09-26-143012.md
  Resume with: pedit pedit-2026-09-26-143012.md

`
	if out.String() != want {
		t.Fatalf("got:\n%s\nwant:\n%s", out.String(), want)
	}
}

func TestUISignsInOnAlternateScreen(t *testing.T) {
	var out strings.Builder
	u := newUI(&out, true, false)
	u.signIn("pedit.example.com", "https://pedit.example.com/cdn-cgi/access/cli?token=abc")
	u.signIn("pedit.example.com", "https://pedit.example.com/cdn-cgi/access/cli?token=def") // stays put
	u.endSignIn()
	u.endSignIn() // no-op
	u.signedIn("k@example.com")
	got := out.String()
	if strings.Count(got, "\x1b[?1049h") != 1 || strings.Count(got, "\x1b[?1049l") != 1 {
		t.Fatalf("enters or leaves the alternate screen more than once: %q", got)
	}
	enter, sign, leave, done := strings.Index(got, "\x1b[?1049h"), strings.Index(got, "Sign in to"), strings.Index(got, "\x1b[?1049l"), strings.Index(got, "Signed in as")
	if !(enter < sign && sign < leave && leave < done) {
		t.Fatalf("sign-in block is not on the alternate screen: %q", got)
	}
}

func TestUILeavesAlternateScreenWhenSignInFails(t *testing.T) {
	var out strings.Builder
	u := newUI(&out, true, false)
	u.signIn("pedit.example.com", "https://pedit.example.com/cdn-cgi/access/cli")
	u.endSignIn()
	if got := out.String(); !strings.HasSuffix(got, "\x1b[?1049l") {
		t.Fatalf("got %q", got)
	}
}

func TestUIKeepsSignInWithoutTerminal(t *testing.T) {
	var out strings.Builder
	u := newUI(&out, false, false)
	u.signIn("pedit.example.com", "https://pedit.example.com/cdn-cgi/access/cli")
	u.endSignIn()
	u.signedIn("")
	if got := out.String(); strings.Contains(got, "\x1b[") || !strings.Contains(got, "Sign in to pedit.example.com") {
		t.Fatalf("got %q", got)
	}
}

func TestUIWhenSignInStops(t *testing.T) {
	var out strings.Builder
	u := newUI(&out, false, false)
	u.signInCancelled()
	u.signInTimedOut(5 * time.Minute)
	want := `
  Sign-in cancelled. Nothing was shared.


  Sign-in did not finish in 5 minutes. Run pedit again to try again.

`
	if out.String() != want {
		t.Fatalf("got:\n%s\nwant:\n%s", out.String(), want)
	}
}

func TestMinutes(t *testing.T) {
	for d, want := range map[time.Duration]string{time.Minute: "1 minute", 5 * time.Minute: "5 minutes"} {
		if got := minutes(d); got != want {
			t.Errorf("minutes(%v) = %q, want %q", d, got, want)
		}
	}
}

func TestWhoIsHere(t *testing.T) {
	tests := []struct {
		names []string
		want  string
	}{
		{nil, "Just you so far"},
		{[]string{"Alice"}, "Alice is here"},
		{[]string{"Alice", "Bob"}, "Alice and Bob are here"},
		{[]string{"Alice", "Bob", "Carol"}, "Alice, Bob and Carol are here"},
		{[]string{"Alice", "Bob", "Carol", "Dave"}, "Alice, Bob and 2 others are here"},
	}
	for _, tt := range tests {
		if got := whoIsHere(tt.names); got != tt.want {
			t.Errorf("whoIsHere(%q) = %q, want %q", tt.names, got, tt.want)
		}
	}
}

func TestHostOf(t *testing.T) {
	for in, want := range map[string]string{
		"https://edit-lab.piconic.ai":  "edit-lab.piconic.ai",
		"https://edit-lab.piconic.ai/": "edit-lab.piconic.ai",
		"http://localhost:8787":        "localhost:8787",
	} {
		if got := hostOf(in); got != want {
			t.Errorf("hostOf(%q) = %q", in, got)
		}
	}
}

func TestUILiveLineUnderMaintenance(t *testing.T) {
	u := newUI(&strings.Builder{}, false, false)
	u.status = protocol.StatusMaintenance
	if got, want := u.liveLine(), "○ The relay is closed for maintenance."; got != want {
		t.Errorf("got %q, want %q", got, want)
	}
	u.resumable = true
	if got, want := u.liveLine(), "○ The relay is closed for maintenance. Press Enter to reconnect, Ctrl+C to quit."; got != want {
		t.Errorf("resumable: got %q, want %q", got, want)
	}
}

func TestUILiveLineWhenOutdated(t *testing.T) {
	for st, want := range map[protocol.Status]string{
		protocol.StatusClientOutdated: "○ This pedit is out of date.",
		protocol.StatusServerOutdated: "○ The server is out of date.",
	} {
		u := newUI(&strings.Builder{}, false, false)
		u.status = st
		if got := u.liveLine(); got != want {
			t.Errorf("%s: got %q, want %q", st, got, want)
		}
	}
}

func TestUILiveLineWhenTooLarge(t *testing.T) {
	u := newUI(&strings.Builder{}, false, false)
	u.setStatus(protocol.StatusTooLarge)
	if got, want := u.liveLine(), "○ The file grew too large to share."; got != want {
		t.Errorf("got %q, want %q", got, want)
	}
}

func TestUITooLarge(t *testing.T) {
	var host, guest strings.Builder
	newUI(&host, false, false).tooLarge(true, "notes.md")
	hostWant := "  The room was closed: notes.md and its edits grew past what pedit can share (about 1 MiB for now).\n" +
		"  Run pedit again to start a new room.\n\n"
	if host.String() != hostWant {
		t.Errorf("host: got %q, want %q", host.String(), hostWant)
	}
	newUI(&guest, false, false).tooLarge(false, filepath.Join("pedit-x", "00-notes.md"))
	want := "  pedit left the room: the shared file grew too large to share. pedit shares files up to about 1 MiB for now.\n" +
		"  Your latest changes may not have reached the others. Your copies stay in pedit-x.\n\n"
	if guest.String() != want {
		t.Errorf("guest: got %q, want %q", guest.String(), want)
	}
}

func TestUINotices(t *testing.T) {
	var out strings.Builder
	u := newUI(&out, false, false)
	u.setStatus(protocol.StatusConnected) // not shown before sharing
	u.sharing([]string{"notes.md"}, "https://pedit.example.com/r/AAAA#key", false, false)
	u.setPeople([]string{"Alice"})
	u.notice("notes.md", true, session.Notice{Kind: session.SaveFailed, Reason: "it is no longer a regular file"})
	u.notice("notes.md", true, session.Notice{Kind: session.SaveRecovered})
	u.notice("notes.md", true, session.Notice{Kind: session.ChangeHeld, Reason: "it is not UTF-8 text"})
	u.notice("notes.md", true, session.Notice{Kind: session.HoldReleased})
	u.notice("docs/notes.md", true, session.Notice{Kind: session.ChangeHeld,
		Reason: "it is not a valid JSON Canvas (https://jsoncanvas.org/spec/1.0/)",
		Details: []string{
			`board.canvas:2:1: nodes[0] (id "a"): has no "height"; add it as a number`,
			"and 2 more",
		},
	})
	u.notice("notes.md", true, session.Notice{Kind: session.ImageNotSaved, Reason: "it links out of the shared file's folder"})
	u.notice("docs/notes.md", true, session.Notice{Kind: session.ImageNotSaved, Reason: "not a directory."})
	u.notice("../x.md", true, session.Notice{Kind: session.CommentsOff, Reason: "it is outside the project"})
	u.notice(".pedit/meta/notes.md.json", true, session.Notice{Kind: session.CommentsHeld})
	u.stopLive()

	want := `
  notes.md is ready to write together.

  Send this link to the people you want to invite:
    https://pedit.example.com/r/AAAA#key

  Press Ctrl+C when you are done. Everything is saved to notes.md.

  ● Just you so far
  ● Alice is here
  Could not save notes.md: it is no longer a regular file.
  pedit tries again every few seconds. Fix this before you press Ctrl+C, or the latest edits are not saved.
  ✓ Saved notes.md again.
  notes.md changed outside pedit, but it is not UTF-8 text.
  pedit saves again once it is fixed, and does not save over it until then.
  Fix it before you press Ctrl+C, or the latest edits are not saved.
  ✓ notes.md is fixed. Saving goes on.
  docs/notes.md changed outside pedit, but it is not a valid JSON Canvas (https://jsoncanvas.org/spec/1.0/):
    board.canvas:2:1: nodes[0] (id "a"): has no "height"; add it as a number
    and 2 more
  pedit saves again once it is fixed, and does not save over it until then.
  Fix it before you press Ctrl+C, or the latest edits are not saved.
  Could not save an image someone pasted into assets: it links out of the shared file's folder.
  Could not save an image someone pasted into ` + filepath.Join("docs", "assets") + `: not a directory.
  Comments are off for ../x.md: it is outside the project.
  .pedit/meta/notes.md.json changed outside pedit, so pedit no longer saves comments to it.
  Comments made from now on last only while you share.
`
	if out.String() != want {
		t.Fatalf("got:\n%s\nwant:\n%s", out.String(), want)
	}
	if strings.Contains(out.String(), "\x1b[") {
		t.Fatal("escape codes outside a terminal")
	}
}

func TestUINoticeForAJoinedCopy(t *testing.T) {
	var out strings.Builder
	u := newUI(&out, false, false)
	u.notice("notes.md", false, session.Notice{Kind: session.SaveFailed, Reason: "permission denied"})
	u.notice("notes.md", false, session.Notice{Kind: session.SaveRecovered})
	u.notice("notes.md", false, session.Notice{Kind: session.ChangeHeld, Reason: "it is not UTF-8 text"})
	// Told the same on both.
	u.notice("notes.md", false, session.Notice{Kind: session.SaveLost})
	want := `  Could not save notes.md: permission denied.
  pedit tries again every few seconds. Until then, your copy misses the latest edits.
  ✓ Saved notes.md again.
  notes.md changed outside pedit, but it is not UTF-8 text.
  pedit saves again once it is fixed, and does not save over it until then.
  A save of notes.md made outside pedit was lost: pedit wrote the file at the same moment.
  Save it again.
`
	if out.String() != want {
		t.Fatalf("got:\n%s\nwant:\n%s", out.String(), want)
	}
	if strings.Contains(out.String(), "Ctrl+C") {
		t.Fatal("a joined copy is saved when it is left, not lost")
	}
}

func TestUINoticeGoesAboveTheLiveLine(t *testing.T) {
	var out strings.Builder
	u := newUI(&out, true, false)
	u.sharing([]string{"notes.md"}, "https://pedit.example.com/r/AAAA#key", false, false)
	u.setStatus(protocol.StatusConnected)
	out.Reset()

	u.notice("notes.md", true, session.Notice{Kind: session.SaveFailed, Reason: "permission denied"})
	want := "\r\x1b[2K" +
		"  \x1b[33mCould not save notes.md: permission denied.\x1b[0m\n" +
		"  pedit tries again every few seconds. Fix this before you press Ctrl+C, or the latest edits are not saved.\n" +
		"\r\x1b[2K  \x1b[32m●\x1b[0m Just you so far"
	if out.String() != want {
		t.Fatalf("got %q\nwant %q", out.String(), want)
	}

	// Once the live line has ended, there is none to put back.
	u.stopLive()
	out.Reset()
	u.notice("notes.md", true, session.Notice{Kind: session.SaveRecovered})
	if want := "  \x1b[32m✓\x1b[0m Saved notes.md again.\n"; out.String() != want {
		t.Fatalf("got %q\nwant %q", out.String(), want)
	}
}

// Reasons and problems quote file names and contents, which others can write.
func TestUINoticeKeepsTheTerminalSafe(t *testing.T) {
	var out strings.Builder
	u := newUI(&out, false, false)
	u.notice("notes.md", true, session.Notice{Kind: session.SaveFailed, Reason: "\x1b[2Jdisk\r\n full\u202e."})
	u.notice("notes.md", true, session.Notice{Kind: session.ChangeHeld, Reason: "\x1b]0;pwned\x07it is odd", Details: []string{"line\x1b[31m one\u2066"}})
	u.notice("notes.md", true, session.Notice{Kind: session.ImageNotSaved, Reason: "\x1b[0m."})
	want := `  Could not save notes.md: [2Jdisk full.
  pedit tries again every few seconds. Fix this before you press Ctrl+C, or the latest edits are not saved.
  notes.md changed outside pedit, but ]0;pwnedit is odd:
    line[31m one
  pedit saves again once it is fixed, and does not save over it until then.
  Fix it before you press Ctrl+C, or the latest edits are not saved.
  Could not save an image someone pasted into assets: [0m.
`
	if out.String() != want {
		t.Fatalf("got:\n%s\nwant:\n%s", out.String(), want)
	}
	if strings.ContainsAny(out.String(), "\x1b\x07\r\u202e\u2066") {
		t.Fatalf("control characters reached the terminal: %q", out.String())
	}
}

func TestUINoticeOfALostOrKeptSave(t *testing.T) {
	var out strings.Builder
	u := newUI(&out, false, false)
	u.notice("docs/notes.md", true, session.Notice{Kind: session.SaveLost})
	u.notice("docs/notes.md", true, session.Notice{Kind: session.SaveKept, Kept: ".pedit-0123" + "\x1b[2J" + ".tmp"})
	want := "  A save of docs/notes.md made outside pedit was lost: pedit wrote the file at the same moment.\n" +
		"  Save it again.\n" +
		"  docs/notes.md changed while pedit saved it, and pedit could not put that change back. It is kept in " + filepath.Join("docs", ".pedit-0123[2J.tmp") + ".\n" +
		"  Compare it with docs/notes.md and copy over what you need.\n"
	if out.String() != want {
		t.Fatalf("got:\n%s\nwant:\n%s", out.String(), want)
	}
}

func TestUIDoesNotTellWhatItDoesNotKnow(t *testing.T) {
	var out strings.Builder
	u := newUI(&out, false, false)
	u.notice("notes.md", true, session.Notice{Kind: "something-new"})
	if out.Len() != 0 {
		t.Fatalf("got %q", out.String())
	}
}

func TestUILiveLineWhenExpired(t *testing.T) {
	u := newUI(&strings.Builder{}, false, false)
	u.setStatus(protocol.StatusExpired)
	if got, want := u.liveLine(), "○ The room reached its time limit."; got != want {
		t.Errorf("got %q, want %q", got, want)
	}
}

func TestTimeLimitText(t *testing.T) {
	for d, want := range map[time.Duration]string{
		24 * time.Hour:   "24-hour limit",
		90 * time.Minute: "90-minute limit",
		45 * time.Second: "45-second limit",
		0:                "time limit",
	} {
		if got := timeLimitText(d); got != want {
			t.Errorf("%v: got %q, want %q", d, got, want)
		}
	}
}

func TestUIExpired(t *testing.T) {
	var host, guest strings.Builder
	newUI(&host, false, false).expired(true, 24*time.Hour)
	hostWant := "  The room reached its 24-hour limit on the relay and was closed.\n" +
		"  Run pedit again to start a new room.\n\n"
	if host.String() != hostWant {
		t.Errorf("host: got %q, want %q", host.String(), hostWant)
	}
	newUI(&guest, false, false).expired(false, 24*time.Hour)
	guestWant := "  The room reached its 24-hour limit on the relay and was closed.\n" +
		"  Ask the host to run pedit again for a new link.\n\n"
	if guest.String() != guestWant {
		t.Errorf("guest: got %q, want %q", guest.String(), guestWant)
	}
}

func TestUISharingSeveralFiles(t *testing.T) {
	var out strings.Builder
	u := newUI(&out, false, false)
	u.resumable = true
	u.sharing([]string{"agenda.md", "docs/spec.md"}, "https://pedit.example.com/r/AAAA#key", false, false)
	u.added("board.canvas")
	u.notAdded("big.md", errors.New("big.md is 2.0 MiB; pedit shares files up to about 1 MiB for now"))
	u.notAdded("x\x1b[2Jy.md", errors.New("cannot open x\x1b[2Jy.md"))
	for _, want := range []string{
		"agenda.md, docs/spec.md are ready to write together.",
		"Everything is saved to the files.",
		"To share another file in this room, type its path and press Enter.",
		"✓ Sharing board.canvas too.",
		"Could not share big.md: big.md is 2.0 MiB; pedit shares files up to about 1 MiB for now.",
		"Could not share x[2Jy.md: cannot open x[2Jy.md.",
	} {
		if !strings.Contains(out.String(), want) {
			t.Errorf("missing %q in:\n%s", want, out.String())
		}
	}
}

func TestUIMirroredFiles(t *testing.T) {
	var out strings.Builder
	u := newUI(&out, false, false)
	u.mirrored("docs/spec.md", "/tmp/pedit-x/01-docs-spec.md")
	u.notMirrored("board.canvas", errors.New("it is a canvas, which only a browser can open; open the link in a browser"))
	// Anyone in the room can name a file: the name cannot pass for pedit's words.
	u.mirrored("a.md) → \u200b01-b.md\u3000\x1b[2J", "/tmp/pedit-x/02-a-md-01-b-md-2J.md")
	for _, want := range []string{
		`✓ Also syncing /tmp/pedit-x/01-docs-spec.md ("docs/spec.md")`,
		`Not syncing "board.canvas": it is a canvas, which only a browser can open; open the link in a browser.`,
		`✓ Also syncing /tmp/pedit-x/02-a-md-01-b-md-2J.md ("a.md) → \u200b01-b.md\u3000\x1b[2J")`,
	} {
		if !strings.Contains(out.String(), want) {
			t.Errorf("missing %q in:\n%s", want, out.String())
		}
	}
}

func TestConnectionHistorySurvivesRecovery(t *testing.T) {
	for _, tty := range []bool{false, true} {
		for _, typing := range []bool{false, true} {
			if typing && !tty {
				continue
			}
			t.Run(fmt.Sprintf("tty=%t/typing=%t", tty, typing), func(t *testing.T) {
				var out strings.Builder
				u := newUI(&out, tty, true)
				u.sharing([]string{"notes.md"}, "https://example.com/r/room#key", false, false)
				u.setStatus(protocol.StatusConnected)
				if typing {
					u.startTyping()
					u.setTyped([]rune("draft.md"))
				}
				out.Reset()
				u.setStatus(protocol.StatusDisconnected)
				for range 3 {
					u.setStatus(protocol.StatusConnecting)
					u.setStatus(protocol.StatusDisconnected)
				}
				u.setStatus(protocol.StatusConnected)
				u.setStatus(protocol.StatusConnected)
				got := out.String()
				if strings.Count(got, "Back online. Changes sync again.") != 1 {
					t.Fatalf("missing recovery history: %q", got)
				}
				if strings.Contains(got, "Connecting…") {
					t.Fatalf("retry spam: %q", got)
				}
				if tty && !strings.Contains(got, "Offline. Reconnecting…\n") && !strings.Contains(got, "Offline. Reconnecting…\r\n") {
					t.Fatalf("offline history was erased: %q", got)
				}
				if !tty && strings.Count(got, "Offline. Reconnecting…") != 1 {
					t.Fatalf("offline spam: %q", got)
				}
				if typing && (!strings.HasSuffix(got, "Add a file: draft.md") || string(u.typed) != "draft.md") {
					t.Fatalf("lost input: %q", got)
				}
			})
		}
	}
}
