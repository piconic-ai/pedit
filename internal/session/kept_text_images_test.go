package session

import (
	"bytes"
	"context"
	"errors"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/piconic-ai/pedit/internal/attach"
	"github.com/piconic-ai/pedit/internal/protocol"
)

var keptPNG = []byte("\x89PNG\r\n\x1a\n kept image")

// keptImageRoom resumes a room whose host edited notes.md while away to
// reference an image. blobs maps a content hash to what the relay holds; gets
// counts the blob requests and cutAfterImage tells whether the image was on
// disk when the relay log was cut.
func keptImageRoom(t *testing.T, hash string, blobs map[string][]byte) (h *keptTextHost, gets *int, cutAfterImage *bool, errs *[]error) {
	t.Helper()
	h, _ = keptLocalRoom(t, "one\ntwo\nthree ![](assets/"+hash+".png)\n", false)
	blobKeys, err := protocol.DeriveBlobKeys(h.keys.FrameKey)
	if err != nil {
		t.Fatal(err)
	}
	gets, cutAfterImage, errs = new(int), new(bool), new([]error)
	relay := h.client.Transport
	h.client = &http.Client{Transport: keepFixTransport(func(r *http.Request) (*http.Response, error) {
		if r.Method == "POST" && r.Header.Get("X-Pedit-Cutoff") != "" {
			_, e := os.Stat(filepath.Join(filepath.Dir(h.state.Files[0].File), "assets", hash+".png"))
			*cutAfterImage = e == nil
		}
		return relay.RoundTrip(r)
	})}
	h.imageClient = &http.Client{Transport: keepFixTransport(func(r *http.Request) (*http.Response, error) {
		*gets++
		if r.Header.Get(protocol.AdmissionHeader) != h.keys.EditAdmission {
			return &http.Response{StatusCode: 403, Header: http.Header{}, Body: http.NoBody}, nil
		}
		for known, content := range blobs {
			id, _ := blobKeys.BlobID(known)
			if strings.HasSuffix(r.URL.Path, "/blobs/"+id) {
				return &http.Response{StatusCode: 200, Header: http.Header{}, Body: io.NopCloser(bytes.NewReader(blobKeys.Encrypt(content)))}, nil
			}
		}
		return &http.Response{StatusCode: 404, Header: http.Header{}, Body: http.NoBody}, nil
	})}
	h.onImageError = func(_ string, err error) { *errs = append(*errs, err) }
	if err := h.openFiles(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(h.closeFiles)
	if err := h.restore(); err != nil {
		t.Fatal(err)
	}
	return h, gets, cutAfterImage, errs
}

func TestKeptResumeSavesReferencedImagesBeforeCuttingTheLog(t *testing.T) {
	hash := protocol.ContentHash(keptPNG)
	h, gets, cutAfterImage, errs := keptImageRoom(t, hash, map[string][]byte{hash: keptPNG})
	if err := h.sync(context.Background()); err != nil {
		t.Fatal(err)
	}
	saved, err := os.ReadFile(filepath.Join(filepath.Dir(h.state.Files[0].File), "assets", hash+".png"))
	if err != nil || !bytes.Equal(saved, keptPNG) {
		t.Fatalf("image not saved: %q %v", saved, err)
	}
	if !*cutAfterImage || len(*errs) != 0 || *gets != 1 {
		t.Fatalf("cutAfterImage=%v errs=%v gets=%d", *cutAfterImage, *errs, *gets)
	}
}

func TestKeptResumeDoesNotFetchAnImageItHas(t *testing.T) {
	hash := protocol.ContentHash(keptPNG)
	h, gets, _, _ := keptImageRoom(t, hash, map[string][]byte{hash: keptPNG})
	assets := filepath.Join(filepath.Dir(h.state.Files[0].File), "assets")
	if err := os.Mkdir(assets, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(assets, hash+".png"), keptPNG, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := h.sync(context.Background()); err != nil {
		t.Fatal(err)
	}
	if *gets != 0 {
		t.Fatalf("fetched an image it had: %d requests", *gets)
	}
}

func TestKeptResumeReportsAMissingImageAndStillWritesTheText(t *testing.T) {
	hash := protocol.ContentHash(keptPNG)
	h, _, _, errs := keptImageRoom(t, hash, nil)
	if err := h.sync(context.Background()); err != nil {
		t.Fatal(err)
	}
	if len(*errs) != 1 || !errors.Is((*errs)[0], attach.ErrNotInRoom) {
		t.Fatalf("errors = %v", *errs)
	}
	got, _ := os.ReadFile(h.state.Files[0].File)
	if !strings.Contains(string(got), "![](assets/"+hash+".png)") {
		t.Fatalf("text = %q", got)
	}
	// Reported once, not at every sync.
	if err := h.sync(context.Background()); err != nil || len(*errs) != 1 {
		t.Fatalf("again: %v %v", err, *errs)
	}
}
