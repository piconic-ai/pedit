package protocol

import (
	"errors"
	"slices"
	"strings"
	"unicode/utf8"
)

var errUncertainKeptReferences = errors.New("attachment references cannot be determined")

// conservativeKeptReferences returns a superset of renderer attachment paths
// for its narrow supported syntax. Unsupported image markers fail closed.
func conservativeKeptReferences(source string) ([]string, error) {
	if !utf8.ValidString(source) || len(source) > MaxFrameBytes {
		return nil, errUncertainKeptReferences
	}
	paths := make([]string, 0)
	for {
		at := strings.IndexByte(source, '!')
		if at < 0 {
			break
		}
		source = source[at:]
		if !strings.HasPrefix(source, "![") {
			return nil, errUncertainKeptReferences
		}
		altEnd := strings.IndexByte(source[2:], ']')
		if altEnd < 0 {
			return nil, errUncertainKeptReferences
		}
		for _, ch := range source[2 : 2+altEnd] {
			if !(ch >= 'a' && ch <= 'z' || ch >= 'A' && ch <= 'Z' || ch >= '0' && ch <= '9' || ch == ' ' || ch == '-' || ch == '_' || ch == '.') {
				return nil, errUncertainKeptReferences
			}
		}
		source = source[2+altEnd:]
		if !strings.HasPrefix(source, "](") {
			return nil, errUncertainKeptReferences
		}
		end := strings.IndexByte(source[2:], ')')
		if end < 0 {
			return nil, errUncertainKeptReferences
		}
		path := source[2 : 2+end]
		if !keptAssetPath.MatchString(path) {
			return nil, errUncertainKeptReferences
		}
		paths = append(paths, path)
		if len(paths) > MaxKeptInventoryPaths {
			return nil, errUncertainKeptReferences
		}
		source = source[3+end:]
	}
	slices.Sort(paths)
	return slices.Compact(paths), nil
}
