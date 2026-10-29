package protocol

import (
	"errors"
	"slices"
	"strings"
	"unicode/utf8"
)

var errUncertainKeptReferences = errors.New("attachment references cannot be determined")

// KeptReferenceCandidates contains possible attachment paths, including
// conservative false positives. It does not prove inventory completeness.
type KeptReferenceCandidates struct {
	possible []string
}

// PossiblePaths returns an independent copy of the candidate paths.
func (c KeptReferenceCandidates) PossiblePaths() []string {
	return slices.Clone(c.possible)
}

// DiscoverKeptReferenceCandidates over-approximates supported inline image
// paths for one Markdown document. Unsupported markers fail closed.
func DiscoverKeptReferenceCandidates(source, directory string) (KeptReferenceCandidates, error) {
	if !utf8.ValidString(source) || len(source) > MaxFrameBytes || !simpleKeptDirectory(directory) {
		return KeptReferenceCandidates{}, errUncertainKeptReferences
	}
	paths := make([]string, 0)
	for {
		at := strings.IndexByte(source, '!')
		if at < 0 {
			break
		}
		path, rest, ok := parseSimpleKeptImage(source[at:], directory)
		if !ok {
			return KeptReferenceCandidates{}, errUncertainKeptReferences
		}
		paths = append(paths, path)
		if len(paths) > MaxKeptInventoryPaths {
			return KeptReferenceCandidates{}, errUncertainKeptReferences
		}
		source = rest
	}
	slices.Sort(paths)
	return KeptReferenceCandidates{possible: slices.Compact(paths)}, nil
}

func parseSimpleKeptImage(source, directory string) (string, string, bool) {
	if !strings.HasPrefix(source, "![") {
		return "", "", false
	}
	altEnd := strings.IndexByte(source[2:], ']')
	if altEnd < 0 || !simpleKeptAlt(source[2:2+altEnd]) {
		return "", "", false
	}
	source = source[2+altEnd:]
	if !strings.HasPrefix(source, "](") {
		return "", "", false
	}
	end := strings.IndexByte(source[2:], ')')
	if end < 0 {
		return "", "", false
	}
	path, ok := normalizeSimpleKeptPath(source[2:2+end], directory)
	return path, source[3+end:], ok
}

func normalizeSimpleKeptPath(path, directory string) (string, bool) {
	for _, separator := range []string{"/", "&#47;", `\/`} {
		prefix := directory + separator
		if strings.HasPrefix(path, prefix) {
			name := strings.TrimPrefix(path, prefix)
			if keptAssetPath.MatchString("assets/" + name) {
				return directory + "/" + name, true
			}
		}
	}
	return "", false
}

func simpleKeptDirectory(directory string) bool {
	if directory == "" || len(directory) > 255 || directory == "." || directory == ".." {
		return false
	}
	for _, ch := range directory {
		if !(ch >= 'a' && ch <= 'z' || ch >= 'A' && ch <= 'Z' || ch >= '0' && ch <= '9' || ch == '-' || ch == '_' || ch == '.') {
			return false
		}
	}
	return true
}

func simpleKeptAlt(alt string) bool {
	for _, ch := range alt {
		if !(ch >= 'a' && ch <= 'z' || ch >= 'A' && ch <= 'Z' || ch >= '0' && ch <= '9' || ch == ' ' || ch == '-' || ch == '_' || ch == '.') {
			return false
		}
	}
	return true
}
