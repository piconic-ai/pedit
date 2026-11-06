package doctor

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
)

const relay = "https://edit.piconic.ai"

var testOpts = Options{Version: "v0.6.0", Newer: func(c, l string) bool { return c < l }}

func bundle(version string) string {
	if version == "" {
		return "export{}\n"
	}
	return "/*! @pedit/review " + version + " */\nexport{}\n"
}

func goodPage(scripts string) string {
	return `<!doctype html><meta charset="utf-8"><title>Review</title>` + scripts +
		`<pedit-review relay="` + relay + `"></pedit-review>`
}

const componentTag = `<script type="module" src="/assets/review.js"></script>`

// site is a review page with the headers and files it serves.
type site struct {
	html    string
	csp     string // "" for the policy reviewCSP gives, "-" for none
	headers map[string]string
	files   map[string]string
	extra   http.HandlerFunc // takes any other path first, when set
}

type seen struct {
	mu   sync.Mutex
	reqs []*http.Request
}

func (s *seen) add(r *http.Request) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.reqs = append(s.reqs, r.Clone(r.Context()))
}

func serve(t *testing.T, s site) (string, *seen) {
	t.Helper()
	log := &seen{}
	policy := s.csp
	if policy == "" {
		var err error
		none := "'none'"
		if policy, err = ReviewCSP(relay, &none); err != nil {
			t.Fatal(err)
		}
	}
	mux := http.NewServeMux()
	mux.HandleFunc("/review", func(w http.ResponseWriter, r *http.Request) {
		log.add(r)
		if policy != "-" {
			w.Header().Set("Content-Security-Policy", policy)
		}
		w.Header().Set("Referrer-Policy", "no-referrer")
		for k, v := range s.headers {
			if v == "" {
				w.Header().Del(k)
			} else {
				w.Header().Set(k, v)
			}
		}
		w.Header().Set("Content-Type", "text/html")
		_, _ = w.Write([]byte(s.html))
	})
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		log.add(r)
		if s.extra != nil {
			s.extra(w, r)
			return
		}
		body, ok := s.files[r.URL.Path]
		if !ok {
			http.NotFound(w, r)
			return
		}
		w.Header().Set("Content-Type", "text/javascript")
		_, _ = w.Write([]byte(body))
	})
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)
	return srv.URL, log
}

func good() site {
	return site{html: goodPage(componentTag), files: map[string]string{"/assets/review.js": bundle("0.6.0")}}
}

func run(t *testing.T, raw string) *Report {
	t.Helper()
	u, err := ParseTarget(raw)
	if err != nil {
		t.Fatal(err)
	}
	return Run(u, testOpts)
}

func find(rep *Report, id string) Check {
	for _, c := range rep.Checks {
		if c.ID == id {
			return c
		}
	}
	return Check{Status: "absent"}
}

func status(rep *Report, id string) string {
	for _, c := range rep.Checks {
		if c.ID == id {
			return c.Status
		}
	}
	return "absent"
}

func TestGoodPage(t *testing.T) {
	base, _ := serve(t, good())
	rep := run(t, base+"/review")
	for _, c := range rep.Checks {
		if c.Status != OK {
			t.Errorf("%s: %s %s", c.ID, c.Status, c.Message)
		}
	}
	if len(rep.Checks) != 6 || rep.Failed() || rep.Unreachable {
		t.Fatalf("checks %+v", rep.Checks)
	}
	if rep.Component.Version != "0.6.0" || rep.Component.Src != base+"/assets/review.js" || rep.Relay != relay {
		t.Errorf("component %+v relay %q", rep.Component, rep.Relay)
	}
}

func TestFailures(t *testing.T) {
	policy, _ := ReviewCSP(relay, nil)
	loosen := func(from, to string) string { return strings.Replace(policy, from, to, 1) }
	cases := []struct {
		name string
		edit func(*site)
		id   string
	}{
		{"missing CSP", func(s *site) { s.csp = "-" }, "csp"},
		{"meta CSP only", func(s *site) {
			s.csp = "-"
			s.html = `<meta http-equiv="Content-Security-Policy" content="` + policy + `">` + s.html
		}, "csp"},
		{"extra script-src host", func(s *site) { s.csp = loosen("script-src 'self'", "script-src 'self' https://cdn.example.com") }, "csp"},
		{"connect-src to another relay", func(s *site) { s.csp = loosen("https://edit.piconic.ai wss", "https://other.example wss") }, "csp"},
		{"unsafe-eval", func(s *site) { s.csp = loosen("script-src 'self'", "script-src 'self' 'unsafe-eval'") }, "csp"},
		{"missing base-uri", func(s *site) { s.csp = loosen("; base-uri 'none'", "") }, "csp"},
		{"inline script", func(s *site) { s.html = goodPage(componentTag + `<script>alert(1)</script>`) }, "scripts"},
		{"second external script", func(s *site) {
			s.html = goodPage(componentTag + `<script src="/assets/other.js"></script>`)
			s.files["/assets/other.js"] = "1"
		}, "scripts"},
		{"onclick", func(s *site) { s.html = goodPage(componentTag + `<button onclick="x()">x</button>`) }, "scripts"},
		{"javascript: URL", func(s *site) { s.html = goodPage(componentTag + `<a href=" JaVa&#9;script:x()">x</a>`) }, "scripts"},
		{"component from another origin", func(s *site) {
			s.html = goodPage(`<script type="module" src="https://cdn.example.com/review.js"></script>`)
		}, "scripts"},
		{"no script", func(s *site) { s.html = goodPage("") }, "scripts"},
		{"no element", func(s *site) { s.html = `<title>x</title>` + componentTag }, "element"},
		{"two elements", func(s *site) { s.html = goodPage(componentTag) + `<pedit-review relay="` + relay + `"></pedit-review>` }, "element"},
		{"bad relay", func(s *site) {
			s.html = `<script type="module" src="/assets/review.js"></script><pedit-review relay="https://u:p@x.example"></pedit-review>`
		}, "element"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			s := good()
			c.edit(&s)
			base, _ := serve(t, s)
			rep := run(t, base+"/review")
			if got := status(rep, c.id); got != Fail {
				t.Errorf("%s is %s: %+v", c.id, got, rep.Checks)
			}
			for _, ch := range rep.Checks {
				if ch.Status == Fail && ch.Fix == "" {
					t.Errorf("%s fails without a fix", ch.ID)
				}
			}
		})
	}
}

func TestOtherMarkupWarns(t *testing.T) {
	s := good()
	s.html = goodPage(componentTag + `<iframe src="/x"></iframe>`)
	base, _ := serve(t, s)
	if got := status(run(t, base+"/review"), "scripts"); got != Warn {
		t.Errorf("scripts %s", got)
	}
}

func TestHTTPNotLocal(t *testing.T) {
	u, err := ParseTarget("http://example.com/review")
	if err != nil {
		t.Fatal(err)
	}
	rep := Run(u, testOpts)
	if status(rep, "https") != Fail || rep.Unreachable || len(rep.Checks) != 1 {
		t.Errorf("%+v", rep.Checks)
	}
	for _, bad := range []string{"ftp://example.com/", "example.com/review", "https://user:pw@example.com/"} {
		if _, err := ParseTarget(bad); err == nil {
			t.Errorf("%s accepted", bad)
		}
	}
}

func TestRedirects(t *testing.T) {
	base, _ := serve(t, good())
	// A same-origin redirect passes.
	s := good()
	s.extra = func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/old" {
			http.Redirect(w, r, "/review", http.StatusFound)
			return
		}
		_, _ = w.Write([]byte(bundle("0.6.0")))
	}
	same, _ := serve(t, s)
	if rep := run(t, same+"/old"); rep.Failed() || rep.Unreachable {
		t.Errorf("same-origin redirect: %+v", rep.Checks)
	}
	// One off the origin does not.
	s = good()
	s.extra = func(w http.ResponseWriter, r *http.Request) { http.Redirect(w, r, base+"/review", http.StatusFound) }
	off, _ := serve(t, s)
	rep := run(t, off+"/away")
	if rep.Unreachable || status(rep, "redirect") != Fail || rep.Checks[1].Fix == "" || !rep.Failed() {
		t.Errorf("off-origin redirect: %+v", rep.Checks)
	}
}

func TestSizeLimit(t *testing.T) {
	s := good()
	s.html = goodPage(componentTag) + "<!--" + strings.Repeat("x", pageLimit) + "-->"
	base, _ := serve(t, s)
	rep := run(t, base+"/review")
	if !rep.Unreachable || status(rep, "fetch") != Fail {
		t.Errorf("%+v", rep.Checks)
	}
}

func TestVersion(t *testing.T) {
	cases := map[string]struct{ banner, status string }{
		"older":     {"0.5.0", Warn},
		"no banner": {"", Warn},
		"newer":     {"0.7.0", OK},
	}
	for name, c := range cases {
		s := good()
		s.files["/assets/review.js"] = bundle(c.banner)
		base, _ := serve(t, s)
		rep := run(t, base+"/review")
		if got := status(rep, "version"); got != c.status {
			t.Errorf("%s: %s %+v", name, got, rep.Checks)
		}
		if rep.Component.Src == "" || rep.Component.Version != c.banner {
			t.Errorf("%s: component %+v", name, rep.Component)
		}
	}
	u, _ := ParseTarget(func() string { b, _ := serve(t, good()); return b + "/review" }())
	for _, v := range []string{"dev", "v0.6.1-0.20261106221436-45e6d69a29d2", "v0.7.0-rc.1"} {
		rep := Run(u, Options{Version: v, Newer: testOpts.Newer})
		c := find(rep, "version")
		if c.Status != Warn || !strings.Contains(c.Message, "no release version") {
			t.Errorf("not a release (%s): %+v", v, c)
		}
	}
}

func TestReferrer(t *testing.T) {
	s := good()
	s.headers = map[string]string{"Referrer-Policy": "origin"}
	base, _ := serve(t, s)
	if got := status(run(t, base+"/review"), "referrer"); got != Warn {
		t.Errorf("origin: %s", got)
	}
	s = good()
	s.headers = map[string]string{"Referrer-Policy": ""}
	base, _ = serve(t, s)
	if got := status(run(t, base+"/review"), "referrer"); got != Warn {
		t.Errorf("none: %s", got)
	}
	s.html = `<meta name="referrer" content="no-referrer">` + goodPage(componentTag)
	base, _ = serve(t, s)
	if got := status(run(t, base+"/review"), "referrer"); got != OK {
		t.Errorf("meta: %s", got)
	}
}

func TestFrameAncestors(t *testing.T) {
	policy, _ := ReviewCSP(relay, nil)
	s := good()
	s.csp = policy
	base, _ := serve(t, s)
	if rep := run(t, base+"/review"); status(rep, "csp") != Warn {
		t.Errorf("none: %+v", rep.Checks)
	}
	s.csp = policy + "; frame-ancestors https://cms.example.com"
	base, _ = serve(t, s)
	rep := run(t, base+"/review")
	if status(rep, "csp") != OK || !strings.Contains(rep.Checks[2].Message, "https://cms.example.com") {
		t.Errorf("set: %+v", rep.Checks)
	}
}

// The fragment may carry the key: never sent, never in the report.
func TestFragmentNeverSent(t *testing.T) {
	base, log := serve(t, good())
	rep := run(t, base+"/review#SECRETKEY")
	for _, r := range log.reqs {
		if strings.Contains(r.URL.String(), "SECRET") || strings.Contains(r.RequestURI, "SECRET") {
			t.Errorf("request carries the fragment: %s", r.RequestURI)
		}
	}
	data, _ := json.Marshal(rep)
	if strings.Contains(string(data), "SECRET") || rep.URL != base+"/review" {
		t.Errorf("report: %s", data)
	}
}

// No cookie goes out, even one the server sets, and no Referer, also on a redirect.
func TestNoCookiesNoReferer(t *testing.T) {
	s := good()
	var log *seen
	s.extra = func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/old" {
			http.SetCookie(w, &http.Cookie{Name: "sid", Value: "1"})
			http.Redirect(w, r, "/review", http.StatusFound)
			return
		}
		_, _ = w.Write([]byte(bundle("0.6.0")))
	}
	var base string
	base, log = serve(t, s)
	run(t, base+"/old")
	if len(log.reqs) < 3 {
		t.Fatalf("%d requests", len(log.reqs))
	}
	for _, r := range log.reqs {
		if r.Header.Get("Cookie") != "" || r.Header.Get("Referer") != "" || r.Header.Get("Authorization") != "" {
			t.Errorf("%s sent %v", r.URL.Path, r.Header)
		}
		if r.Header.Get("User-Agent") != "pedit/v0.6.0 doctor" {
			t.Errorf("User-Agent %q", r.Header.Get("User-Agent"))
		}
	}
}

func TestCrossOriginScriptNotFetched(t *testing.T) {
	other, log := serve(t, good())
	s := good()
	s.html = goodPage(`<script type="module" src="` + other + `/assets/review.js"></script>`)
	base, _ := serve(t, s)
	run(t, base+"/review")
	if len(log.reqs) != 0 {
		t.Errorf("another origin was contacted: %d requests", len(log.reqs))
	}
}

func TestBadScriptSrc(t *testing.T) {
	for _, src := range []string{`/assets\\review.js`, ` /assets/review.js`, "/assets/review.js ", "/assets/re&#1;view.js"} {
		s := good()
		s.html = goodPage(`<script type="module" src="` + src + `"></script>`)
		base, _ := serve(t, s)
		rep := run(t, base+"/review")
		if status(rep, "scripts") != Fail || rep.Component.Src != "" {
			t.Errorf("%q: %+v", src, rep.Checks)
		}
	}
}

func TestComponentContentType(t *testing.T) {
	for ct, want := range map[string]string{
		"text/javascript; charset=utf-8": OK,
		"application/javascript":         OK,
		"text/html":                      Fail,
		"":                               Fail,
	} {
		s := good()
		s.files["/assets/review.js"] = bundle("")
		s.extra = func(w http.ResponseWriter, r *http.Request) {
			if ct != "" {
				w.Header().Set("Content-Type", ct)
			} else {
				w.Header()["Content-Type"] = nil
			}
			_, _ = w.Write([]byte(bundle("")))
		}
		base, _ := serve(t, s)
		rep := run(t, base+"/review")
		got := status(rep, "scripts")
		if got != want {
			t.Errorf("%q: scripts %s %+v", ct, got, rep.Checks)
		}
		if want == Fail && rep.Component.Src != "" {
			t.Errorf("%q: taken as the component", ct)
		}
	}
}

func TestNonSemverBannerWarns(t *testing.T) {
	s := good()
	s.files["/assets/review.js"] = bundle("latest")
	base, _ := serve(t, s)
	if got := status(run(t, base+"/review"), "version"); got != Warn {
		t.Errorf("version %s", got)
	}
}

func TestStatusCodes(t *testing.T) {
	for code, fetchFails := range map[int]bool{200: false, 203: false, 404: true, 500: true} {
		s := good()
		s.extra = func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(code) }
		s.html = ""
		base, _ := serve(t, s)
		rep := run(t, base+"/other")
		if got := rep.Unreachable; got != (code != 200 && code != 203) {
			t.Errorf("%d: unreachable %v", code, got)
		}
		if fetchFails && !strings.Contains(rep.Checks[1].Message, "HTTP") {
			t.Errorf("%d: %+v", code, rep.Checks)
		}
	}
}

func TestOriginDefaultPort(t *testing.T) {
	same := [][2]string{{"https://x.example:443/a", "https://X.example/b"}, {"http://x.example:80", "http://x.example"}}
	for _, p := range same {
		a, _ := ParseTarget(p[0])
		b, _ := ParseTarget(p[1])
		if origin(a) != origin(b) {
			t.Errorf("%s != %s", origin(a), origin(b))
		}
	}
	a, _ := ParseTarget("https://x.example:444")
	b, _ := ParseTarget("https://x.example")
	if origin(a) == origin(b) {
		t.Error("other port is the same origin")
	}
}

func TestUpperCaseLocalhost(t *testing.T) {
	u, _ := ParseTarget("http://LOCALHOST:1/review")
	if rep := Run(u, testOpts); !rep.Unreachable {
		t.Errorf("not tried as a development origin: %+v", rep.Checks)
	}
}

func TestParseTargetNeverEchoesFragment(t *testing.T) {
	for _, raw := range []string{"https://x.example/%zz#SECRETKEY", "https://exa mple.com/#SECRETKEY", "ftp://x.example/#SECRETKEY", "x#SECRETKEY"} {
		_, err := ParseTarget(raw)
		if err == nil || strings.Contains(err.Error(), "SECRET") {
			t.Errorf("%q: %v", raw, err)
		}
	}
}
