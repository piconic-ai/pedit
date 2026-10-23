package session

import (
	"errors"
	"io/fs"
	"os"
	"sync"

	"github.com/piconic-ai/pedit/internal/attach"
	"github.com/piconic-ai/pedit/internal/canvas"
	"github.com/piconic-ai/pedit/internal/filewriter"
)

// NoticeKind names a condition of the local file that the user can act on.
type NoticeKind string

const (
	// SaveFailed means the file could not be saved, and could not when tried
	// again either. The edits are kept, and the save is tried again until it
	// lands.
	SaveFailed NoticeKind = "save-failed"
	// SaveRecovered means a save landed after SaveFailed.
	SaveRecovered NoticeKind = "save-recovered"
	// ChangeHeld means the file changed outside pedit into something pedit
	// cannot take in, so pedit does not save over it until it is fixed.
	ChangeHeld NoticeKind = "change-held"
	// HoldReleased means that after ChangeHeld, the file was fixed or put
	// back, and saving goes on.
	HoldReleased NoticeKind = "hold-released"
	// ImageNotSaved means an image someone pasted could not be saved beside
	// the file. They are told it was not added.
	ImageNotSaved NoticeKind = "image-not-saved"
	// SaveLost means a save made outside pedit while pedit wrote the file was
	// written into the file pedit's write replaced, and is lost. Only where
	// files cannot be exchanged, such as on Windows.
	SaveLost NoticeKind = "save-lost"
	// SaveKept means pedit moved aside what was in the file while it wrote it,
	// and could not put it back: a save made outside pedit may be in Kept.
	SaveKept NoticeKind = "save-kept"
	// CommentsOff means the file offers no comments in the room, for Reason,
	// such as being outside the project or its metadata not being readable.
	CommentsOff NoticeKind = "comments-off"
	// CommentsHeld means the file that keeps the comments of a shared file
	// (File) changed outside pedit, so pedit no longer saves comments to it.
	CommentsHeld NoticeKind = "comments-held"
)

// Notice tells the user about a condition of the local file they can act on.
// Errors nobody can act on, or that clear by themselves, go to OnError.
type Notice struct {
	Kind NoticeKind
	// File is the path of the shared file, or of the copy when joined.
	File string
	// Reason says why in a few words, for SaveFailed, ChangeHeld and
	// ImageNotSaved. It is the same each time the same cause comes back.
	Reason string
	// Details are more lines about Reason, such as each problem in a canvas.
	Details []string
	// Kept is the temporary name, beside File, a save is kept under, for
	// SaveKept.
	Kept string
	// Err is the error behind the notice, for diagnostics.
	Err error
}

// notices decides which problems with the local file the user is told about,
// and when. Each condition is told once when it starts or its cause changes,
// and once when it ends, however often it is seen. What is not told goes to
// debug, so every failure is reported once, either way.
//
// notify is called with mu held, so notices arrive one at a time and in the
// order they happened.
type notices struct {
	file   string
	notify func(Notice)
	debug  func(error)

	mu sync.Mutex
	// on is set while the session runs. Before that, Start and Join return
	// what goes wrong as an error, and after that, so does Stop.
	on bool
	// saveFailures counts the saves that failed since one landed.
	saveFailures int
	// saveFailed is the reason SaveFailed gave, or "" when none is showing.
	saveFailed string
	// imageFailed is the reason ImageNotSaved gave last, until an image is saved.
	imageFailed string
}

// newNotices tells notify, which may be nil, and passes the rest to debug.
func newNotices(file string, notify func(Notice), debug func(error)) *notices {
	if debug == nil {
		debug = func(error) {}
	}
	if notify == nil {
		// Nobody listens for notices: do not lose the failures.
		notify = func(n Notice) {
			if n.Err != nil {
				debug(n.Err)
			}
		}
	}
	return &notices{file: file, notify: notify, debug: debug}
}

// start turns notices on, once setup is over.
func (n *notices) start() {
	n.mu.Lock()
	defer n.mu.Unlock()
	n.on = true
}

// stop turns notices off. Stop returns what goes wrong from then on.
func (n *notices) stop() {
	n.mu.Lock()
	defer n.mu.Unlock()
	n.on = false
}

// send tells the user notice, unless notices are off.
func (n *notices) send(notice Notice) {
	n.mu.Lock()
	defer n.mu.Unlock()
	if !n.on {
		if notice.Err != nil {
			n.debug(notice.Err)
		}
		return
	}
	notice.File = n.file
	n.notify(notice)
}

// saveError takes a write of the file that failed, or that lost a save.
func (n *notices) saveError(err error) {
	n.mu.Lock()
	defer n.mu.Unlock()
	if notice, ok := lostSave(err); ok {
		// Each is another save: told every time, and not a save of pedit's
		// that failed.
		if !n.on {
			n.debug(err)
			return
		}
		notice.File = n.file
		n.notify(notice)
		return
	}
	if !n.on {
		n.debug(err)
		return
	}
	n.saveFailures++
	why := reason(err)
	// One failure may fix itself, such as a file another program holds for a
	// moment. Tell the user when it comes back, or its cause changes.
	if n.saveFailures < 2 || why == n.saveFailed {
		n.debug(err)
		return
	}
	n.saveFailed = why
	n.notify(Notice{Kind: SaveFailed, File: n.file, Reason: why, Err: err})
}

// written takes a write that landed, and tells so if a failure was showing.
func (n *notices) written() {
	n.mu.Lock()
	defer n.mu.Unlock()
	n.saveFailures = 0
	if n.saveFailed == "" {
		return
	}
	n.saveFailed = ""
	if n.on {
		n.notify(Notice{Kind: SaveRecovered, File: n.file})
	}
}

// imageError takes an image that could not be saved beside the file.
func (n *notices) imageError(err error) {
	n.mu.Lock()
	defer n.mu.Unlock()
	why := reason(err)
	if !n.on || why == n.imageFailed {
		n.debug(err)
		return
	}
	n.imageFailed = why
	n.notify(Notice{Kind: ImageNotSaved, File: n.file, Reason: why, Err: err})
}

// imageSaved takes an image that was saved: the next failure is told again.
func (n *notices) imageSaved() {
	n.mu.Lock()
	defer n.mu.Unlock()
	n.imageFailed = ""
}

// lostSave tells whether err reports a save made outside pedit that a write
// lost, or set aside and could not put back.
func lostSave(err error) (Notice, bool) {
	var kept *filewriter.KeptError
	if errors.As(err, &kept) {
		return Notice{Kind: SaveKept, Kept: kept.Name, Err: err}, true
	}
	if errors.Is(err, filewriter.ErrSaveOverwritten) {
		return Notice{Kind: SaveLost, Err: err}, true
	}
	return Notice{}, false
}

// reason says why err happened in a few words. It leaves out the names of
// temporary files, which differ each time, so the same cause reads the same.
func reason(err error) string {
	var pathErr *fs.PathError
	var linkErr *os.LinkError
	switch {
	case errors.Is(err, filewriter.ErrNotRegular):
		return "it is no longer a regular file"
	case errors.Is(err, attach.ErrLinkedOut):
		// Before the path error it wraps, which only says the path escapes.
		return attach.ErrLinkedOut.Error()
	case errors.As(err, &pathErr):
		return pathErr.Err.Error()
	case errors.As(err, &linkErr):
		return linkErr.Err.Error()
	}
	return err.Error()
}

// held is the notice for a change to the file that pedit cannot take in. name
// is what the file is called in the problems listed.
func held(name string, err error) Notice {
	n := Notice{Kind: ChangeHeld, Reason: reason(err), Err: err}
	var invalid *canvas.Error
	if errors.As(err, &invalid) {
		n.Reason = "it is not a valid JSON Canvas (" + canvas.Spec + ")"
		n.Details = invalid.Lines(name)
	}
	return n
}
