package session

import (
	"errors"
	"fmt"
	"io/fs"
	"os"
	"slices"
	"strings"
	"testing"

	"github.com/piconic-ai/pedit/internal/attach"
	"github.com/piconic-ai/pedit/internal/canvas"
	"github.com/piconic-ai/pedit/internal/filewriter"
)

// failures records the notices and the errors that were not told.
type failures struct {
	told     []Notice
	debugged []error
}

func (f *failures) notices(file string) *notices {
	return newNotices(file, func(n Notice) { f.told = append(f.told, n) }, func(err error) { f.debugged = append(f.debugged, err) })
}

// toldKinds are the kinds and reasons told, as "kind:reason".
func (f *failures) toldKinds() string {
	var out []string
	for _, n := range f.told {
		out = append(out, string(n.Kind)+":"+n.Reason)
	}
	return strings.Join(out, ",")
}

// debuggedPaths are the paths of the errors that were not told, which the
// tests give a number each.
func (f *failures) debuggedPaths() string {
	var out []string
	for _, err := range f.debugged {
		var pathErr *fs.PathError
		if errors.As(err, &pathErr) {
			out = append(out, pathErr.Path)
		} else {
			out = append(out, err.Error())
		}
	}
	return strings.Join(out, ",")
}

func TestNoticesTellEachConditionOnce(t *testing.T) {
	var f failures
	n := f.notices("notes.md")
	denied := func(name string) error {
		return &fs.PathError{Op: "openat", Path: name, Err: fs.ErrPermission}
	}
	notADirectory := &fs.PathError{Op: "openat", Path: "assets", Err: errors.New("not a directory")}

	// Setup returns its failures as errors.
	n.saveError(denied(".pedit-1.tmp"))
	n.start()

	// A save that fails once, and lands when tried again, fixed itself.
	n.saveError(denied(".pedit-2.tmp"))
	n.written()
	// Failing twice in a row is told, and not again for the same reason.
	n.saveError(denied(".pedit-3.tmp"))
	n.saveError(denied(".pedit-4.tmp"))
	n.saveError(denied(".pedit-5.tmp"))
	// Another reason is told as well.
	n.saveError(errors.New("disk on fire"))

	// An image that was not saved is told on the first failure, and again for
	// another reason, or once an image was saved.
	n.imageError(notADirectory)
	n.imageError(notADirectory)
	n.imageError(fmt.Errorf("%s %w: %w", attach.Dir, attach.ErrLinkedOut, notADirectory))
	n.imageSaved()
	n.imageError(notADirectory)

	// Recovery is told once, when the failure was.
	n.written()
	n.written()
	n.saveError(denied(".pedit-6.tmp"))
	n.written()
	n.saveError(denied(".pedit-7.tmp"))

	want := strings.Join([]string{
		"save-failed:permission denied",
		"save-failed:disk on fire",
		"image-not-saved:not a directory",
		"image-not-saved:it links out of the shared file's folder",
		"image-not-saved:not a directory",
		"save-recovered:",
	}, ",")
	if got := f.toldKinds(); got != want {
		t.Errorf("told\n%s\nwant\n%s", strings.ReplaceAll(got, ",", "\n"), strings.ReplaceAll(want, ",", "\n"))
	}
	// Everything not told is for PEDIT_DEBUG, so each failure shows once.
	const wantDebugged = ".pedit-1.tmp,.pedit-2.tmp,.pedit-3.tmp,.pedit-5.tmp,assets,.pedit-6.tmp,.pedit-7.tmp"
	if got := f.debuggedPaths(); got != wantDebugged {
		t.Errorf("debugged %s, want %s", got, wantDebugged)
	}
	for _, notice := range f.told {
		if notice.File != "notes.md" {
			t.Errorf("File = %q", notice.File)
		}
		if notice.Kind != SaveRecovered && notice.Err == nil {
			t.Errorf("%s has no error", notice.Kind)
		}
	}
}

func TestNoticesAreOffBeforeStartAndAfterStop(t *testing.T) {
	var f failures
	n := f.notices("notes.md")
	denied := &fs.PathError{Op: "openat", Path: ".pedit-1.tmp", Err: fs.ErrPermission}
	unreadable := errors.New("not UTF-8")

	n.saveError(denied)
	n.saveError(denied)
	n.imageError(denied)
	n.send(Notice{Kind: ChangeHeld, Err: unreadable})
	n.send(Notice{Kind: HoldReleased})
	if len(f.told) != 0 || len(f.debugged) != 4 {
		t.Fatalf("before start: told %v, debugged %v", f.told, f.debugged)
	}

	n.start()
	n.send(Notice{Kind: ChangeHeld, Err: unreadable})
	n.send(Notice{Kind: HoldReleased})
	if got := f.toldKinds(); got != "change-held:,hold-released:" || len(f.debugged) != 4 {
		t.Fatalf("running: told %q, debugged %v", got, f.debugged)
	}
	if f.told[0].File != "notes.md" || f.told[0].Err != unreadable {
		t.Errorf("notice = %+v", f.told[0])
	}

	// A failure showing when notices go off is not told to have ended.
	n.saveError(denied)
	n.saveError(denied)
	n.stop()
	n.written()
	n.saveError(denied)
	n.send(Notice{Kind: ChangeHeld, Err: unreadable})
	if got := f.toldKinds(); got != "change-held:,hold-released:,save-failed:permission denied" || len(f.debugged) != 7 {
		t.Fatalf("stopped: told %q, debugged %v", got, f.debugged)
	}
}

func TestNoticesTellEachLostOrKeptSave(t *testing.T) {
	var f failures
	n := f.notices("notes.md")
	kept := &filewriter.KeptError{Name: ".pedit-k.tmp", Err: fmt.Errorf("%w: notes.md kept changing while pedit saved it; a save it moved aside is kept in .pedit-k.tmp", filewriter.ErrExternalChange)}
	lost := fmt.Errorf("wrapped: %w", filewriter.ErrSaveOverwritten)
	denied := &fs.PathError{Op: "openat", Path: ".pedit-1.tmp", Err: fs.ErrPermission}

	n.saveError(kept)
	n.start()
	n.saveError(denied)
	n.saveError(kept)
	n.saveError(lost)
	n.saveError(lost)
	n.saveError(denied)
	n.stop()
	n.saveError(lost)

	// A lost or kept save is told each time, and is not a failed save of
	// pedit's: the failed save told is the second of the two that were.
	var got []string
	for _, notice := range f.told {
		got = append(got, string(notice.Kind)+":"+notice.Kept)
		if notice.File != "notes.md" {
			t.Errorf("File = %q", notice.File)
		}
	}
	if want := "save-kept:.pedit-k.tmp,save-lost:,save-lost:,save-failed:"; strings.Join(got, ",") != want {
		t.Errorf("told %s, want %s", strings.Join(got, ","), want)
	}
	// Compared by identity: each is the very error it was.
	if len(f.debugged) != 3 || f.debugged[0] != error(kept) || f.debugged[1] != error(denied) || f.debugged[2] != lost {
		t.Errorf("debugged = %v", f.debugged)
	}
}

func TestNoticesWithoutAListenerGoToDebug(t *testing.T) {
	var debugged []error
	n := newNotices("notes.md", nil, func(err error) { debugged = append(debugged, err) })
	n.start()
	denied := &fs.PathError{Op: "openat", Path: ".pedit-1.tmp", Err: fs.ErrPermission}
	n.saveError(denied)
	n.saveError(denied)
	n.send(Notice{Kind: ChangeHeld, Err: errNotUTF8})
	n.send(Notice{Kind: HoldReleased})
	n.written()
	if len(debugged) != 3 || debugged[0] != error(denied) || debugged[1] != error(denied) || debugged[2] != errNotUTF8 {
		t.Fatalf("debugged = %v", debugged)
	}
}

// With neither a listener nor a debug function, the failures have nowhere to
// go, and that must not panic.
func TestNoticesWithoutListenerOrDebugDropFailures(t *testing.T) {
	n := newNotices("notes.md", nil, nil)
	denied := &fs.PathError{Op: "openat", Path: ".pedit-1.tmp", Err: fs.ErrPermission}
	// Off: Start and Join return these themselves.
	n.saveError(denied)
	n.send(Notice{Kind: ChangeHeld, Err: errNotUTF8})
	n.imageError(denied)
	n.start()
	n.saveError(denied)
	n.saveError(denied)
	n.send(Notice{Kind: ChangeHeld, Err: errNotUTF8})
	n.imageError(denied)
	n.written()
}

func TestReason(t *testing.T) {
	denied := &fs.PathError{Op: "openat", Path: ".pedit-0123.tmp", Err: fs.ErrPermission}
	tests := []struct {
		name string
		err  error
		want string
	}{
		{"plain", errors.New("disk on fire"), "disk on fire"},
		{"not a regular file", fmt.Errorf("shared file notes.md is %w", filewriter.ErrNotRegular), "it is no longer a regular file"},
		{"a link out of the folder", fmt.Errorf("%s %w: %w", attach.Dir, attach.ErrLinkedOut, &fs.PathError{Op: "openat", Path: "assets", Err: errors.New("path escapes from parent")}), "it links out of the shared file's folder"},
		{"a path error", denied, "permission denied"},
		{"a wrapped path error", fmt.Errorf("cannot write: %w", denied), "permission denied"},
		{"a joined path error", errors.Join(errors.New("closing"), denied), "permission denied"},
		{"a link error", &os.LinkError{Op: "rename", Old: ".pedit-0123.tmp", New: "notes.md", Err: fs.ErrPermission}, "permission denied"},
		{"not a regular file before the path", fmt.Errorf("%w: %w", filewriter.ErrNotRegular, denied), "it is no longer a regular file"},
	}
	for _, tt := range tests {
		if got := reason(tt.err); got != tt.want {
			t.Errorf("%s: reason = %q, want %q", tt.name, got, tt.want)
		}
	}
}

func TestHeld(t *testing.T) {
	t.Run("text that is not UTF-8", func(t *testing.T) {
		n := held("notes.md", errNotUTF8)
		if n.Kind != ChangeHeld || n.Reason != "it is not UTF-8 text" || n.Details != nil || n.Err != errNotUTF8 {
			t.Fatalf("notice = %+v", n)
		}
	})

	t.Run("a canvas that does not parse", func(t *testing.T) {
		_, err := canvas.Parse([]byte("{\"nodes\":[\n{\"id\":\"a\",\"type\":\"text\",\"x\":0,\"y\":0,\"width\":1}]}"))
		if err == nil {
			t.Fatal("parsed an invalid canvas")
		}
		n := held("board.canvas", err)
		want := []string{
			`board.canvas:2:1: nodes[0] (id "a"): has no "height"; add it as a number`,
			`board.canvas:2:1: nodes[0] (id "a"): has no "text"; add it as a string`,
		}
		if n.Kind != ChangeHeld || n.Reason != "it is not a valid JSON Canvas (https://jsoncanvas.org/spec/1.0/)" || !slices.Equal(n.Details, want) || n.Err != err {
			t.Fatalf("notice = %+v", n)
		}
	})
}
