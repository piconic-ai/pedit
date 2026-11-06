package doctor

import (
	"encoding/json"
	"os"
	"strings"
	"testing"
)

type cspVectors struct {
	Vectors []struct {
		Relay          string  `json:"relay"`
		FrameAncestors *string `json:"frameAncestors"`
		CSP            string  `json:"csp"`
	} `json:"vectors"`
	Invalid []struct {
		Relay          string  `json:"relay"`
		FrameAncestors *string `json:"frameAncestors"`
	} `json:"invalid"`
}

func loadVectors(t *testing.T) cspVectors {
	t.Helper()
	data, err := os.ReadFile("../../packages/testdata/review-csp-vectors.json")
	if err != nil {
		t.Fatal(err)
	}
	var v cspVectors
	if err := json.Unmarshal(data, &v); err != nil {
		t.Fatal(err)
	}
	if len(v.Vectors) == 0 || len(v.Invalid) == 0 {
		t.Fatal("no vectors")
	}
	return v
}

// The Go policy is the one reviewCSP gives, for every vector.
func TestReviewCSPVectors(t *testing.T) {
	for _, v := range loadVectors(t).Vectors {
		got, err := ReviewCSP(v.Relay, v.FrameAncestors)
		if err != nil {
			t.Errorf("%s: %v", v.Relay, err)
		} else if got != v.CSP {
			t.Errorf("%s:\n got %s\nwant %s", v.Relay, got, v.CSP)
		}
	}
}

func TestReviewCSPInvalid(t *testing.T) {
	for _, v := range loadVectors(t).Invalid {
		if got, err := ReviewCSP(v.Relay, v.FrameAncestors); err == nil {
			t.Errorf("%q %v: accepted as %q", v.Relay, v.FrameAncestors, got)
		}
	}
}

func TestCSPProblems(t *testing.T) {
	want, err := ReviewCSP("https://edit.piconic.ai", nil)
	if err != nil {
		t.Fatal(err)
	}
	expected := parseCSP(want)
	cases := map[string]struct {
		policy string
		ok     bool
	}{
		"exact":                 {want, true},
		"frame-ancestors":       {want + "; frame-ancestors 'none'", true},
		"stricter":              {"default-src 'none'; script-src 'none'; style-src 'self'; img-src 'self'; connect-src https://edit.piconic.ai; base-uri 'none'; form-action 'none'; object-src 'none'", true},
		"extra script host":     {want + "; script-src-elem 'self' https://cdn.example.com", false},
		"unsafe-eval":           {"default-src 'none'; script-src 'self' 'unsafe-eval'; style-src 'self'; img-src 'self'; connect-src https://edit.piconic.ai; base-uri 'none'; form-action 'none'; object-src 'none'", false},
		"missing base-uri":      {"default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src https://edit.piconic.ai; form-action 'none'; object-src 'none'", false},
		"duplicate loose":       {"script-src 'self'; script-src *; " + want, false},
		"vertical tab":          {"default-src 'none'; script-src\v*; style-src 'self'; img-src 'self'; connect-src https://edit.piconic.ai; base-uri 'none'; form-action 'none'; object-src 'none'", false},
		"non-ascii name":        {"script-src 'self'; \u00e9-src *; " + want, true},
		"tab separated":         {"default-src\t'none'; script-src\t'self' *; style-src 'self'; img-src 'self'; connect-src https://edit.piconic.ai; base-uri 'none'; form-action 'none'; object-src 'none'", false},
		"object-src falls back": {"default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src https://edit.piconic.ai; base-uri 'none'; form-action 'none'", true},
		"report-sample":         {"default-src 'none'; script-src 'self' 'report-sample'; style-src 'self'; img-src 'self'; connect-src https://edit.piconic.ai; base-uri 'none'; form-action 'none'", true},
		"other relay":           {"default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src https://evil.example; base-uri 'none'; form-action 'none'; object-src 'none'", false},
	}
	for name, c := range cases {
		if problems := cspProblems(parseCSP(c.policy), expected, ""); (len(problems) == 0) != c.ok {
			t.Errorf("%s: problems %v", name, problems)
		}
	}
}

func TestCSPFetchDirectiveFallbacks(t *testing.T) {
	want, _ := ReviewCSP("https://edit.piconic.ai", nil)
	expected := parseCSP(want)
	for _, extra := range []string{
		"style-src-elem https://evil.example", "child-src https://evil.example", "font-src https://evil.example",
		"frame-src *", "worker-src blob:", "media-src https:", "manifest-src *", "script-src-attr 'unsafe-inline'",
	} {
		if p := cspProblems(parseCSP(want+"; "+extra), expected, ""); len(p) == 0 {
			t.Errorf("%s passes", extra)
		}
	}
	for _, ok := range []string{"font-src 'none'", "worker-src 'self'", "child-src 'none'", "frame-src 'none'", "style-src-elem 'self'", "worker-src 'none'"} {
		if p := cspProblems(parseCSP(want+"; "+ok), expected, ""); len(p) != 0 {
			t.Errorf("%s: %v", ok, p)
		}
	}
}

func TestRelayForms(t *testing.T) {
	for relay, origin := range map[string]string{
		"http://0x.1":                 "http://0.0.0.1",
		"http://1.2.3.0x":             "http://1.2.3.0",
		"http://1.2.3.4.:80":          "http://1.2.3.4",
		"http://2130706433:1":         "http://127.0.0.1:1",
		"http://relay.example:":       "http://relay.example",
		"https://relay.example:65535": "https://relay.example:65535",
		"HTTPS:\\\\Relay.example:443": "https://relay.example",
		"https://@relay.example":      "https://relay.example",
		"https://a_b.example":         "https://a_b.example",
	} {
		got, err := parseRelay(relay)
		if err != nil || got.Origin != origin {
			t.Errorf("%s: %v %v", relay, got, err)
		}
	}
	for _, relay := range []string{"https://relay.example:65536", "http://1.2.3.4.5", "http://08.1", "http://256.1.1.1", "https://u@relay.example", "https://relay.example:80a", "http://[::1", "https:///", "http://a b"} {
		if got, err := parseRelay(relay); err == nil {
			t.Errorf("%s accepted as %v", relay, got)
		}
	}
}

func TestCSPPageOrigin(t *testing.T) {
	expected := parseCSP("script-src 'self'; connect-src https://edit.piconic.ai")
	policy := parseCSP("script-src 'self' https://cms.example.com; connect-src https://edit.piconic.ai https://cms.example.com")
	if p := cspProblems(policy, expected, "https://cms.example.com"); len(p) != 1 || !strings.HasPrefix(p[0], "connect-src") {
		t.Errorf("%v", p)
	}
	if p := cspProblems(policy, expected, ""); len(p) != 2 {
		t.Errorf("%v", p)
	}
}
