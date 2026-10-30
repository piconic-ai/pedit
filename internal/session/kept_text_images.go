package session

import (
	"context"

	"github.com/piconic-ai/pedit/internal/attach"
	"github.com/piconic-ai/pedit/internal/protocol"
)

// journalAndSaveImages records the new text in the journal, then saves its
// images.
func (h *keptTextHost) journalAndSaveImages(ctx context.Context) error {
	if e := saveKeptState(h.path, h.state); e != nil {
		return e
	}
	return h.saveImages(ctx)
}

// saveImages writes the images the kept texts refer to beside their files.
// Guests paste them into the relay while the host is away; the references
// travel in the text, so the host finds them in the merged document. It runs
// before finishWrites and the checkpoint, so the relay log is cut only after
// every image is on disk. An image the relay lacks or cannot prove to be the
// one named is reported once and does not stop the text from being written.
func (h *keptTextHost) saveImages(ctx context.Context) error {
	if h.blobKeys == nil {
		blobKeys, e := protocol.DeriveBlobKeys(h.keys.FrameKey)
		if e != nil {
			return e
		}
		// The host's token lets it fetch as well as a guest with the edit link.
		blobKeys.Admission = h.keys.EditAdmission
		h.blobKeys = blobKeys
	}
	h.imagesFailed = false
	for _, file := range h.state.Files {
		// Through the directory the text is written in, which stays the one
		// opened at the start even if its path is later swapped for a link.
		images := attach.New(attach.Options{File: file.File, Root: h.files[file.ID].bound.Dir(), Server: h.state.Origin, Room: h.room, Keys: h.blobKeys, HTTPClient: h.imageClient})
		_, errs := images.Restore(ctx, h.files[file.ID].doc.GetText("content").ToString())
		images.Close()
		if ctx.Err() != nil {
			return ctx.Err()
		}
		h.imagesFailed = h.imagesFailed || len(errs) > 0
		for _, e := range errs {
			h.reportImage(file.Path, e)
		}
	}
	return ctx.Err()
}

// reportImage tells of an image that could not be saved, once.
func (h *keptTextHost) reportImage(path string, err error) {
	key := path + ": " + err.Error()
	if h.onImageError == nil || h.imageErrors[key] {
		return
	}
	if h.imageErrors == nil {
		h.imageErrors = map[string]bool{}
	}
	h.imageErrors[key] = true
	h.onImageError(path, err)
}
