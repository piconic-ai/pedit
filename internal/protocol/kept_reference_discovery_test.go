package protocol

import (
	"encoding/json"
	"os"
	"slices"
	"strings"
	"testing"
)

func TestConservativeReferencesCoverRendererLookups(t *testing.T) {
	raw, err := os.ReadFile("../../packages/testdata/kept-reference-cases.json")
	if err != nil {
		t.Fatal(err)
	}
	var cases []struct {
		Name, Source string
		Lookups      []string
	}
	if err := json.Unmarshal(raw, &cases); err != nil {
		t.Fatal(err)
	}
	accepted := map[string]bool{
		"inline": true, "entity slash": true, "escaped slash": true,
		"reference definition": false, "code": true, "escaped marker": true,
		"configured directory": true, "percent slash": false, "external image": false,
		"frontmatter": true, "raw HTML": true, "two references": true,
	}
	for _, item := range cases {
		t.Run(item.Name, func(t *testing.T) {
			want, known := accepted[item.Name]
			if !known {
				t.Fatal("case needs an acceptance expectation")
			}
			directory := "assets"
			if item.Name == "configured directory" {
				directory = "images"
			}
			paths, err := DiscoverKeptReferenceCandidates(item.Source, directory)
			if (err == nil) != want {
				t.Fatalf("acceptance = %v, want %v: %v", err == nil, want, err)
			}
			if !want {
				return
			}
			for _, path := range item.Lookups {
				if !slices.Contains(paths.PossiblePaths(), path) {
					t.Fatalf("renderer reference %q was missed", path)
				}
			}
		})
	}
}

func TestConservativeReferencesFailClosed(t *testing.T) {
	path := "assets/0123456789abcdef0123456789abcdef.png"
	paths, err := DiscoverKeptReferenceCandidates("before ![]("+path+") after ![]("+path+")", "assets")
	if err != nil || !slices.Equal(paths.PossiblePaths(), []string{path}) {
		t.Fatalf("canonical references: %v %v", paths, err)
	}
	second := "assets/fedcba9876543210fedcba9876543210.jpg"
	paths, err = DiscoverKeptReferenceCandidates("![second]("+second+") ![first]("+path+")", "assets")
	if err != nil || !slices.Equal(paths.PossiblePaths(), []string{path, second}) {
		t.Fatalf("sorted references: %v %v", paths, err)
	}
	for _, source := range []string{"wow!", "![cat *italic*](" + path + ")", "![](assets&#x2f;0123456789abcdef0123456789abcdef.png)", "![](images/0123456789abcdef0123456789abcdef.png)"} {
		if _, err := DiscoverKeptReferenceCandidates(source, "assets"); err == nil {
			t.Fatalf("accepted unsupported source %q", source)
		}
	}
	for _, source := range []string{string([]byte{0xff}), strings.Repeat("x", MaxFrameBytes+1), strings.Repeat("![]("+path+")", MaxKeptInventoryPaths+1)} {
		if paths, err := DiscoverKeptReferenceCandidates(source, "assets"); err == nil || paths.PossiblePaths() != nil {
			t.Fatal("accepted invalid or over-limit input")
		}
	}
	for _, directory := range []string{"", ".", "..", "assets/sub", "日本語", strings.Repeat("a", 256)} {
		if _, err := DiscoverKeptReferenceCandidates("text", directory); err == nil {
			t.Fatalf("accepted unsafe directory %q", directory)
		}
	}
	if _, err := DiscoverKeptReferenceCandidates("text", strings.Repeat("a", 255)); err != nil {
		t.Fatal("rejected maximum-length directory", err)
	}
	copy := paths.PossiblePaths()
	copy[0] = "changed"
	if paths.PossiblePaths()[0] != path {
		t.Fatal("caller changed candidate paths")
	}
}
