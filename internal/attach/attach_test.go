package attach

import (
	"bytes"
	"context"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"runtime"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/piconic-ai/pedit/internal/protocol"
)

const room = "AAAAAAAAAAAAAAAAAAAAAA"

var (
	png  = []byte("\x89PNG\r\n\x1a\n a png")
	jpeg = []byte("\xff\xd8\xff\xe0 a jpeg")
)

func TestDoesNotForwardAdmissionToRedirect(t *testing.T) {
	var hits atomic.Int32
	destination := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { hits.Add(1) }))
	defer destination.Close()
	origin := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, destination.URL, http.StatusTemporaryRedirect)
	}))
	defer origin.Close()
	raw, _ := protocol.DecodeKey(protocol.GenerateKey())
	keys, err := protocol.DeriveBlobKeys(raw)
	if err != nil {
		t.Fatal(err)
	}
	a := &Attachments{opts: Options{Server: origin.URL, Room: room, Keys: keys, HTTPClient: http.DefaultClient}}
	res, err := a.request(context.Background(), http.MethodGet, protocol.ContentHash(png), nil)
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusTemporaryRedirect || hits.Load() != 0 {
		t.Fatal("followed a credential-bearing redirect")
	}
}

type harness struct {
	t    *testing.T
	file string
	keys *protocol.BlobKeys
	a    *Attachments
	sent chan protocol.Attachment

	mu    sync.Mutex
	blobs map[string][]byte // URL path → body
	stall map[string]bool   // URL paths whose requests hang until cancelled
	busy  int               // PUTs to answer 503 before taking any
	gets  int
	saved []string
	// saveErrs are the images that could not be written, errs the rest.
	saveErrs []error
	errs     []error
}

func newHarness(t *testing.T) *harness {
	t.Helper()
	raw, _ := protocol.DecodeKey(protocol.GenerateKey())
	keys, err := protocol.DeriveBlobKeys(raw)
	if err != nil {
		t.Fatal(err)
	}
	h := &harness{
		t:     t,
		file:  filepath.Join(t.TempDir(), "notes.md"),
		keys:  keys,
		sent:  make(chan protocol.Attachment, 16),
		blobs: map[string][]byte{},
		stall: map[string]bool{},
	}
	// Stands in for the Worker's blob store.
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Cf-Access-Token") != "token" || r.Header.Get(protocol.AdmissionHeader) != keys.Admission {
			w.WriteHeader(http.StatusForbidden)
			return
		}
		h.mu.Lock()
		stall := h.stall[r.URL.Path]
		h.mu.Unlock()
		if stall {
			// A GET stalls mid-body, a PUT before answering. The server notices
			// the client giving up only once the request body is read.
			_, _ = io.ReadAll(r.Body)
			if r.Method == http.MethodGet {
				w.WriteHeader(http.StatusOK)
				_, _ = w.Write([]byte("partial"))
				w.(http.Flusher).Flush()
			}
			<-r.Context().Done()
			return
		}
		h.mu.Lock()
		defer h.mu.Unlock()
		switch r.Method {
		case http.MethodGet:
			h.gets++
			body, ok := h.blobs[r.URL.Path]
			if !ok {
				w.WriteHeader(http.StatusNotFound)
				return
			}
			_, _ = w.Write(body)
		case http.MethodPut:
			body, _ := io.ReadAll(r.Body)
			if h.busy > 0 {
				h.busy--
				w.WriteHeader(http.StatusServiceUnavailable)
				return
			}
			h.blobs[r.URL.Path] = body
			w.WriteHeader(http.StatusCreated)
		}
	}))
	t.Cleanup(server.Close)
	h.a = New(Options{
		File:   h.file,
		Server: server.URL + "/",
		Room:   room,
		Header: http.Header{"Cf-Access-Token": {"token"}},
		Keys:   keys,
		Send: func(m protocol.Attachment) error {
			h.sent <- m
			return nil
		},
		OnSaved:     func(path string) { h.mu.Lock(); h.saved = append(h.saved, path); h.mu.Unlock() },
		OnSaveError: func(err error) { h.mu.Lock(); h.saveErrs = append(h.saveErrs, err); h.mu.Unlock() },
		OnError:     func(err error) { h.mu.Lock(); h.errs = append(h.errs, err); h.mu.Unlock() },
	})
	h.a.retryDelay = time.Millisecond
	t.Cleanup(h.a.Close)
	return h
}

func (h *harness) blobPath(hash string) string {
	id, err := h.keys.BlobID(hash)
	if err != nil {
		h.t.Fatal(err)
	}
	return "/api/rooms/" + room + "/blobs/" + id
}

// upload stores data as a peer would, under the blob id of hash.
func (h *harness) upload(hash string, data []byte) {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.blobs[h.blobPath(hash)] = h.keys.Encrypt(data)
}

func (h *harness) announce(content []byte, mime string) string {
	hash := protocol.ContentHash(content)
	h.upload(hash, content)
	h.a.Handle(protocol.Attachment{Kind: protocol.AttachmentAnnounce, Hash: hash, Mime: mime})
	return hash
}

func (h *harness) next() protocol.Attachment {
	h.t.Helper()
	select {
	case m := <-h.sent:
		return m
	case <-time.After(3 * time.Second):
		h.mu.Lock()
		defer h.mu.Unlock()
		h.t.Fatalf("nothing sent; save errors: %v, errors: %v", h.saveErrs, h.errs)
		return protocol.Attachment{}
	}
}

func (h *harness) nothingSent() {
	h.t.Helper()
	select {
	case m := <-h.sent:
		h.t.Fatalf("unexpected %+v", m)
	case <-time.After(100 * time.Millisecond):
	}
}

func (h *harness) expectRejected(hash, reason string) {
	h.t.Helper()
	m := h.next()
	if m.Kind != protocol.AttachmentRejected || m.Hash != hash || m.Reason != reason {
		h.t.Fatalf("got %+v, want rejected %s", m, reason)
	}
}

// saveErrors are the images that could not be written so far, and the other
// errors.
func (h *harness) saveErrors() (saveErrs, errs []error) {
	h.mu.Lock()
	defer h.mu.Unlock()
	return append([]error{}, h.saveErrs...), append([]error{}, h.errs...)
}

func (h *harness) assets() []string {
	h.t.Helper()
	entries, _ := os.ReadDir(filepath.Join(filepath.Dir(h.file), Dir))
	var names []string
	for _, e := range entries {
		names = append(names, e.Name())
	}
	return names
}

func TestSavesAnnouncedImages(t *testing.T) {
	h := newHarness(t)
	hash := h.announce(png, "image/png")
	want := protocol.Attachment{Kind: protocol.AttachmentStored, Hash: hash, Path: "assets/" + hash + ".png"}
	if m := h.next(); !reflect.DeepEqual(m, want) {
		t.Fatalf("got %+v", m)
	}
	got, err := os.ReadFile(filepath.Join(filepath.Dir(h.file), "assets", hash+".png"))
	if err != nil || !bytes.Equal(got, png) {
		t.Fatalf("file = %q, %v", got, err)
	}
	if info, _ := os.Stat(filepath.Join(filepath.Dir(h.file), "assets", hash+".png")); info.Mode().Perm() != 0o600 {
		t.Fatalf("mode = %v", info.Mode())
	}

	// The same image again: stored already, not fetched or saved twice.
	h.a.Handle(protocol.Attachment{Kind: protocol.AttachmentAnnounce, Hash: hash, Mime: "image/png"})
	if m := h.next(); m.Kind != protocol.AttachmentStored || m.Path != want.Path {
		t.Fatalf("got %+v", m)
	}
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.gets != 1 || len(h.saved) != 1 || h.saved[0] != want.Path {
		t.Fatalf("gets=%d saved=%v", h.gets, h.saved)
	}
}

func TestSavesAgainAnImageMovedAway(t *testing.T) {
	h := newHarness(t)
	hash := h.announce(png, "image/png")
	h.next()
	path := filepath.Join(filepath.Dir(h.file), "assets", hash+".png")
	if err := os.Remove(path); err != nil {
		t.Fatal(err)
	}
	h.a.Handle(protocol.Attachment{Kind: protocol.AttachmentAnnounce, Hash: hash, Mime: "image/png"})
	if m := h.next(); m.Kind != protocol.AttachmentStored {
		t.Fatalf("got %+v", m)
	}
	if got, err := os.ReadFile(path); err != nil || !bytes.Equal(got, png) {
		t.Fatalf("file = %q, %v", got, err)
	}
}

func TestGivesUpOnStalledRequests(t *testing.T) {
	h := newHarness(t)
	h.a.timeout = 100 * time.Millisecond
	stalled := protocol.ContentHash(jpeg)
	h.a.AllowLocalDocument("![](assets/" + stalled + ".jpg)")
	h.mu.Lock()
	h.stall[h.blobPath(stalled)] = true
	h.mu.Unlock()

	// A download that stalls mid-body, then an upload that never gets an answer.
	h.upload(stalled, jpeg)
	h.a.Handle(protocol.Attachment{Kind: protocol.AttachmentAnnounce, Hash: stalled, Mime: "image/jpeg"})
	dir := filepath.Join(filepath.Dir(h.file), "assets")
	_ = os.Mkdir(dir, 0o755)
	_ = os.WriteFile(filepath.Join(dir, stalled+".jpg"), jpeg, 0o644)
	h.a.Handle(protocol.Attachment{Kind: protocol.AttachmentWant, Hashes: []string{stalled}})

	// Messages after them are still handled.
	hash := h.announce(png, "image/png")
	if m := h.next(); m.Kind != protocol.AttachmentStored || m.Hash != hash {
		t.Fatalf("got %+v", m)
	}
	h.mu.Lock()
	defer h.mu.Unlock()
	if len(h.errs) != 2 {
		t.Fatalf("errors = %v", h.errs)
	}
}

func TestPicksTheExtensionFromTheBytes(t *testing.T) {
	h := newHarness(t)
	// Announced as PNG, but it is a JPEG.
	hash := h.announce(jpeg, "image/png")
	if m := h.next(); m.Path != "assets/"+hash+".jpg" {
		t.Fatalf("got %+v", m)
	}
}

func TestKeepsAnImageAlreadyOnDisk(t *testing.T) {
	h := newHarness(t)
	hash := protocol.ContentHash(png)
	dir := filepath.Join(filepath.Dir(h.file), "assets")
	_ = os.Mkdir(dir, 0o755)
	_ = os.WriteFile(filepath.Join(dir, hash+".png"), png, 0o600)
	h.announce(png, "image/png")
	if m := h.next(); m.Kind != protocol.AttachmentStored {
		t.Fatalf("got %+v", m)
	}
	if info, _ := os.Stat(filepath.Join(dir, hash+".png")); info.Mode().Perm() != 0o600 {
		t.Fatal("the file was rewritten")
	}
	h.mu.Lock()
	defer h.mu.Unlock()
	if len(h.saved) != 0 {
		t.Fatalf("saved = %v", h.saved)
	}
}

func TestRejectsWhatItCannotSave(t *testing.T) {
	t.Run("types other than images", func(t *testing.T) {
		h := newHarness(t)
		h.expectRejected(h.announce([]byte("<svg/>"), "image/svg+xml"), ReasonType)
		h.expectRejected(h.announce([]byte("#!/bin/sh\n"), "image/png"), ReasonType)
	})

	t.Run("images too large", func(t *testing.T) {
		h := newHarness(t)
		hash := protocol.ContentHash([]byte("big"))
		h.upload(hash, make([]byte, MaxBytes+1))
		h.a.Handle(protocol.Attachment{Kind: protocol.AttachmentAnnounce, Hash: hash, Mime: "image/png"})
		h.expectRejected(hash, ReasonTooLarge)
	})

	t.Run("content that does not match its hash", func(t *testing.T) {
		h := newHarness(t)
		hash := protocol.ContentHash(png)
		h.upload(hash, jpeg)
		h.a.Handle(protocol.Attachment{Kind: protocol.AttachmentAnnounce, Hash: hash, Mime: "image/png"})
		h.expectRejected(hash, ReasonInvalid)
	})

	t.Run("blobs that are not there", func(t *testing.T) {
		h := newHarness(t)
		hash := protocol.ContentHash(png)
		h.a.Handle(protocol.Attachment{Kind: protocol.AttachmentAnnounce, Hash: hash, Mime: "image/png"})
		h.expectRejected(hash, ReasonInvalid)
	})

	t.Run("more than the session quota", func(t *testing.T) {
		h := newHarness(t)
		h.a.count = MaxCount
		h.expectRejected(h.announce(png, "image/png"), ReasonQuota)
		if len(h.assets()) != 0 {
			t.Fatalf("assets = %v", h.assets())
		}
	})

	t.Run("a different file in the way", func(t *testing.T) {
		h := newHarness(t)
		hash := protocol.ContentHash(png)
		dir := filepath.Join(filepath.Dir(h.file), "assets")
		_ = os.Mkdir(dir, 0o755)
		_ = os.WriteFile(filepath.Join(dir, hash+".png"), []byte("mine"), 0o644)
		h.expectRejected(h.announce(png, "image/png"), ReasonUnavailable)
		if got, _ := os.ReadFile(filepath.Join(dir, hash+".png")); string(got) != "mine" {
			t.Fatalf("overwritten with %q", got)
		}
	})
}

func TestTellsWhyAnImageCannotBeSaved(t *testing.T) {
	t.Run("through OnSaveError", func(t *testing.T) {
		h := newHarness(t)
		dir := filepath.Join(filepath.Dir(h.file), Dir)
		_ = os.Mkdir(dir, 0o755)
		hash := protocol.ContentHash(png)
		_ = os.WriteFile(filepath.Join(dir, hash+".png"), []byte("mine"), 0o644)
		h.expectRejected(h.announce(png, "image/png"), ReasonUnavailable)
		saveErrs, errs := h.saveErrors()
		if len(saveErrs) != 1 || len(errs) != 0 {
			t.Fatalf("save errors = %v, errors = %v", saveErrs, errs)
		}
	})

	t.Run("not for errors that nobody can fix", func(t *testing.T) {
		h := newHarness(t)
		// The blob is not in the room.
		hash := protocol.ContentHash(png)
		h.a.Handle(protocol.Attachment{Kind: protocol.AttachmentAnnounce, Hash: hash, Mime: "image/png"})
		h.expectRejected(hash, ReasonInvalid)
		if saveErrs, errs := h.saveErrors(); len(saveErrs) != 0 || len(errs) != 0 {
			t.Fatalf("save errors = %v, errors = %v", saveErrs, errs)
		}
	})

	t.Run("OnError by default", func(t *testing.T) {
		var got []error
		a := New(Options{File: filepath.Join(t.TempDir(), "notes.md"), OnError: func(err error) { got = append(got, err) }})
		defer a.Close()
		want := errors.New("cannot save")
		a.opts.OnSaveError(want)
		if len(got) != 1 || got[0] != want {
			t.Fatalf("errors = %v", got)
		}
	})
}

func TestNeverWritesOutsideTheFilesDirectory(t *testing.T) {
	t.Run("assets is a symlink to elsewhere", func(t *testing.T) {
		h := newHarness(t)
		outside := t.TempDir()
		if err := os.Symlink(outside, filepath.Join(filepath.Dir(h.file), "assets")); err != nil {
			t.Skip("symlinks unavailable:", err)
		}
		h.expectRejected(h.announce(png, "image/png"), ReasonUnavailable)
		if entries, _ := os.ReadDir(outside); len(entries) != 0 {
			t.Fatalf("wrote %v outside", entries)
		}
		// It says why, instead of only that the path escapes.
		if saveErrs, _ := h.saveErrors(); len(saveErrs) != 1 || !errors.Is(saveErrs[0], ErrLinkedOut) {
			t.Fatalf("errors = %v, want one that is ErrLinkedOut", saveErrs)
		}
	})

	t.Run("assets is a symlink inside", func(t *testing.T) {
		h := newHarness(t)
		base := filepath.Dir(h.file)
		_ = os.Mkdir(filepath.Join(base, "images"), 0o755)
		if err := os.Symlink("images", filepath.Join(base, "assets")); err != nil {
			t.Skip("symlinks unavailable:", err)
		}
		hash := h.announce(png, "image/png")
		if m := h.next(); m.Kind != protocol.AttachmentStored {
			t.Fatalf("got %+v", m)
		}
		if _, err := os.Stat(filepath.Join(base, "images", hash+".png")); err != nil {
			t.Fatal(err)
		}
	})

	t.Run("assets is a file", func(t *testing.T) {
		h := newHarness(t)
		_ = os.WriteFile(filepath.Join(filepath.Dir(h.file), "assets"), nil, 0o644)
		h.expectRejected(h.announce(png, "image/png"), ReasonUnavailable)
		if saveErrs, _ := h.saveErrors(); len(saveErrs) != 1 || errors.Is(saveErrs[0], ErrLinkedOut) {
			t.Fatalf("errors = %v, want one that is not ErrLinkedOut", saveErrs)
		}
	})
}

func TestKeepsToTheDirectoryItOpened(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("an open directory cannot be renamed, and symlinks need privileges on Windows")
	}
	h := newHarness(t)
	base := filepath.Dir(h.file)
	outside := t.TempDir()
	if err := os.Mkdir(filepath.Join(base, Dir), 0o755); err != nil {
		t.Fatal(err)
	}
	// Someone who can write beside the file swaps assets for a link to
	// elsewhere, after pedit opened it and before it writes.
	h.a.beforeWrite = func() {
		if err := os.Rename(filepath.Join(base, Dir), filepath.Join(base, "moved")); err != nil {
			t.Error(err)
		}
		if err := os.Symlink(outside, filepath.Join(base, Dir)); err != nil {
			t.Error(err)
		}
	}
	hash := h.announce(png, "image/png")
	if m := h.next(); m.Kind != protocol.AttachmentStored {
		t.Fatalf("got %+v", m)
	}
	if entries, _ := os.ReadDir(outside); len(entries) != 0 {
		t.Fatalf("wrote %v outside", entries)
	}
	if got, err := os.ReadFile(filepath.Join(base, "moved", hash+".png")); err != nil || !bytes.Equal(got, png) {
		t.Fatalf("not in the directory it opened: %q, %v", got, err)
	}
}

func TestUploadsWantedImagesFromDisk(t *testing.T) {
	h := newHarness(t)
	hash := protocol.ContentHash(png)
	h.a.AllowLocalDocument("![](assets/" + hash + ".png)")
	dir := filepath.Join(filepath.Dir(h.file), "assets")
	_ = os.Mkdir(dir, 0o755)
	_ = os.WriteFile(filepath.Join(dir, hash+".png"), png, 0o644)

	h.a.Handle(protocol.Attachment{Kind: protocol.AttachmentWant, Hashes: []string{hash}})
	if m := h.next(); !reflect.DeepEqual(m, protocol.Attachment{Kind: protocol.AttachmentAnnounce, Hash: hash, Mime: "image/png"}) {
		t.Fatalf("got %+v", m)
	}
	h.mu.Lock()
	blob := h.blobs[h.blobPath(hash)]
	h.mu.Unlock()
	if got, err := h.keys.Decrypt(blob, hash); err != nil || !bytes.Equal(got, png) {
		t.Fatalf("uploaded %q, %v", got, err)
	}

	// Asked again right away: already uploaded, so nothing to do.
	h.a.Handle(protocol.Attachment{Kind: protocol.AttachmentWant, Hashes: []string{hash}})
	h.nothingSent()
}

func TestWaitsForTheRoomToTakeAWantedImage(t *testing.T) {
	h := newHarness(t)
	hash := protocol.ContentHash(png)
	h.a.AllowLocalDocument("![](assets/" + hash + ".png)")
	dir := filepath.Join(filepath.Dir(h.file), "assets")
	_ = os.Mkdir(dir, 0o755)
	_ = os.WriteFile(filepath.Join(dir, hash+".png"), png, 0o644)
	h.mu.Lock()
	h.busy = uploadRetries
	h.mu.Unlock()

	h.a.Handle(protocol.Attachment{Kind: protocol.AttachmentWant, Hashes: []string{hash}})
	if m := h.next(); m.Kind != protocol.AttachmentAnnounce || m.Hash != hash {
		t.Fatalf("got %+v", m)
	}
	h.mu.Lock()
	defer h.mu.Unlock()
	if _, ok := h.blobs[h.blobPath(hash)]; !ok || len(h.errs) != 0 {
		t.Fatalf("stored=%v errs=%v", ok, h.errs)
	}
}

func TestGivesUpOnARoomThatStaysBusy(t *testing.T) {
	h := newHarness(t)
	hash := protocol.ContentHash(png)
	h.a.AllowLocalDocument("![](assets/" + hash + ".png)")
	dir := filepath.Join(filepath.Dir(h.file), "assets")
	_ = os.Mkdir(dir, 0o755)
	_ = os.WriteFile(filepath.Join(dir, hash+".png"), png, 0o644)
	h.mu.Lock()
	h.busy = uploadRetries + 1
	h.mu.Unlock()

	h.a.Handle(protocol.Attachment{Kind: protocol.AttachmentWant, Hashes: []string{hash}})
	h.nothingSent()
	errs := func() []error { h.mu.Lock(); defer h.mu.Unlock(); return append([]error{}, h.errs...) }
	for deadline := time.Now().Add(time.Second); len(errs()) == 0 && time.Now().Before(deadline); {
		time.Sleep(10 * time.Millisecond)
	}
	if got := errs(); len(got) != 1 || !strings.Contains(got[0].Error(), "503") {
		t.Fatalf("errs = %v", got)
	}
}

func TestResendsWantedImagesAfterAWhile(t *testing.T) {
	h := newHarness(t)
	hash := protocol.ContentHash(png)
	h.a.AllowLocalDocument("![](assets/" + hash + ".png)")
	dir := filepath.Join(filepath.Dir(h.file), "assets")
	_ = os.Mkdir(dir, 0o755)
	_ = os.WriteFile(filepath.Join(dir, hash+".png"), png, 0o644)
	var mu sync.Mutex
	now := time.Now()
	h.a.now = func() time.Time { mu.Lock(); defer mu.Unlock(); return now }

	h.a.Handle(protocol.Attachment{Kind: protocol.AttachmentWant, Hashes: []string{hash}})
	h.next()
	mu.Lock()
	now = now.Add(resendInterval)
	mu.Unlock()
	h.a.Handle(protocol.Attachment{Kind: protocol.AttachmentWant, Hashes: []string{hash}})
	if m := h.next(); m.Kind != protocol.AttachmentAnnounce {
		t.Fatalf("got %+v", m)
	}
}

func TestServesOnlyIntactImagesFromAssets(t *testing.T) {
	h := newHarness(t)
	base := filepath.Dir(h.file)
	dir := filepath.Join(base, "assets")
	_ = os.Mkdir(dir, 0o755)

	missing := protocol.ContentHash([]byte("missing"))
	tampered := protocol.ContentHash(png)
	_ = os.WriteFile(filepath.Join(dir, tampered+".png"), []byte("\x89PNG\r\n\x1a\n changed"), 0o644)
	secret := []byte("\x89PNG\r\n\x1a\n secret")
	linked := protocol.ContentHash(secret)
	_ = os.WriteFile(filepath.Join(base, "secret.png"), secret, 0o644)
	symlinked := os.Symlink(filepath.Join(base, "secret.png"), filepath.Join(dir, linked+".png")) == nil
	// The file named for the document is not an attachment.
	_ = os.WriteFile(h.file, png, 0o644)

	hashes := []string{missing, tampered, strings.Repeat("0", 32)}
	h.a.AllowLocalDocument("![](assets/" + tampered + ".png)")
	if symlinked {
		hashes = append(hashes, linked)
	}
	h.a.Handle(protocol.Attachment{Kind: protocol.AttachmentWant, Hashes: hashes})
	h.nothingSent()
	h.mu.Lock()
	defer h.mu.Unlock()
	if len(h.blobs) != 0 {
		t.Fatalf("uploaded %d blobs", len(h.blobs))
	}
}

func TestDoesNotUploadUnreferencedSiblingImage(t *testing.T) {
	h := newHarness(t)
	hash := protocol.ContentHash(png)
	dir := filepath.Join(filepath.Dir(h.file), Dir)
	if err := os.Mkdir(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, hash+".png"), png, 0o600); err != nil {
		t.Fatal(err)
	}
	h.a.Handle(protocol.Attachment{Kind: protocol.AttachmentWant, Hashes: []string{hash}})
	h.nothingSent()
	h.mu.Lock()
	defer h.mu.Unlock()
	if len(h.blobs) != 0 {
		t.Fatal("uploaded an unreferenced image")
	}
}

func TestLocalChangesAuthorizeOnlyNewReferences(t *testing.T) {
	h := newHarness(t)
	peer := protocol.ContentHash(png)
	local := protocol.ContentHash(jpeg)
	base := "![](assets/" + peer + ".png)\n"
	h.a.AllowLocalChanges(base, base+"![](assets/"+local+".jpg)\n")
	if h.a.allowedHash(peer) {
		t.Fatal("authorized retained peer reference")
	}
	if !h.a.allowedHash(local) {
		t.Fatal("did not authorize new local reference")
	}
}

func TestDocumentHashesIncludesAdjacentReferences(t *testing.T) {
	first, second := protocol.ContentHash(png), protocol.ContentHash(jpeg)
	for _, separator := range []string{" ", "\n", ",", ")", "界"} {
		t.Run(separator, func(t *testing.T) {
			got := documentHashes("assets/" + first + ".png" + separator + "assets/" + second + ".jpg")
			if len(got) != 2 {
				t.Fatalf("extracted %v, want both references", got)
			}
			if _, ok := got[first]; !ok {
				t.Fatal("missing first reference")
			}
			if _, ok := got[second]; !ok {
				t.Fatal("missing second reference")
			}
		})
	}
	for _, document := range []string{"xassets/" + first + ".png", "_assets/" + first + ".png", "assets/" + first + ".pngx", "assets/" + first + ".png.exe"} {
		if got := documentHashes(document); len(got) != 0 {
			t.Fatalf("invalid boundary in %q: %v", document, got)
		}
	}
}

func TestResendsImageSavedInThisSession(t *testing.T) {
	h := newHarness(t)
	hash := h.announce(png, "image/png")
	if m := h.next(); m.Kind != protocol.AttachmentStored {
		t.Fatalf("got %+v", m)
	}
	h.mu.Lock()
	delete(h.blobs, h.blobPath(hash))
	h.mu.Unlock()
	h.a.Handle(protocol.Attachment{Kind: protocol.AttachmentWant, Hashes: []string{hash}})
	if m := h.next(); m.Kind != protocol.AttachmentAnnounce || m.Hash != hash {
		t.Fatalf("got %+v", m)
	}
}

func TestIgnoresOtherKinds(t *testing.T) {
	h := newHarness(t)
	hash := protocol.ContentHash(png)
	h.a.Handle(protocol.Attachment{Kind: protocol.AttachmentStored, Hash: hash, Path: "assets/x.png"})
	h.a.Handle(protocol.Attachment{Kind: protocol.AttachmentRejected, Hash: hash, Reason: "type"})
	h.nothingSent()
}
