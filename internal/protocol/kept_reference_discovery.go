package protocol

import (
	"errors"
	"slices"
	"strings"
	"unicode/utf8"
)

var errUncertainKeptReferences = errors.New("attachment references cannot be determined")

type conservativeKeptReferenceSet struct {
	possible []string
}

// conservativeKeptReferences returns a superset of renderer attachment paths
// for its narrow supported syntax. Unsupported image markers fail closed.
func conservativeKeptReferences(source string) (conservativeKeptReferenceSet, error) {
	if !utf8.ValidString(source) || len(source) > MaxFrameBytes {
		return conservativeKeptReferenceSet{}, errUncertainKeptReferences
	}
	paths := make([]string, 0)
	for {
		at := strings.IndexByte(source, '!')
		if at < 0 {
			break
		}
		path, rest, ok := parseSimpleKeptImage(source[at:])
		if !ok {
			return conservativeKeptReferenceSet{}, errUncertainKeptReferences
		}
		paths = append(paths, path)
		if len(paths) > MaxKeptInventoryPaths {
			return conservativeKeptReferenceSet{}, errUncertainKeptReferences
		}
		source = rest
	}
	slices.Sort(paths)
	return conservativeKeptReferenceSet{possible: slices.Compact(paths)}, nil
}

func parseSimpleKeptImage(source string) (string, string, bool) {
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
	if end < 0 || !keptAssetPath.MatchString(source[2:2+end]) {
		return "", "", false
	}
	return source[2 : 2+end], source[3+end:], true
}

func simpleKeptAlt(alt string) bool {
	for _, ch := range alt {
		if !(ch >= 'a' && ch <= 'z' || ch >= 'A' && ch <= 'Z' || ch >= '0' && ch <= '9' || ch == ' ' || ch == '-' || ch == '_' || ch == '.') {
			return false
		}
	}
	return true
}
