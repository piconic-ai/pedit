package main

import (
	"bytes"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"net/url"
	"os"
	"path/filepath"
	"strings"

	"gopkg.in/yaml.v3"
)

type config struct {
	Server string `yaml:"server"`
	Output string `yaml:"output"`
	root   string
}

const initialConfig = `server: https://edit.piconic.ai

# Where unnamed new files are saved, relative to this project.
output: .
`

// Project files override these defaults, including outside Git repositories.
var builtinTemplates = map[string]string{
	"default.md":     "",
	"default.csv":    "column1,column2\n,\n",
	"default.canvas": "{\n  \"nodes\": [],\n  \"edges\": []\n}\n",
}

func loadConfig(cwd string) (config, error) {
	c := config{Server: defaultServer, Output: ".", root: cwd}
	for dir := cwd; ; dir = filepath.Dir(dir) {
		path := filepath.Join(dir, ".pedit", "config.yaml")
		data, err := os.ReadFile(path)
		if err == nil {
			c.root = dir
			dec := yaml.NewDecoder(bytes.NewReader(data))
			dec.KnownFields(true)
			if err := dec.Decode(&c); err != nil && !errors.Is(err, io.EOF) {
				return c, fmt.Errorf("%s: %w", path, err)
			}
			var extra any
			if err := dec.Decode(&extra); !errors.Is(err, io.EOF) {
				return c, fmt.Errorf("%s: expected one YAML document", path)
			}
			u, err := url.Parse(c.Server)
			if err != nil || u.Host == "" || (u.Scheme != "http" && u.Scheme != "https") {
				return c, fmt.Errorf("%s: server must be an http or https URL", path)
			}
			return c, nil
		}
		if !errors.Is(err, os.ErrNotExist) {
			return c, err
		}
		if _, err := os.Stat(filepath.Join(dir, ".git")); err == nil {
			if dir == cwd {
				if err := os.MkdirAll(filepath.Join(dir, ".pedit", "templates"), 0o755); err != nil {
					return c, err
				}
				f, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o644)
				if errors.Is(err, os.ErrExist) {
					return loadConfig(cwd)
				}
				if err != nil {
					return c, err
				}
				_, writeErr := io.WriteString(f, initialConfig)
				closeErr := f.Close()
				if writeErr != nil {
					return c, writeErr
				}
				if closeErr != nil {
					return c, closeErr
				}
				for name, content := range builtinTemplates {
					err := writeNewFile(filepath.Join(dir, ".pedit", "templates", name), []byte(content))
					if err != nil && !errors.Is(err, os.ErrExist) {
						return c, err
					}
				}
			}
			break
		}
		if filepath.Dir(dir) == dir {
			break
		}
	}
	return c, nil
}

func (c config) template(name string) ([]byte, error) {
	if name == "" || name == "." || name == ".." || strings.ContainsAny(name, "/\\") || filepath.IsAbs(name) || filepath.VolumeName(name) != "" {
		return nil, fmt.Errorf("template must be a filename in .pedit/templates (no subdirectories): %q", name)
	}
	clean := name
	data, err := readInProject(c.root, filepath.Join(".pedit", "templates", clean))
	if errors.Is(err, os.ErrNotExist) {
		if content, ok := builtinTemplates[clean]; ok {
			return []byte(content), nil
		}
	}
	return data, err
}

// readInProject reads name under the project root, following links only while
// they stay inside it. Templates come with the repository, and one shipped as
// a link to, say, ~/.ssh/id_ed25519 must not become a shared file.
func readInProject(root, name string) ([]byte, error) {
	r, err := os.OpenRoot(root)
	if err != nil {
		return nil, err
	}
	defer r.Close()
	data, err := r.ReadFile(name)
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		if info, lerr := r.Lstat(name); lerr == nil && info.Mode()&fs.ModeSymlink != 0 {
			return nil, fmt.Errorf("%s is a link that leads out of the project; pedit reads templates only inside it", name)
		}
	}
	return data, err
}

// prepareFile leaves existing files untouched and exclusively creates new files.
func prepareFile(c config, file, template, directory string, now func() string) (string, bool, error) {
	if file != "" && directory != "" {
		return "", false, errors.New("use either a file path or -d, not both")
	}
	if file != "" {
		_, err := os.Stat(file)
		if err == nil {
			if template != "" {
				return "", false, fmt.Errorf("%s already exists; -t requires a new file", file)
			}
			return file, false, nil
		}
		if !errors.Is(err, os.ErrNotExist) {
			return "", false, err
		}
	}
	// A named file without --template must already exist, so typos do not
	// create stray files. Unnamed files default to Markdown.
	if file != "" && template == "" {
		return file, false, nil
	}
	template = templateName(template)
	ext := filepath.Ext(template)
	if file != "" && filepath.Ext(file) != ext {
		return "", false, fmt.Errorf("output file must have extension %s for template %q", ext, template)
	}
	content, err := c.template(template)
	if err != nil {
		return "", false, fmt.Errorf("template %q: %w", template, err)
	}
	if file != "" {
		err = writeNewFile(file, content)
		return file, true, err
	}
	dir := outputDirectory(c, directory)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return "", false, err
	}
	prefix := strings.TrimSuffix(template, ext)
	if prefix == "default" {
		prefix = "pedit"
	}
	base := prefix + "-" + now()
	for n := 1; ; n++ {
		suffix := ""
		if n > 1 {
			suffix = fmt.Sprintf("-%d", n)
		}
		path := filepath.Join(dir, base+suffix+ext)
		err := writeNewFile(path, content)
		if errors.Is(err, os.ErrExist) {
			continue
		}
		return path, true, err
	}
}

// Command-line directories are relative to cwd; config paths to the project.
func outputDirectory(c config, directory string) string {
	if directory != "" {
		return directory
	}
	if filepath.IsAbs(c.Output) {
		return c.Output
	}
	return filepath.Join(c.root, c.Output)
}

func writeNewFile(path string, content []byte) error {
	f, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o644)
	if err != nil {
		return err
	}
	_, err = f.Write(content)
	closeErr := f.Close()
	if err != nil {
		_ = os.Remove(path)
		return err
	}
	return closeErr
}

// A bare type selects default.<type>; a filename selects that template.
func templateName(name string) string {
	if name == "" {
		return "default.md"
	}
	if filepath.Ext(name) == "" && !strings.ContainsAny(name, "/\\") {
		return "default." + name
	}
	return name
}

type commandArgs struct {
	File string
	// Room is a share link to join instead of a file to share.
	Room      string
	Template  string
	Directory string
}

// isShareLink tells a share link apart from a file name: files that start
// with a URL scheme are not supported.
func isShareLink(arg string) bool {
	return strings.HasPrefix(arg, "https://") || strings.HasPrefix(arg, "http://")
}

func parseArgs(args []string) (commandArgs, error) {
	var opts commandArgs
	fail := func(message string) (commandArgs, error) { return commandArgs{}, errors.New(message) }
	for i := 0; i < len(args); i++ {
		arg := args[i]
		option, value, hasValue := strings.Cut(arg, "=")
		switch option {
		case "-t", "--template", "-d", "--directory":
			if !hasValue {
				i++
				if i == len(args) || strings.HasPrefix(args[i], "-") {
					return fail(option + " requires a value")
				}
				value = args[i]
			}
			if value == "" {
				return fail(option + " requires a value")
			}
			if option == "-t" || option == "--template" {
				if opts.Template != "" {
					return fail("select only one template")
				}
				opts.Template = value
			} else {
				if opts.Directory != "" {
					return fail("specify only one output directory")
				}
				opts.Directory = value
			}
		case "-h", "--help", "-v", "--version":
			return fail("help and version must be used alone")
		case "--":
			if i+2 != len(args) || opts.File != "" || args[i+1] == "" {
				return fail("expected one file")
			}
			opts.File = args[i+1]
			i++
		default:
			if strings.HasPrefix(arg, "--") && !hasValue {
				if opts.Template != "" {
					return fail("select only one template")
				}
				opts.Template = strings.TrimPrefix(arg, "--")
			} else {
				if arg == "" || strings.HasPrefix(arg, "-") || opts.File != "" || opts.Room != "" {
					return fail("expected one file or share link")
				}
				if isShareLink(arg) {
					opts.Room = arg
				} else {
					opts.File = arg
				}
			}
		}
	}
	if opts.File != "" && opts.Directory != "" {
		return fail("use either a file path or -d, not both")
	}
	if opts.Room != "" && opts.Template != "" {
		return fail("a share link cannot be combined with a template")
	}
	return opts, nil
}
