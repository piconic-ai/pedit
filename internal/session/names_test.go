package session

import (
	"path/filepath"
	"regexp"
	"strings"
	"testing"

	"github.com/piconic-ai/pedit/internal/protocol"
)

func TestCopyName(t *testing.T) {
	for _, tt := range []struct {
		id   uint64
		path string
		want string
	}{
		{0, "notes.md", "00-notes.md"},
		{1, "docs/spec.md", "01-docs-spec.md"},
		{2, ".git/config", "02-git-config.txt"},
		{3, "desktop.ini", "03-desktop.txt"},
		{4, "会議.md", "04.md"},
		{5, "docs/会議.md", "05-docs.md"},
		{6, "notes.md.bat", "06-notes-md.txt"},
		{7, "GIT~1/config", "07-GIT-1-config.txt"},
		{8, "a.scf", "08-a.txt"},
		{9, "a.url", "09-a.txt"},
		{10, ".envrc", "10-envrc.txt"},
		{11, ".pedit/config.yaml", "11-pedit-config.yaml"},
		{12, "data.CSV", "12-data.csv"},
		{13, "table.tsv", "13-table.tsv"},
		{14, "README", "14-README.txt"},
		{15, "a.", "15-a.txt"},
		{16, "CON", "16-CON.txt"},
		{17, "nul.txt", "17-nul.txt"},
		{18, "x.KBD", "18-x.txt"}, // the Kelvin sign is not k
		{19, "notes -c '!sh' x.md", "19-notes-c-sh-x.md"},
		{20, "a:b.md", "20-a-b.md"},
		{21, "trailing. ", "21-trailing.txt"},
		{22, "", "22.txt"},
		{100, "x.md", "100-x.md"},
		{1, strings.Repeat("y", 60) + ".md", "01-" + strings.Repeat("y", 40) + ".md"},
		{protocol.MaxFileID, "x.md", "4294967295-x.md"},
		{1, strings.Repeat("dir/", 30) + "notes.md", "01-dir-dir-dir-dir-dir-dir-dir-dir-notes.md"},
	} {
		if got := copyName(tt.id, tt.path); got != tt.want {
			t.Errorf("copyName(%d, %q) = %q, want %q", tt.id, tt.path, got, tt.want)
		}
	}
}

// Whatever the host names a file, its copy's name is a number, letters,
// digits and dashes, and an extension from a short list: nothing a file
// system, shell or program reads as more than a name.
func TestCopyNameIsPlain(t *testing.T) {
	plain := regexp.MustCompile(`^[0-9]{2,}(-[A-Za-z0-9]+)*\.(md|markdown|txt|csv|tsv|json|yaml|yml|toml)$`)
	seen := map[string]bool{}
	for id, path := range []string{
		"../x.md", "/etc/passwd", `a\b.md`, "a\x00b.md", "a\nb.md", "a‮b.md", "x/../../y",
		".git/hooks/pre-commit", ".hg/hgrc", ".vscode/tasks.json", "Makefile", "package.json",
		"autorun.inf", "folder.htt", "x.lnk", "x.library-ms", "x.js", "x.ps1", "x.hta",
		"._x.md", "x.md:stream", "x.md::$DATA", "x" + strings.Repeat("y", 300) + ".md",
		"Notes.md", "notes.md", "café.md", "café.md",
	} {
		name := copyName(uint64(id+1), path)
		if !plain.MatchString(name) || len(name) > 64 || filepath.Base(name) != name {
			t.Errorf("%q: %q", path, name)
		}
		key := protocol.PathKey(name)
		if seen[key] {
			t.Errorf("%q: %q folds into a name already given", path, name)
		}
		seen[key] = true
	}
}
