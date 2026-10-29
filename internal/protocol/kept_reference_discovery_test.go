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
		"inline": true, "entity slash": false, "escaped slash": false,
		"reference definition": false, "code": true, "escaped marker": true,
		"configured directory": false, "percent slash": false, "external image": false,
		"frontmatter": true, "raw HTML": true, "two references": true,
	}
	for _, item := range cases {
		t.Run(item.Name, func(t *testing.T) {
			want, known := accepted[item.Name]
			if !known {
				t.Fatal("case needs an acceptance expectation")
			}
			paths, err := conservativeKeptReferences(item.Source)
			if (err == nil) != want {
				t.Fatalf("acceptance = %v, want %v: %v", err == nil, want, err)
			}
			if !want {
				return
			}
			for _, path := range item.Lookups {
				if !keptAssetPath.MatchString(path) || !slices.Contains(paths.possible, path) {
					t.Fatalf("renderer reference %q was missed", path)
				}
			}
		})
	}
}

func TestConservativeReferencesFailClosed(t *testing.T) {
	path := "assets/0123456789abcdef0123456789abcdef.png"
	paths, err := conservativeKeptReferences("before ![](" + path + ") after ![](" + path + ")")
	if err != nil || !slices.Equal(paths.possible, []string{path}) {
		t.Fatalf("canonical references: %v %v", paths, err)
	}
	second := "assets/fedcba9876543210fedcba9876543210.jpg"
	paths, err = conservativeKeptReferences("![second](" + second + ") ![first](" + path + ")")
	if err != nil || !slices.Equal(paths.possible, []string{path, second}) {
		t.Fatalf("sorted references: %v %v", paths, err)
	}
	for _, source := range []string{"wow!", "![cat *italic*](" + path + ")", "![](assets&#47;0123456789abcdef0123456789abcdef.png)", "![](images/0123456789abcdef0123456789abcdef.png)"} {
		if _, err := conservativeKeptReferences(source); err == nil {
			t.Fatalf("accepted unsupported source %q", source)
		}
	}
	for _, source := range []string{string([]byte{0xff}), strings.Repeat("x", MaxFrameBytes+1), strings.Repeat("![]("+path+")", MaxKeptInventoryPaths+1)} {
		if paths, err := conservativeKeptReferences(source); err == nil || paths.possible != nil {
			t.Fatal("accepted invalid or over-limit input")
		}
	}
}
