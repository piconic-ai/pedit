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

func loadConfig(cwd string) (config, error) { return findConfig(cwd, true) }

// findConfig looks for the configuration from cwd up. When retry is set and
// another pedit creates the default configuration between our look and our
// create, it reads that one instead, once: never again, so a name that keeps
// reading as missing yet cannot be created stops pedit rather than looping.
func findConfig(cwd string, retry bool) (config, error) {
	c := config{Server: defaultServer, Output: ".", root: cwd}
	for dir := cwd; ; dir = filepath.Dir(dir) {
		path := filepath.Join(dir, ".pedit", "config.yaml")
		data, err := readConfig(path)
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
				f, err := createConfig(path)
				if errors.Is(err, os.ErrExist) && retry {
					return findConfig(cwd, false)
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

// createConfig creates the default configuration, failing if anything has its
// name. Tests replace it.
var createConfig = func(path string) (*os.File, error) {
	return os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o644)
}

// readConfig reads a configuration file, unless a user other than you or root
// owns it. pedit looks for one in every directory above the current one, so in
// a directory anyone can write to, such as /tmp, another user could otherwise
// choose the server that gets your file and serves the editor that holds its key.
//
// It follows links, and reports os.ErrNotExist only when nothing has the name:
// a link whose target is gone is a configuration pedit cannot read, and falling
// back to the default server would send the file where the project did not
// choose.
func readConfig(path string) ([]byte, error) {
	f, err := os.Open(path)
	if errors.Is(err, os.ErrNotExist) {
		if err := brokenLink(filepath.Dir(path), path); err != nil {
			return nil, err
		}
	}
	if err != nil {
		return nil, err
	}
	defer f.Close()
	owner, trusted, err := fileOwner(f)
	if err != nil {
		return nil, fmt.Errorf("%s: cannot tell who owns it, so pedit does not use it: %w", path, err)
	}
	if !trusted {
		return nil, fmt.Errorf("%s belongs to another user (%s), so pedit does not use it: it decides where your files are sent. Remove it, or run pedit from a directory you own", path, owner)
	}
	return io.ReadAll(f)
}

// brokenLink reports the first of paths that exists but leads nowhere, such as
// a link to a file that was removed or a share that is not mounted. The error
// does not wrap os.ErrNotExist, so the caller stops instead of using defaults.
func brokenLink(paths ...string) error {
	for _, p := range paths {
		if _, err := os.Lstat(p); err != nil {
			continue
		}
		if _, err := os.Stat(p); errors.Is(err, os.ErrNotExist) {
			return fmt.Errorf("%s is a link whose target does not exist, so pedit cannot read the configuration: it decides where your files are sent. Fix the link, or remove it", p)
		}
	}
	return nil
}

// trustedOwner tells whether a file owned by uid may configure pedit for the
// user me: their own file, or one only root could have written.
func trustedOwner(uid, me int) bool { return uid == me || uid == 0 }

// trustedSID is trustedOwner for Windows, by SID: the user's own file, or one
// written by SYSTEM or an administrator, whose files the Administrators group
// owns.
func trustedSID(owner, me string) bool {
	return owner == me || owner == "S-1-5-18" || owner == "S-1-5-32-544"
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
