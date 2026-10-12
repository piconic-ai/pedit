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
	if err := f.Write("should not write"); err == nil {
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
	if err := f.Write("final save"); err != nil {
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
	if err := f.Write("updated"); err != nil {
		t.Fatal(err)
	}
	if got, ok := f.Read(); !ok || got != "updated" {
		t.Fatalf("content: %q, %v", got, ok)
	}
}
