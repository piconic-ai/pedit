package main

import (
	"errors"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"strings"
	"unicode/utf8"

	"github.com/piconic-ai/pedit/internal/suggest"
)

// checkFile tells why arg cannot be shared, in words that help fix it, or
// returns "" when it can. New files are prepared separately when a template
// is selected, or when no filename is supplied.
func checkFile(arg string) string {
	dir, name := filepath.Split(arg)
	st, err := os.Stat(arg)
	switch {
	case errors.Is(err, fs.ErrNotExist):
		if _, err := os.Stat(filepath.Dir(arg)); errors.Is(err, fs.ErrNotExist) {
			return "pedit: " + dir + " does not exist, so " + arg + " cannot be there."
		}
		return missing(arg, dir, suggest.Files(filepath.Dir(arg), name))
	case errors.Is(err, fs.ErrPermission):
		return "pedit: cannot read " + arg + ": permission denied."
	case err != nil:
		return "pedit: cannot open " + arg + ": " + err.Error()
	case st.IsDir():
		return directory(arg)
	case !st.Mode().IsRegular():
		return "pedit: " + arg + " is not a regular file. pedit shares text files."
	case !canRead(arg):
		return "pedit: cannot read " + arg + ": permission denied."
	case !canWrite(arg):
		return "pedit: " + arg + " is read-only. pedit writes edits back to it, so it needs write permission."
	case !canWrite(filepath.Dir(arg)):
		return "pedit: cannot save to " + arg + ": pedit saves by replacing the file, which needs write permission on " + dirName(arg) + "."
	}
	return ""
}

func missing(arg, dir string, names []string) string {
	lines := []string{"pedit: " + arg + " does not exist.", ""}
	names = slices.DeleteFunc(names, unprintable)
	if len(names) > 0 {
		if len(names) == 1 {
			lines = append(lines, "  Did you mean this one?")
		} else {
			lines = append(lines, "  Did you mean one of these?")
		}
		for _, n := range names {
			lines = append(lines, "    pedit "+shellQuote(dir+n))
		}
		lines = append(lines, "")
	}
	lines = append(lines, "To create a file, run `pedit` without an argument, use `pedit -t <template> <file>`, or create the file first.")
	return strings.Join(lines, "\n")
}

// maxListed is how many text files a directory may hold for pedit to list them.
const maxListed = 5

func directory(arg string) string {
	msg := "pedit: " + arg + " is a directory. pedit shares a single file."
	names := textFiles(arg, maxListed)
	if len(names) == 0 || len(names) > maxListed {
		return msg
	}
	prefix := ""
	if filepath.Clean(arg) != "." {
		prefix = strings.TrimSuffix(arg, "/") + "/"
	}
	lines := []string{msg, "", "  Pick one of these:"}
	for _, n := range names {
		lines = append(lines, "    pedit "+shellQuote(prefix+n))
	}
	return strings.Join(lines, "\n")
}

// textFiles lists the regular files directly in dir that look like text.
// It stops after limit+1, which is enough to tell there are too many, so a
// large directory is not read through.
func textFiles(dir string, limit int) []string {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil
	}
	var names []string
	for _, e := range entries {
		if strings.HasPrefix(e.Name(), ".") || unprintable(e.Name()) {
			continue
		}
		if st, err := os.Stat(filepath.Join(dir, e.Name())); err == nil && st.Mode().IsRegular() && isText(filepath.Join(dir, e.Name())) {
			names = append(names, e.Name())
			if len(names) > limit {
				break
			}
		}
	}
	return names
}

// unprintable tells a file name that would put control characters on the
// terminal, such as an escape sequence planted in a cloned repository. Such
// a name is never suggested.
func unprintable(name string) bool { return printable(name) != name }

// isText guesses from the start of the file: UTF-8 without NUL bytes.
func isText(path string) bool {
	f, err := os.Open(path)
	if err != nil {
		return false
	}
	defer f.Close()
	b := make([]byte, 8192)
	n, err := io.ReadFull(f, b)
	if err != nil && !errors.Is(err, io.ErrUnexpectedEOF) && !errors.Is(err, io.EOF) {
		return false
	}
	full := n == len(b)
	b = b[:n]
	if full {
		// Drop a character the read cut in half.
		for i := len(b) - 1; i >= 0 && i >= len(b)-utf8.UTFMax; i-- {
			if utf8.RuneStart(b[i]) {
				if !utf8.FullRune(b[i:]) {
					b = b[:i]
				}
				break
			}
		}
	}
	return utf8.Valid(b) && !strings.ContainsRune(string(b), 0)
}

// dirName is the directory arg is in, as people read it.
func dirName(arg string) string {
	dir, _ := filepath.Split(arg)
	if dir == "" {
		return "the current directory"
	}
	return dir
}

var plainWord = regexp.MustCompile(`^[A-Za-z0-9_./@%+=:,-]+$`)

// shellQuote quotes s for a POSIX shell unless it needs none.
func shellQuote(s string) string {
	if plainWord.MatchString(s) {
		return s
	}
	return "'" + strings.ReplaceAll(s, "'", `'\''`) + "'"
}
