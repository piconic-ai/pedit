package protocol

import (
	"encoding/json"
	"errors"
	"os"
	"strings"
	"testing"
)

// pathVectors are shared with packages/protocol, which checks the same
// paths. sameFile and differentFiles are for PathKey, which only Go has.
type pathVectors struct {
	Accepted []string `json:"accepted"`
	Refused  []struct {
		Path    string `json:"path"`
		Problem string `json:"problem"`
	} `json:"refused"`
	SameFile       [][2]string `json:"sameFile"`
	DifferentFiles [][2]string `json:"differentFiles"`
}

func loadPathVectors(t *testing.T) pathVectors {
	t.Helper()
	data, err := os.ReadFile("../../packages/testdata/path-vectors.json")
	if err != nil {
		t.Fatal(err)
	}
	var v pathVectors
	if err := json.Unmarshal(data, &v); err != nil {
		t.Fatal(err)
	}
	return v
}

func TestCheckPathMatchesTheSharedVectors(t *testing.T) {
	v := loadPathVectors(t)
	for _, p := range v.Accepted {
		if err := CheckPath(p); err != nil {
			t.Errorf("CheckPath(%q) = %v, want nil", p, err)
		}
	}
	for _, c := range v.Refused {
		var problem PathProblem
		if err := CheckPath(c.Path); !errors.As(err, &problem) || string(problem) != c.Problem {
			t.Errorf("CheckPath(%q) = %v, want %s", c.Path, err, c.Problem)
		}
	}
}

func TestCheckPathRefusesWhatFilepathIsLocalAccepts(t *testing.T) {
	// Evidence A6 of #113: filepath.IsLocal returns true for all of these on Linux.
	for _, p := range []string{"CON", "nul.txt", "com1.md", "a:b.md", "notes.md:stream", "trailing.", "trailing ", `a\b.md`, "a\x00b", "a‮b.md"} {
		if CheckPath(p) == nil {
			t.Errorf("CheckPath(%q) = nil", p)
		}
	}
}

func TestCheckPathBoundsLengths(t *testing.T) {
	component := strings.Repeat("a", MaxComponentBytes)
	if err := CheckPath(component); err != nil {
		t.Errorf("a %d-byte component: %v", MaxComponentBytes, err)
	}
	if err := CheckPath(component + "a"); !errors.Is(err, PathComponentTooLong) {
		t.Errorf("a longer component: %v", err)
	}
	// Bytes, not characters: 128 "é" are 256 bytes.
	if err := CheckPath(strings.Repeat("é", 128)); !errors.Is(err, PathComponentTooLong) {
		t.Errorf("a component of 256 bytes in 128 characters: %v", err)
	}
	long := strings.Repeat(strings.Repeat("a", 200)+"/", 5) + strings.Repeat("a", MaxPathBytes-5*201)
	if err := CheckPath(long); err != nil {
		t.Errorf("a %d-byte path: %v", MaxPathBytes, err)
	}
	if err := CheckPath(long + "a"); !errors.Is(err, PathTooLong) {
		t.Errorf("a longer path: %v", err)
	}
}

func TestCheckPathRefusesInvalidUTF8(t *testing.T) {
	for _, p := range []string{"a\xffb.md", "\xc3", "docs/\xed\xa0\x80.md"} {
		if err := CheckPath(p); !errors.Is(err, PathEncoding) {
			t.Errorf("CheckPath(%q) = %v, want %s", p, err, PathEncoding)
		}
	}
}

func TestPathKeyMatchesTheSharedVectors(t *testing.T) {
	v := loadPathVectors(t)
	for _, c := range v.SameFile {
		if PathKey(c[0]) != PathKey(c[1]) {
			t.Errorf("PathKey(%q) = %q, PathKey(%q) = %q, want them equal", c[0], PathKey(c[0]), c[1], PathKey(c[1]))
		}
	}
	for _, c := range v.DifferentFiles {
		if PathKey(c[0]) == PathKey(c[1]) {
			t.Errorf("PathKey(%q) = PathKey(%q) = %q", c[0], c[1], PathKey(c[0]))
		}
	}
}

func TestPathKeyIsStable(t *testing.T) {
	v := loadPathVectors(t)
	for _, p := range v.Accepted {
		if k := PathKey(p); PathKey(k) != k {
			t.Errorf("PathKey(PathKey(%q)) = %q, want %q", p, PathKey(k), k)
		}
	}
}
