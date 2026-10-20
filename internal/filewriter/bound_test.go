package filewriter

import (
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func TestBoundFileRejectsReplacementLinkAndAllowsRenameSave(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("symlink creation needs privileges on Windows")
	}
	dir := t.TempDir()
	path := filepath.Join(dir, "shared.md")
	secret := filepath.Join(t.TempDir(), "secret.md")
	if err := os.WriteFile(path, []byte("original"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(secret, []byte("private"), 0o600); err != nil {
		t.Fatal(err)
	}
	f, err := OpenBound(path)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	if err := os.Remove(path); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(secret, path); err != nil {
		t.Fatal(err)
	}
	if _, ok := f.Read(); ok {
		t.Fatal("read through a replacement link")
	}
	if err := f.Write("original", "should not write"); err == nil {
		t.Fatal("wrote over a replacement link")
	}
	if err := os.Remove(path); err != nil {
		t.Fatal(err)
	}
	tmp := filepath.Join(dir, "editor-save")
	if err := os.WriteFile(tmp, []byte("editor change"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Rename(tmp, path); err != nil {
		t.Fatal(err)
	}
	if got, ok := f.Read(); !ok || got != "editor change" {
		t.Fatalf("rename save: %q, %v", got, ok)
	}
	if err := f.Write("editor change", "final save"); err != nil {
		t.Fatal(err)
	}
	if got, ok := f.Read(); !ok || got != "final save" {
		t.Fatalf("final save: %q, %v", got, ok)
	}
	if got, err := os.ReadFile(secret); err != nil || string(got) != "private" {
		t.Fatalf("secret changed: %q, %v", got, err)
	}
}

func TestBoundFileReadsBytesAsTheyAre(t *testing.T) {
	path := filepath.Join(t.TempDir(), "memo.txt")
	// 議事録 in Shift_JIS: not UTF-8, and must not be taken for U+FFFD.
	if err := os.WriteFile(path, []byte("\x8b\x63\x8e\x96\x98\x5e\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	f, err := OpenBound(path)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	if got, ok := f.Read(); !ok || got != "\x8b\x63\x8e\x96\x98\x5e\n" {
		t.Fatalf("Read = %q, %v", got, ok)
	}
}

func TestBoundFileSize(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "memo.txt")
	if err := os.WriteFile(path, []byte("12345"), 0o600); err != nil {
		t.Fatal(err)
	}
	f, err := OpenBound(path)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	if size, ok := f.Size(); !ok || size != 5 {
		t.Errorf("Size = %d, %v, want 5, true", size, ok)
	}
	if err := os.Remove(path); err != nil {
		t.Fatal(err)
	}
	if size, ok := f.Size(); ok {
		t.Errorf("Size of a missing file = %d, true", size)
	}
	if err := os.Mkdir(path, 0o700); err != nil {
		t.Fatal(err)
	}
	if size, ok := f.Size(); ok {
		t.Errorf("Size of a directory = %d, true", size)
	}
}

func TestBoundFileRejectsInitialLink(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("symlink creation needs privileges on Windows")
	}
	path := filepath.Join(t.TempDir(), "shared.md")
	if err := os.Symlink(filepath.Join(t.TempDir(), "other.md"), path); err != nil {
		t.Fatal(err)
	}
	if f, err := OpenBound(path); err == nil {
		_ = f.Close()
		t.Fatal("accepted an initial link")
	}
}

func TestBoundFileSavesLongFilename(t *testing.T) {
	path := filepath.Join(t.TempDir(), strings.Repeat("n", 220)+".md")
	if err := os.WriteFile(path, []byte("initial"), 0o600); err != nil {
		t.Fatal(err)
	}
	f, err := OpenBound(path)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	if err := f.Write("initial", "updated"); err != nil {
		t.Fatal(err)
	}
	if got, ok := f.Read(); !ok || got != "updated" {
		t.Fatalf("content: %q, %v", got, ok)
	}
}

// A file bound through a directory handle stays in that directory, whatever
// its name or the names on the way to it lead to.
func TestOpenBoundInStaysInTheDirectory(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("symlink creation needs privileges on Windows")
	}
	base := t.TempDir()
	dir := filepath.Join(base, "guest")
	outside := t.TempDir()
	if err := os.MkdirAll(filepath.Join(dir, "docs"), 0o700); err != nil {
		t.Fatal(err)
	}
	root, err := os.OpenRoot(dir)
	if err != nil {
		t.Fatal(err)
	}
	defer root.Close()
	if err := os.Symlink(outside, filepath.Join(dir, "link")); err != nil {
		t.Fatal(err)
	}
	if f, err := OpenBoundIn(root, filepath.Join("link", "x.md")); err == nil {
		_ = f.Close()
		t.Fatal("followed a link out of the directory")
	}

	// The directory's name now leads elsewhere; the handle does not.
	if err := os.Rename(dir, filepath.Join(base, "moved")); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outside, dir); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(filepath.Join(outside, "docs"), 0o700); err != nil {
		t.Fatal(err)
	}
	f, err := OpenBoundIn(root, filepath.Join("docs", "x.md"))
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	if err := f.Write("", "content"); err != nil {
		t.Fatal(err)
	}
	if b, err := os.ReadFile(filepath.Join(base, "moved", "docs", "x.md")); err != nil || string(b) != "content" {
		t.Fatalf("in the directory: %q, %v", b, err)
	}
	if entries, _ := os.ReadDir(filepath.Join(outside, "docs")); len(entries) != 0 {
		t.Fatalf("wrote out of the directory: %v", entries)
	}
}
