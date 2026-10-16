package main

import (
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

// inDir runs the test in a new directory holding files, each with its mode.
func inDir(t *testing.T, files map[string]os.FileMode) string {
	t.Helper()
	dir := t.TempDir()
	for name, mode := range files {
		path := filepath.Join(dir, name)
		if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, []byte("# "+name+"\n"), 0o644); err != nil {
			t.Fatal(err)
		}
		if err := os.Chmod(path, mode); err != nil {
			t.Fatal(err)
		}
	}
	t.Chdir(dir)
	return dir
}

func skipIfRoot(t *testing.T) {
	t.Helper()
	if runtime.GOOS == "windows" {
		t.Skip("Windows has no Unix permissions")
	}
	if os.Geteuid() == 0 {
		t.Skip("root ignores permissions")
	}
}

func TestCheckFileShareable(t *testing.T) {
	inDir(t, map[string]os.FileMode{"notes.md": 0o644, "docs/a.md": 0o644})
	for _, arg := range []string{"notes.md", "./notes.md", "docs/a.md"} {
		if msg := checkFile(arg); msg != "" {
			t.Errorf("checkFile(%q) = %q", arg, msg)
		}
	}
}

func TestCheckFileMissing(t *testing.T) {
	inDir(t, map[string]os.FileMode{"notes.md": 0o644, "docs/todo.md": 0o644, "docs/todo.txt": 0o644, "my notes.md": 0o644})
	tests := []struct {
		arg  string
		want string
	}{
		{"notse.md", `pedit: notse.md does not exist.

  Did you mean this one?
    pedit notes.md

To create a file,`},
		{"docs/todo", `pedit: docs/todo does not exist.

  Did you mean one of these?
    pedit docs/todo.md
    pedit docs/todo.txt

To create a file,`},
		{"my-notes.md", `
  Did you mean this one?
    pedit 'my notes.md'
`},
		// Nothing close: no "Did you mean" block.
		{"main.go", "pedit: main.go does not exist.\n\nTo create a file,"},
		// Only the given directory is searched.
		{"todo.md", "pedit: todo.md does not exist.\n\nTo create a file,"},
	}
	for _, tt := range tests {
		if got := checkFile(tt.arg); !strings.Contains(got, tt.want) {
			t.Errorf("checkFile(%q) =\n%s\nwant it to contain:\n%s", tt.arg, got, tt.want)
		}
	}
}

func TestCheckFileMissingParent(t *testing.T) {
	inDir(t, nil)
	want := "pedit: drafts/ does not exist, so drafts/notes.md cannot be there."
	if got := checkFile("drafts/notes.md"); got != want {
		t.Fatalf("got %q", got)
	}
}

func TestCheckFileDirectory(t *testing.T) {
	inDir(t, map[string]os.FileMode{"docs/a.md": 0o644, "docs/b c.txt": 0o644, "docs/.hidden.md": 0o644})
	if err := os.WriteFile("docs/logo.png", []byte{0x89, 'P', 'N', 'G', 0, 0}, 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir("docs/sub", 0o755); err != nil {
		t.Fatal(err)
	}
	want := `pedit: docs/ is a directory. pedit shares a single file.

  Pick one of these:
    pedit docs/a.md
    pedit 'docs/b c.txt'`
	if got := checkFile("docs/"); got != want {
		t.Fatalf("got:\n%s\nwant:\n%s", got, want)
	}

	t.Chdir("docs")
	if got := checkFile("."); !strings.Contains(got, "    pedit a.md\n") {
		t.Fatalf("got:\n%s", got)
	}
}

func TestCheckFileDirectoryWithManyFiles(t *testing.T) {
	files := map[string]os.FileMode{}
	for _, n := range []string{"a", "b", "c", "d", "e", "f"} {
		files["docs/"+n+".md"] = 0o644
	}
	inDir(t, files)
	if got := checkFile("docs"); got != "pedit: docs is a directory. pedit shares a single file." {
		t.Fatalf("got:\n%s", got)
	}
}

func TestTextFilesStopsPastLimit(t *testing.T) {
	files := map[string]os.FileMode{}
	for _, n := range []string{"a", "b", "c", "d", "e", "f", "g", "h"} {
		files[n+".md"] = 0o644
	}
	inDir(t, files)
	if got := textFiles(".", 2); len(got) != 3 {
		t.Fatalf("textFiles = %q, want 3 names", got)
	}
}

func TestCheckFilePermissions(t *testing.T) {
	skipIfRoot(t)
	inDir(t, map[string]os.FileMode{"secret.md": 0o200, "readonly.md": 0o444, "locked/notes.md": 0o644})
	if err := os.Chmod("locked", 0o555); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.Chmod("locked", 0o755) })
	tests := map[string]string{
		"secret.md":       "pedit: cannot read secret.md: permission denied.",
		"readonly.md":     "pedit: readonly.md is read-only. pedit writes edits back to it, so it needs write permission.",
		"locked/notes.md": "pedit: cannot save to locked/notes.md: pedit saves by replacing the file, which needs write permission on locked/.",
	}
	for arg, want := range tests {
		if got := checkFile(arg); got != want {
			t.Errorf("checkFile(%q) = %q", arg, got)
		}
	}
}

func TestCheckFileUnreadableDirectory(t *testing.T) {
	skipIfRoot(t)
	inDir(t, map[string]os.FileMode{"locked/notes.md": 0o644})
	if err := os.Chmod("locked", 0o000); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.Chmod("locked", 0o755) })
	if got := checkFile("locked/notes.md"); got != "pedit: cannot read locked/notes.md: permission denied." {
		t.Fatalf("got %q", got)
	}
}

func TestIsText(t *testing.T) {
	dir := t.TempDir()
	// A multibyte character cut by the 8 KiB read is still text.
	long := strings.Repeat("a", 8191) + "あ"
	for content, want := range map[string]bool{
		"":            true,
		"# notes\n":   true,
		long:          true,
		"PNG\x00\x01": false,
		"\xff\xfe":    false,
	} {
		path := filepath.Join(dir, "f")
		if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
			t.Fatal(err)
		}
		if got := isText(path); got != want {
			t.Errorf("isText(%.20q) = %v", content, got)
		}
	}
}

func TestShellQuote(t *testing.T) {
	for in, want := range map[string]string{
		"notes.md":      "notes.md",
		"docs/a-b_c.md": "docs/a-b_c.md",
		"my notes.md":   "'my notes.md'",
		"it's.md":       `'it'\''s.md'`,
		"メモ.md":         "'メモ.md'",
	} {
		if got := shellQuote(in); got != want {
			t.Errorf("shellQuote(%q) = %q, want %q", in, got, want)
		}
	}
}

// TestCheckFileNeverPrintsEscapesFromFileNames: a name someone else chose,
// as in a cloned repository, could carry an escape sequence for the terminal.
func TestCheckFileNeverPrintsEscapesFromFileNames(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("Windows file names cannot hold control characters")
	}
	planted := "a\x1b]52;c;ZXZpbA==\x07.md"
	inDir(t, map[string]os.FileMode{"docs/b.md": 0o644, "docs/" + planted: 0o644})
	for _, arg := range []string{"docs", "docs/a.md"} {
		if got := checkFile(arg); strings.ContainsAny(got, "\x1b\x07") {
			t.Errorf("checkFile(%q) = %q", arg, got)
		}
	}
	if got := checkFile("docs"); !strings.Contains(got, "    pedit docs/b.md") {
		t.Errorf("got:\n%s", got)
	}
}
