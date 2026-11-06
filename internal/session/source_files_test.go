package session

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/piconic-ai/pedit/internal/attach"
	"github.com/piconic-ai/pedit/internal/protocol"
	"github.com/piconic-ai/pedit/internal/protocol/prototest"
)

// sourceImage writes an image beside the fixture's file and returns the
// markdown that refers to it.
func sourceImage(t *testing.T, f *fixture, name string) (hash, link string) {
	t.Helper()
	image := []byte("\x89PNG\r\n\x1a\n " + name)
	hash = protocol.ContentHash(image)
	dir := filepath.Join(filepath.Dir(f.file), attach.Dir)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, hash+".png"), image, 0o600); err != nil {
		t.Fatal(err)
	}
	return hash, "![](assets/" + hash + ".png)\n"
}

func TestAReferenceTheSourceAddsCanBeUploaded(t *testing.T) {
	f, src := shareSource(t, "public\n", setupOpts{})
	g := joinAsGuest(t, f.relay, f.session.URL)
	prototest.WaitFor(t, wait, func() bool { return g.String() == "public\n" }, "the text")
	hash, link := sourceImage(t, f, "local")
	src.insert(0, link)
	prototest.WaitFor(t, wait, func() bool { return g.String() == link+"public\n" }, "the reference at the guest")
	f.session.attachments.Handle(protocol.Attachment{Kind: protocol.AttachmentWant, Hashes: []string{hash}})
	prototest.WaitFor(t, wait, func() bool { return f.puts.Load() == 1 }, "the image uploaded")
}

func TestAReferenceAGuestAddsStaysUnauthorizedWhenTheSourceEditsElse(t *testing.T) {
	f, src := shareSource(t, "public\n", setupOpts{})
	g := joinAsGuest(t, f.relay, f.session.URL)
	prototest.WaitFor(t, wait, func() bool { return g.String() == "public\n" }, "the text")
	hash, link := sourceImage(t, f, "private")
	g.insert(0, link)
	prototest.WaitFor(t, wait, func() bool { return src.String() == link+"public\n" }, "the reference at the source")
	src.insert(len(src.String())-1, " more")
	prototest.WaitFor(t, wait, func() bool { return strings.HasSuffix(g.String(), " more\n") }, "the later edit at the guest")
	f.session.attachments.Handle(protocol.Attachment{Kind: protocol.AttachmentWant, Hashes: []string{hash}})
	time.Sleep(200 * time.Millisecond)
	if f.puts.Load() != 0 {
		t.Fatal("uploaded an image a guest referred to")
	}
}

func TestASourceRefusesAddFile(t *testing.T) {
	f, _ := shareSource(t, "x\n", setupOpts{})
	other := writeBeside(t, f, "other.md", "y\n")
	if _, err := f.session.AddFile(other); err == nil {
		t.Fatal("AddFile accepted")
	}
	if n := len(f.session.Files()); n != 1 {
		t.Fatalf("%d files", n)
	}
}
