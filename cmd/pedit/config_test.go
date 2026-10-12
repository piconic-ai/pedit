package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/piconic-ai/pedit/internal/canvas"
)

func put(t *testing.T, path, content string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
}

func TestConfigInitializationAndDiscovery(t *testing.T) {
	t.Setenv("PEDIT_SERVER", "https://ignored.example.com")
	root := t.TempDir()
	put(t, filepath.Join(root, ".git"), "gitdir: elsewhere")
	cfg, err := loadConfig(root)
	if err != nil || cfg.Server != defaultServer {
		t.Fatalf("%+v, %v", cfg, err)
	}
	path := filepath.Join(root, ".pedit", "config.yaml")
	if _, err := os.Stat(path); err != nil {
		t.Fatal(err)
	}
	if st, err := os.Stat(filepath.Join(root, ".pedit", "templates")); err != nil || !st.IsDir() {
		t.Fatalf("templates: %v", err)
	}
	for name, want := range builtinTemplates {
		data, err := os.ReadFile(filepath.Join(root, ".pedit", "templates", name))
		if err != nil || string(data) != want {
			t.Fatalf("generated %s: %q, %v", name, data, err)
		}
	}
	// The generated configuration loads without requiring any template files.
	reloaded, err := loadConfig(root)
	if err != nil || reloaded.Server != defaultServer || reloaded.Output != "." {
		t.Fatalf("generated config: %+v, %v", reloaded, err)
	}
	put(t, path, "server: http://localhost:8787\noutput: notes\n")
	child := filepath.Join(root, "sub")
	if err := os.Mkdir(child, 0o755); err != nil {
		t.Fatal(err)
	}
	cfg, err = loadConfig(child)
	if err != nil || cfg.root != root || cfg.Output != "notes" {
		t.Fatalf("%+v, %v", cfg, err)
	}
	b, _ := os.ReadFile(path)
	if !strings.Contains(string(b), "localhost") {
		t.Fatal("configuration overwritten")
	}
	// An unconfigured nested repository does not inherit its parent's server.
	put(t, filepath.Join(child, ".git"), "")
	cfg, err = loadConfig(child)
	if err != nil || cfg.Server != defaultServer {
		t.Fatalf("%+v, %v", cfg, err)
	}
}

func TestInitializationPreservesTemplates(t *testing.T) {
	root := t.TempDir()
	put(t, filepath.Join(root, ".git"), "")
	path := filepath.Join(root, ".pedit", "templates", "default.csv")
	put(t, path, "custom,csv\n")
	if _, err := loadConfig(root); err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(path)
	if err != nil || string(data) != "custom,csv\n" {
		t.Fatalf("existing template: %q, %v", data, err)
	}
}

func TestNoInitializationOutsideRepositoryRoot(t *testing.T) {
	root := t.TempDir()
	child := filepath.Join(root, "sub")
	put(t, filepath.Join(root, ".git"), "")
	if err := os.Mkdir(child, 0o755); err != nil {
		t.Fatal(err)
	}
	for _, dir := range []string{child, t.TempDir()} {
		if _, err := loadConfig(dir); err != nil {
			t.Fatal(err)
		}
		if _, err := os.Stat(filepath.Join(dir, ".pedit")); !os.IsNotExist(err) {
			t.Fatalf("initialized %s", dir)
		}
	}
}

func TestInvalidConfig(t *testing.T) {
	for _, content := range []string{"server: ftp://example.com", "server: ''", "unknown: true", "templates:\n  by_extensoin: {}", "templates: [broken", "server: https://example.com\n---\nserver: https://other.com"} {
		t.Run(content, func(t *testing.T) {
			root := t.TempDir()
			put(t, filepath.Join(root, ".pedit", "config.yaml"), content)
			if _, err := loadConfig(root); err == nil {
				t.Fatal("accepted invalid config")
			}
		})
	}
}

func TestPrepareFile(t *testing.T) {
	root := t.TempDir()
	cfg := config{root: root, Output: "notes"}
	for name, text := range map[string]string{"default.md": "markdown", "minutes.md": "minutes", "foo.csv": "a,b\n", "bar.canvas": "{\"nodes\":[],\"edges\":[]}"} {
		put(t, filepath.Join(root, ".pedit", "templates", name), text)
	}
	now := func() string { return "time" }
	for _, tc := range []struct{ template, ext, content string }{
		{"", ".md", "markdown"}, {"csv", ".csv", builtinTemplates["default.csv"]},
		{"foo.csv", ".csv", "a,b\n"}, {"canvas", ".canvas", builtinTemplates["default.canvas"]},
		{"bar.canvas", ".canvas", "{\"nodes\":[],\"edges\":[]}"}, {"minutes.md", ".md", "minutes"}, {"", ".md", "markdown"},
	} {
		path, created, err := prepareFile(cfg, "", tc.template, "", now)
		if err != nil || !created || filepath.Ext(path) != tc.ext || filepath.Dir(path) != filepath.Join(root, "notes") {
			t.Fatalf("%s, %v, %v", path, created, err)
		}
		b, _ := os.ReadFile(path)
		if string(b) != tc.content {
			t.Fatalf("content: %q", b)
		}
		if tc.ext == ".canvas" {
			if _, err := canvas.Parse(b); err != nil {
				t.Fatal(err)
			}
		}
	}
	if _, _, err := prepareFile(cfg, filepath.Join(root, "wrong.md"), "canvas", "", now); err == nil {
		t.Fatal("accepted canvas with Markdown extension")
	}
	path := filepath.Join(root, "named.md")
	if _, created, err := prepareFile(cfg, path, "", "", now); err != nil || created {
		t.Fatalf("missing file without template: %v, %v", created, err)
	}
	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Fatal("created missing file without template")
	}
	if _, _, err := prepareFile(cfg, path, "minutes.md", "", now); err != nil {
		t.Fatal(err)
	}
	if _, created, err := prepareFile(cfg, path, "", "", now); err != nil || created {
		t.Fatalf("existing: %v, %v", created, err)
	}
	if _, _, err := prepareFile(cfg, path, "minutes.md", "", now); err == nil {
		t.Fatal("overwrote existing file")
	}
	b, _ := os.ReadFile(path)
	if string(b) != "minutes" {
		t.Fatalf("existing changed: %q", b)
	}
	for _, name := range []string{"missing.md", "missingtype", "../default.md", "nested/minutes.md", "nested\\minutes.md", filepath.Join(root, "default.md")} {
		if _, _, err := prepareFile(cfg, "", name, "", now); err == nil {
			t.Fatalf("accepted %s", name)
		}
	}
}

func TestTemplatePrefixesAndOutputDirectory(t *testing.T) {
	root := t.TempDir()
	cfg := config{root: root, Output: "configured"}
	for _, name := range []string{"minutes.md", "あああ.md", "project.notes.md"} {
		put(t, filepath.Join(root, ".pedit", "templates", name), "keep template")
	}
	now := func() string { return "2026-10-02-120000" }
	for _, tc := range []struct{ template, filename string }{
		{"", "pedit-2026-10-02-120000.md"},
		{"csv", "pedit-2026-10-02-120000.csv"},
		{"canvas", "pedit-2026-10-02-120000.canvas"},
		{"minutes.md", "minutes-2026-10-02-120000.md"},
		{"あああ.md", "あああ-2026-10-02-120000.md"},
		{"project.notes.md", "project.notes-2026-10-02-120000.md"},
	} {
		path, created, err := prepareFile(cfg, "", tc.template, "", now)
		want := filepath.Join(root, "configured", tc.filename)
		if err != nil || !created || path != want {
			t.Fatalf("%q: %q, %v, %v; want %q", tc.template, path, created, err, want)
		}
	}
	cwd := t.TempDir()
	t.Chdir(cwd)
	for _, dir := range []string{"first/meetings", "second"} {
		path, _, err := prepareFile(cfg, "", "minutes.md", dir, now)
		if err != nil || path != filepath.Join(dir, "minutes-2026-10-02-120000.md") {
			t.Fatalf("directory override: %q, %v", path, err)
		}
		if _, err := os.Stat(filepath.Join(cwd, path)); err != nil {
			t.Fatal(err)
		}
	}
	path, _, err := prepareFile(cfg, "", "minutes.md", "first/meetings", now)
	if err != nil || filepath.Base(path) != "minutes-2026-10-02-120000-2.md" {
		t.Fatalf("collision: %q, %v", path, err)
	}
	absoluteDir := filepath.Join(t.TempDir(), "meetings")
	path, _, err = prepareFile(cfg, "", "minutes.md", absoluteDir, now)
	if err != nil || filepath.Dir(path) != absoluteDir {
		t.Fatalf("absolute override: %q, %v", path, err)
	}
	data, err := os.ReadFile(filepath.Join(root, ".pedit", "templates", "minutes.md"))
	if err != nil || string(data) != "keep template" {
		t.Fatalf("template changed: %q, %v", data, err)
	}
}

func TestTemplatesAreFlat(t *testing.T) {
	root := t.TempDir()
	cfg := config{root: root, Output: "."}
	put(t, filepath.Join(root, ".pedit", "templates", "nested", "minutes.md"), "minutes")
	for _, name := range []string{"nested/minutes.md", "nested\\minutes.md", "./default.md", "../default.md"} {
		if _, _, err := prepareFile(cfg, "", name, "", func() string { return "time" }); err == nil {
			t.Fatalf("accepted nested template %q", name)
		}
	}
	if _, _, err := prepareFile(cfg, "named.md", "minutes.md", "somewhere", func() string { return "time" }); err == nil {
		t.Fatal("accepted file and directory together")
	}
}

func TestBuiltinAndProjectTemplates(t *testing.T) {
	root := t.TempDir()
	cfg := config{root: root}
	for name, want := range builtinTemplates {
		data, err := cfg.template(name)
		if err != nil || string(data) != want {
			t.Fatalf("%s: %q, %v", name, data, err)
		}
	}
	put(t, filepath.Join(root, ".pedit", "templates", "default.csv"), "custom,csv\n")
	data, err := cfg.template("default.csv")
	if err != nil || string(data) != "custom,csv\n" {
		t.Fatalf("override: %q, %v", data, err)
	}
}

func TestTemplatesStayInsideTheProject(t *testing.T) {
	root := t.TempDir()
	secret := filepath.Join(t.TempDir(), "id_ed25519")
	put(t, secret, "PRIVATE KEY")
	put(t, filepath.Join(root, ".pedit", "templates", "base.md"), "# Minutes\n")
	links := map[string]string{
		"default.md":  secret,                                  // a cloned repository can carry this
		"relative.md": filepath.Join("..", "..", "..", "x.md"), // escapes by climbing
		"minutes.md":  "base.md",                               // stays inside: fine
	}
	for name, target := range links {
		if err := os.Symlink(target, filepath.Join(root, ".pedit", "templates", name)); err != nil {
			t.Skip("symlinks unavailable:", err)
		}
	}
	cfg := config{root: root, Output: "."}
	for _, name := range []string{"default.md", "relative.md"} {
		data, err := cfg.template(name)
		if err == nil || strings.Contains(string(data), "PRIVATE") {
			t.Fatalf("%s: read %q, %v", name, data, err)
		}
	}
	if _, _, err := prepareFile(cfg, "", "", "", func() string { return "time" }); err == nil {
		t.Fatal("created a file from a template that links out of the project")
	}
	if entries, _ := filepath.Glob(filepath.Join(root, "pedit-*")); len(entries) != 0 {
		t.Fatalf("created %v", entries)
	}
	data, err := cfg.template("minutes.md")
	if err != nil || string(data) != "# Minutes\n" {
		t.Fatalf("link inside the project: %q, %v", data, err)
	}
}

func TestParseArgs(t *testing.T) {
	for _, tc := range []struct {
		args                      []string
		file, template, directory string
	}{
		{[]string{"--csv"}, "", "csv", ""},
		{[]string{"--canvas"}, "", "canvas", ""},
		{[]string{"-t", "csv"}, "", "csv", ""},
		{[]string{"-t", "canvas"}, "", "canvas", ""},
		{[]string{"--template", "minutes.md"}, "", "minutes.md", ""},
		{[]string{"--template=minutes.md", "notes.md"}, "notes.md", "minutes.md", ""},
		{[]string{"notes.md", "-t", "minutes.md"}, "notes.md", "minutes.md", ""},
		{[]string{"-t", "foo.csv", "-d", "reports"}, "", "foo.csv", "reports"},
		{[]string{"-d", "reports", "--canvas"}, "", "canvas", "reports"},
		{[]string{"--directory=reports"}, "", "", "reports"},
		{[]string{"--foo.csv"}, "", "foo.csv", ""},
		{[]string{"--", "-notes.md"}, "-notes.md", "", ""},
	} {
		opts, err := parseArgs(tc.args)
		if err != nil || opts.File != tc.file || opts.Template != tc.template || opts.Directory != tc.directory || opts.Room != "" {
			t.Fatalf("%q: %+v %v", tc.args, opts, err)
		}
	}
	const link = "https://edit.piconic.ai/r/ROOM#key"
	for _, tc := range []struct {
		args      []string
		directory string
	}{
		{[]string{link}, ""},
		{[]string{"-d", "shared", link}, "shared"},
		{[]string{link, "--directory=shared"}, "shared"},
	} {
		opts, err := parseArgs(tc.args)
		if err != nil || opts.Room != link || opts.File != "" || opts.Template != "" || opts.Directory != tc.directory {
			t.Fatalf("%q: %+v %v", tc.args, opts, err)
		}
	}
	if opts, err := parseArgs([]string{"http://localhost:8787/r/ROOM#key"}); err != nil || opts.Room == "" {
		t.Fatalf("http link: %+v %v", opts, err)
	}
	for _, args := range [][]string{
		{"--template"}, {"--template="}, {"--template=a", "-t", "b"}, {"-t", ""}, {"-unknown"},
		{"--csv", "--canvas"}, {"--canvas", "-t", "csv"}, {"-t", "--csv"}, {"a", "b"},
		{"-d"}, {"-d", ""}, {"--directory="}, {"-d", "--csv"}, {"-d", "a", "-d", "b"},
		{"notes.md", "-d", "reports"}, {"-d", "reports", "--", "notes.md"},
		{"https://edit.piconic.ai/r/ROOM#key", "notes.md"}, {"notes.md", "https://edit.piconic.ai/r/ROOM#key"},
		{"https://edit.piconic.ai/r/ROOM#key", "-t", "minutes.md"}, {"--csv", "https://edit.piconic.ai/r/ROOM#key"},
		{"https://edit.piconic.ai/r/ROOM#key", "https://edit.piconic.ai/r/ROOM#key"},
	} {
		if _, err := parseArgs(args); err == nil {
			t.Fatalf("accepted %q", args)
		}
	}
}
