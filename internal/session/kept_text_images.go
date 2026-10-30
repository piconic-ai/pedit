package session

import (
	"context"

	"github.com/piconic-ai/pedit/internal/attach"
	"github.com/piconic-ai/pedit/internal/protocol"
)

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
	for _, file := range h.state.Files {
		images := attach.New(attach.Options{File: file.File, Server: h.state.Origin, Room: h.room, Keys: h.blobKeys, HTTPClient: h.imageClient})
		_, errs := images.Restore(ctx, h.files[file.ID].doc.GetText("content").ToString())
		images.Close()
		if ctx.Err() != nil {
			return ctx.Err()
		}
		for _, e := range errs {
			if h.onImageError != nil && !h.imageErrors[e.Error()] {
				if h.imageErrors == nil {
					h.imageErrors = map[string]bool{}
				}
				h.imageErrors[e.Error()] = true
				h.onImageError(file.Path, e)
			}
		}
	}
	return ctx.Err()
}
