package main

import (
	"fmt"
	"io"
	"path/filepath"
	"strings"
	"sync"
	"time"
	"unicode"

	"github.com/piconic-ai/pedit/internal/attach"
	"github.com/piconic-ai/pedit/internal/protocol"
	"github.com/piconic-ai/pedit/internal/session"
)

// ui is what the person sharing the file reads. They are not necessarily an
// engineer, so it avoids jargon, puts the link to send first, and says what
// to do next. Everything is indented by two spaces and grouped by blank lines.
//
// The last line shows who is here and is rewritten in place on a terminal.
type ui struct {
	out   io.Writer
	tty   bool
	color bool

	mu       sync.Mutex
	live     bool
	status   protocol.Status
	people   []string
	lastLine string
	// signingIn is set while the sign-in block is on the alternate screen.
	signingIn bool
	// resumable is set when Enter picks a session up again after maintenance.
	resumable bool
}

func newUI(out io.Writer, tty, noColor bool) *ui {
	return &ui{out: out, tty: tty, color: tty && !noColor, status: protocol.StatusConnecting}
}

func (u *ui) paint(code, s string) string {
	if !u.color {
		return s
	}
	return "\x1b[" + code + "m" + s + "\x1b[0m"
}

func (u *ui) bold(s string) string   { return u.paint("1", s) }
func (u *ui) dim(s string) string    { return u.paint("2", s) }
func (u *ui) green(s string) string  { return u.paint("32", s) }
func (u *ui) yellow(s string) string { return u.paint("33", s) }
func (u *ui) link(s string) string   { return u.paint("36;4", s) }

func (u *ui) print(lines ...string) {
	u.mu.Lock()
	defer u.mu.Unlock()
	for _, line := range lines {
		if line == "" {
			fmt.Fprintln(u.out)
		} else {
			fmt.Fprintln(u.out, "  "+line)
		}
	}
}

// signIn is shown while the browser is open to sign in. On a terminal it
// goes on the alternate screen, like less or vim, so that endSignIn brings
// back the screen as it was: nothing to count or erase, whatever the user
// types or however they resize the window meanwhile.
func (u *ui) signIn(host, url string) {
	u.mu.Lock()
	if u.tty && !u.signingIn {
		fmt.Fprint(u.out, "\x1b[?1049h\x1b[H")
		u.signingIn = true
	}
	u.mu.Unlock()
	u.print(
		"",
		u.bold("Sign in to "+host),
		"Your browser opened. Sign in there, then come back here.",
		"",
		u.dim("If it did not open, use this link:"),
		u.dim(url),
		"",
		"Clicked Deny, or changed your mind? Press Ctrl+C to stop.",
	)
}

// signInCancelled is shown when the user stopped signing in with Ctrl+C.
func (u *ui) signInCancelled() {
	u.print("", "Sign-in cancelled. Nothing was shared.", "")
}

// signInTimedOut is shown when signing in took longer than limit.
func (u *ui) signInTimedOut(limit time.Duration) {
	u.print("", u.yellow("Sign-in did not finish in "+minutes(limit)+".")+" Run pedit again to try again.", "")
}

func minutes(d time.Duration) string {
	if m := int(d.Minutes()); m != 1 {
		return fmt.Sprintf("%d minutes", m)
	}
	return "1 minute"
}

// endSignIn leaves the alternate screen, if signIn went there. Call it
// whether or not signing in worked, before printing anything else.
func (u *ui) endSignIn() {
	u.mu.Lock()
	defer u.mu.Unlock()
	if u.signingIn {
		fmt.Fprint(u.out, "\x1b[?1049l")
		u.signingIn = false
	}
}

func (u *ui) signedIn(email string) {
	if email != "" {
		u.print("", u.green("✓")+" Signed in as "+email)
	}
}

// sharing shows the link to send, then starts the live line.
// With scratch set, it also says how to come back to the new file.
func (u *ui) sharing(files []string, url string, copied, scratch bool) {
	file := files[0]
	ready := u.bold(file + " is ready to write together.")
	saved := "Everything is saved to " + file + "."
	if len(files) > 1 {
		ready = u.bold(strings.Join(files, ", ") + " are ready to write together.")
		saved = "Everything is saved to the files."
	}
	lines := []string{
		"",
		ready,
		"",
		"Send this link to the people you want to invite:",
		"  " + u.link(url),
	}
	if copied {
		lines = append(lines, "  "+u.dim("Copied to your clipboard."))
	}
	lines = append(lines, "", u.dim("Press Ctrl+C when you are done. "+saved))
	if u.resumable {
		lines = append(lines, u.dim("To share another file in this room, type its path and press Enter."))
	}
	lines = append(lines, "")
	if scratch {
		lines = append(lines, u.resume(file), "")
	}
	u.print(lines...)

	u.mu.Lock()
	defer u.mu.Unlock()
	u.live = true
	u.render()
}

// joined says where the room's file is mirrored, and what happens to the copy
// on leaving: a temporary one is removed, one placed with -d stays.
func (u *ui) joined(file string, temporary, copied bool) {
	lines := []string{
		"",
		u.bold("Joined. Your copy of the shared file:"),
		"  " + u.link(file),
	}
	if copied {
		lines = append(lines, "  "+u.dim("Copied to your clipboard."))
	}
	lines = append(lines, "", "Edit it with any editor; changes sync both ways while you are in the room.")
	if temporary {
		lines = append(lines, u.dim("Press Ctrl+C to leave. The copy is temporary and removed then; -d <dir> keeps one."))
	} else {
		lines = append(lines, u.dim("Press Ctrl+C to leave. Your copy stays in "+file+"."))
	}
	lines = append(lines, "")
	u.print(lines...)
	u.mu.Lock()
	defer u.mu.Unlock()
	u.live = true
	u.render()
}

// hostLeft explains why the session ends on its own.
func (u *ui) hostLeft() {
	u.print("", u.yellow("The host closed the room."))
}

// outdated explains that the server turned this pedit away for speaking
// another protocol version, and what to do about it. command upgrades pedit,
// or is "" when pedit cannot tell how it was installed.
func (u *ui) outdated(st protocol.Status, command string) {
	if st == protocol.StatusServerOutdated {
		u.print(u.yellow("The server is older than this pedit and cannot be used with it."),
			"Ask whoever runs the server to update it, or use an older pedit.", "")
		return
	}
	lines := []string{u.yellow("This pedit is too old for the server. Update it and run pedit again.")}
	if command != "" {
		lines = append(lines, "To upgrade, run: "+u.bold(command))
	} else {
		lines = append(lines, u.link(installURL))
	}
	u.print(append(lines, "")...)
}

// maintenance says the session ended because the relay closed for maintenance.
func (u *ui) maintenance() {
	u.print(u.yellow("The relay was closed for maintenance. Run pedit again once it is back."), "")
}

// tooLarge says why the session ended on its own: the shared document grew
// past what the relay takes. For the host it names file, the shared file, and
// the next step: a new room starts from the file as saved, or is refused with
// the real size.
func (u *ui) tooLarge(host bool, file string) {
	if host {
		u.print(u.yellow("The room was closed: "+file+" and its edits grew past what pedit can share ("+session.SizeLimit+" for now)."),
			"Run pedit again to start a new room.", "")
		return
	}
	limit := "pedit shares files up to " + session.SizeLimit + " for now."
	u.print(u.yellow("pedit left the room: the shared file grew too large to share. "+limit),
		"Your latest changes may not have reached the others.", "")
}

// timeLimitText names a relay's room time limit, or just "time limit" when the
// relay did not say.
func timeLimitText(d time.Duration) string {
	switch {
	case d <= 0:
		return "time limit"
	case d%time.Hour == 0:
		return fmt.Sprintf("%d-hour limit", d/time.Hour)
	case d%time.Minute == 0:
		return fmt.Sprintf("%d-minute limit", d/time.Minute)
	}
	return fmt.Sprintf("%d-second limit", d/time.Second)
}

// expired says that the room reached the relay's time limit and ended for good.
func (u *ui) expired(host bool, limit time.Duration) {
	then := "Ask the host to run pedit again for a new link."
	if host {
		then = "Run pedit again to start a new room."
	}
	u.print(u.yellow("The room reached its "+timeLimitText(limit)+" on the relay and was closed."), then, "")
}

// installURL explains every way to install, and so to update, pedit.
const installURL = "https://github.com/piconic-ai/pedit#install"

// left confirms the copy is saved after leaving a room.
func (u *ui) left(file string) {
	u.print(u.green("✓")+" Saved "+file+". It no longer syncs with the room.", "")
}

// leftTemporary confirms nothing is left behind after leaving a room.
func (u *ui) leftTemporary() {
	u.print("", u.green("✓")+" Left the room. The temporary copy was removed.", "")
}

func (u *ui) setStatus(s protocol.Status) {
	u.mu.Lock()
	defer u.mu.Unlock()
	u.status = s
	u.render()
}

func (u *ui) setPeople(names []string) {
	u.mu.Lock()
	defer u.mu.Unlock()
	u.people = names
	u.render()
}

// above prints lines above the live line. On a terminal the live line is
// cleared first and drawn again below them.
func (u *ui) above(lines ...string) {
	u.mu.Lock()
	defer u.mu.Unlock()
	if u.live && u.tty {
		fmt.Fprint(u.out, "\r\x1b[2K")
		u.lastLine = ""
	}
	for _, line := range lines {
		if line == "" {
			fmt.Fprintln(u.out)
		} else {
			fmt.Fprintln(u.out, "  "+line)
		}
	}
	u.render()
}

// added says that a file typed in is now shared in the room.
func (u *ui) added(path string) {
	u.above(u.green("✓") + " Sharing " + printable(path) + " too.")
}

// notAdded says why a file typed in is not shared.
func (u *ui) notAdded(path string, err error) {
	u.above(u.yellow("Could not share " + printable(path) + ": " + printable(err.Error()) + "."))
}

// mirrored says that another file of the room is copied beside the first.
func (u *ui) mirrored(path string) {
	u.above(u.green("✓") + " Also syncing " + printable(path))
}

// notMirrored says why another file of the room is not copied.
func (u *ui) notMirrored(path string, err error) {
	u.above(u.yellow("Not syncing " + printable(path) + ": " + printable(err.Error()) + "."))
}

// imageSaved says that an image someone pasted was written to the host's
// disk.
func (u *ui) imageSaved(path string) {
	u.above(u.dim("Saved an image to " + path))
}

// notice tells about a condition of the file the user can act on, and what to
// do about it. file is the shared file, or the copy when host is false. The
// session decides what is worth saying and when; this only words it, and says
// nothing about a kind it does not know.
func (u *ui) notice(file string, host bool, n session.Notice) {
	reason := strings.TrimRight(printable(n.Reason), ".")
	switch n.Kind {
	case session.SaveFailed:
		next := "pedit tries again every few seconds. Until then, your copy misses the latest edits."
		if host {
			next = "pedit tries again every few seconds. Fix this before you press Ctrl+C, or the latest edits are not saved."
		}
		u.above(u.yellow("Could not save "+file+": "+reason+"."), next)
	case session.SaveRecovered:
		u.above(u.green("✓") + " Saved " + file + " again.")
	case session.ChangeHeld:
		head := file + " changed outside pedit, but " + reason
		if len(n.Details) > 0 {
			head += ":"
		} else {
			head += "."
		}
		lines := []string{u.yellow(head)}
		for _, detail := range n.Details {
			lines = append(lines, "  "+printable(detail))
		}
		lines = append(lines, "pedit saves again once it is fixed, and does not save over it until then.")
		if host {
			lines = append(lines, "Fix it before you press Ctrl+C, or the latest edits are not saved.")
		}
		u.above(lines...)
	case session.HoldReleased:
		u.above(u.green("✓") + " " + file + " is fixed. Saving goes on.")
	case session.ImageNotSaved:
		dir := filepath.Join(filepath.Dir(file), attach.Dir)
		u.above(u.yellow("Could not save an image someone pasted into " + dir + ": " + reason + "."))
	case session.SaveLost:
		u.above(u.yellow("A save of "+file+" made outside pedit was lost: pedit wrote the file at the same moment."), "Save it again.")
	case session.SaveKept:
		kept := filepath.Join(filepath.Dir(file), printable(n.Kept))
		u.above(u.yellow(file+" changed while pedit saved it, and pedit could not put that change back. It is kept in "+kept+"."), "Compare it with "+file+" and copy over what you need.")
	}
}

// printable drops what could move the cursor or reorder the text. Reasons
// and problems quote file names and contents, which others can write.
func printable(s string) string {
	return strings.Map(func(r rune) rune {
		if unicode.IsControl(r) || unicode.Is(unicode.Bidi_Control, r) {
			return -1
		}
		return r
	}, s)
}

// stopLive ends the live line, leaving its last state on screen.
func (u *ui) stopLive() {
	u.mu.Lock()
	defer u.mu.Unlock()
	if u.live && u.tty {
		fmt.Fprintln(u.out)
	}
	u.live = false
}

func (u *ui) saving(file string) {
	u.print("", "Saving "+file+"…")
}

func (u *ui) saved(file string) {
	u.print(u.green("✓")+" Saved "+file+". The link no longer works.", "")
}

// updateAvailable points to a newer release and how to upgrade to it.
func (u *ui) updateAvailable(current string, latest release, command string) {
	lines := []string{u.yellow("A new release of pedit is available: ") + current + " → " + u.bold(latest.Version)}
	if command != "" {
		lines = append(lines, "To upgrade, run: "+u.bold(command))
	}
	lines = append(lines, u.link(latest.URL), "")
	u.print(lines...)
}

// scratch names the scratch file pedit created and how to open it again.
func (u *ui) scratch(file string) {
	u.print("Saved to "+file, u.resume(file), "")
}

func (u *ui) resume(file string) string {
	return "Resume with: " + u.bold("pedit "+file)
}

// render redraws the live line. Callers hold u.mu.
func (u *ui) render() {
	if !u.live {
		return
	}
	line := u.liveLine()
	if line == u.lastLine {
		return
	}
	u.lastLine = line
	if u.tty {
		fmt.Fprint(u.out, "\r\x1b[2K  "+line)
	} else {
		fmt.Fprintln(u.out, "  "+line)
	}
}

func (u *ui) liveLine() string {
	switch u.status {
	case protocol.StatusConnected:
		return u.green("●") + " " + whoIsHere(u.people)
	case protocol.StatusDisconnected:
		return u.yellow("○") + " Offline. Reconnecting…"
	case protocol.StatusBusy:
		return u.yellow("○") + " The relay is busy. Retrying…"
	case protocol.StatusClosed:
		return u.yellow("○") + " Closed."
	case protocol.StatusFull:
		return u.yellow("○") + " The room is full."
	case protocol.StatusMaintenance:
		if u.resumable {
			return u.yellow("○") + " The relay is closed for maintenance. Press Enter to reconnect, Ctrl+C to quit."
		}
		return u.yellow("○") + " The relay is closed for maintenance."
	case protocol.StatusClientOutdated:
		return u.yellow("○") + " This pedit is out of date."
	case protocol.StatusServerOutdated:
		return u.yellow("○") + " The server is out of date."
	case protocol.StatusTooLarge:
		return u.yellow("○") + " The file grew too large to share."
	case protocol.StatusExpired:
		return u.yellow("○") + " The room reached its time limit."
	default:
		return u.yellow("○") + " Connecting…"
	}
}

// whoIsHere names up to three people and counts the rest, so the line stays short.
func whoIsHere(names []string) string {
	switch n := len(names); {
	case n == 0:
		return "Just you so far"
	case n == 1:
		return names[0] + " is here"
	case n == 2:
		return names[0] + " and " + names[1] + " are here"
	case n == 3:
		return names[0] + ", " + names[1] + " and " + names[2] + " are here"
	default:
		return fmt.Sprintf("%s, %s and %d others are here", names[0], names[1], n-2)
	}
}

// hostOf is the server as people know it: its host name.
func hostOf(server string) string {
	s := strings.TrimPrefix(strings.TrimPrefix(server, "https://"), "http://")
	return strings.TrimRight(s, "/")
}
