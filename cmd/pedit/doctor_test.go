package main

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/piconic-ai/pedit/internal/doctor"
)

func doctorSite(t *testing.T, html string, withCSP bool) string {
	t.Helper()
	policy, err := doctor.ReviewCSP("https://edit.piconic.ai", nil)
	if err != nil {
		t.Fatal(err)
	}
	mux := http.NewServeMux()
	mux.HandleFunc("/review", func(w http.ResponseWriter, r *http.Request) {
		if withCSP {
			w.Header().Set("Content-Security-Policy", policy+"; frame-ancestors 'none'")
		}
		w.Header().Set("Referrer-Policy", "no-referrer")
		_, _ = w.Write([]byte(html))
	})
	mux.HandleFunc("/review.js", func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte("/*! @pedit/review 0.0.1 */\nexport{}\n"))
	})
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)
	return srv.URL
}

const doctorHTML = `<script type="module" src="/review.js"></script><pedit-review relay="https://edit.piconic.ai"></pedit-review>`

func doctorRun(args ...string) (code int, stdout, stderr string) {
	var out, errb bytes.Buffer
	code, _ = runSubcommand(append([]string{"doctor"}, args...), &out, &errb)
	return code, out.String(), errb.String()
}

func TestDoctorTextAndExitCodes(t *testing.T) {
	// The test binary has no release version: the version check warns, nothing fails.
	code, out, _ := doctorRun(doctorSite(t, doctorHTML, true) + "/review#SECRETKEY")
	if code != 0 || strings.Contains(out, "SECRET") || !strings.Contains(out, "✓ csp") || !strings.Contains(out, "! version") {
		t.Errorf("good: %d\n%s", code, out)
	}
	code, out, _ = doctorRun(doctorSite(t, doctorHTML, false) + "/review#SECRETKEY")
	if code != 1 || strings.Contains(out, "SECRET") || !strings.Contains(out, "✗ csp") || !strings.Contains(out, "to fix:") {
		t.Errorf("bad: %d\n%s", code, out)
	}
	if code, out, _ = doctorRun(doctorSite(t, doctorHTML, true) + "/missing"); code != 2 || !strings.Contains(out, "✗ fetch") {
		t.Errorf("unreachable: %d\n%s", code, out)
	}
	for _, args := range [][]string{{}, {"a", "b"}, {"--bogus"}, {"ftp://example.com/"}, {"not a url"}} {
		if code, _, errOut := doctorRun(args...); code != 2 || !strings.Contains(errOut, "Usage: pedit doctor") {
			t.Errorf("%v: %d %q", args, code, errOut)
		}
	}
}

func TestDoctorJSON(t *testing.T) {
	base := doctorSite(t, doctorHTML, false)
	code, out, _ := doctorRun("--json", base+"/review#SECRETKEY")
	if code != 1 || strings.Contains(out, "SECRET") {
		t.Fatalf("%d\n%s", code, out)
	}
	var rep struct {
		URL    string `json:"url"`
		Checks []struct {
			ID, Status, Message string
			Fix                 string
		} `json:"checks"`
		Component struct{ Src, Version string } `json:"component"`
		Relay     string                        `json:"relay"`
	}
	if err := json.Unmarshal([]byte(out), &rep); err != nil {
		t.Fatal(err)
	}
	ids := []string{}
	for _, c := range rep.Checks {
		ids = append(ids, c.ID)
	}
	if strings.Join(ids, ",") != "https,element,csp,scripts,version,referrer" {
		t.Errorf("ids %v", ids)
	}
	if rep.URL != base+"/review" || rep.Relay != "https://edit.piconic.ai" || rep.Component.Version != "0.0.1" || rep.Component.Src != base+"/review.js" {
		t.Errorf("%+v", rep)
	}
}

func TestDoctorInUsage(t *testing.T) {
	if !strings.Contains(usage, "pedit doctor <url>") {
		t.Error("doctor is not in the help")
	}
}

func TestDoctorNeverEchoesFragment(t *testing.T) {
	for _, args := range [][]string{
		{"https://x.example/%zz#SECRETKEY"},
		{"https://exa mple.com/#SECRETKEY"},
		{"https://x.example/a", "https://x.example/b#SECRETKEY"},
		{"--bogus#SECRETKEY"},
		{"--json", "ftp://x.example/#SECRETKEY"},
	} {
		code, out, errOut := doctorRun(args...)
		if code != 2 || strings.Contains(out+errOut, "SECRET") {
			t.Errorf("%v: %d %q %q", args, code, out, errOut)
		}
	}
}

func TestDoctorStripsControlCharacters(t *testing.T) {
	mux := http.NewServeMux()
	policy, _ := doctor.ReviewCSP("https://edit.piconic.ai", nil)
	mux.HandleFunc("/review", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Security-Policy", policy+"; frame-ancestors 'none'")
		_, _ = w.Write([]byte(doctorHTML))
	})
	mux.HandleFunc("/review.js", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/javascript")
		_, _ = w.Write([]byte("/*! @pedit/review 1.0.0\x1b[31mRED */\nexport{}\n"))
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()
	_, out, _ := doctorRun(srv.URL + "/review")
	if strings.Contains(out, "\x1b") || !strings.Contains(out, "! version") {
		t.Errorf("%q", out)
	}
	_, js, _ := doctorRun("--json", srv.URL+"/review")
	if !strings.Contains(js, `\u001b`) {
		t.Errorf("JSON is not escaped: %s", js)
	}
}

func TestDoctorRedirectOffOriginExitsOne(t *testing.T) {
	other := doctorSite(t, doctorHTML, true)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, other+"/review", http.StatusFound)
	}))
	defer srv.Close()
	if code, out, _ := doctorRun(srv.URL + "/x"); code != 1 || !strings.Contains(out, "✗ redirect") || !strings.Contains(out, "to fix:") {
		t.Errorf("%d\n%s", code, out)
	}
}
