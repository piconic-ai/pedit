// Package doctor checks a review page: the page an integrator serves with the
// @pedit/review component (docs/design/embedding.md). It never opens a room,
// sends no cookies or Referer, and contacts only the page's origin.
package doctor

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"mime"
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"time"
	"unicode"
)

const (
	OK   = "ok"
	Warn = "warn"
	Fail = "fail"
)

// Check is one result. Fix says what to do, for a warning or a failure.
type Check struct {
	ID      string `json:"id"`
	Status  string `json:"status"`
	Message string `json:"message"`
	Fix     string `json:"fix,omitempty"`
}

// Component is the script that holds the review component.
type Component struct {
	Src     string `json:"src,omitempty"`
	Version string `json:"version,omitempty"`
}

// Report is the result of Run. URL has no fragment.
type Report struct {
	URL       string    `json:"url"`
	Checks    []Check   `json:"checks"`
	Component Component `json:"component"`
	Relay     string    `json:"relay"`
	// Unreachable is set when the page could not be fetched.
	Unreachable bool `json:"-"`
}

// Failed reports whether any check failed.
func (r *Report) Failed() bool {
	for _, c := range r.Checks {
		if c.Status == Fail {
			return true
		}
	}
	return false
}

// Options configure Run.
type Options struct {
	// Version is this pedit's version, such as v0.6.0, or "dev".
	Version string
	// Newer reports whether latest is a later version than current, both as vX.Y.Z.
	Newer func(current, latest string) bool
}

// StripFragment drops everything from the first '#': what follows may be a
// key, so no message may repeat it.
func StripFragment(arg string) string {
	before, _, _ := strings.Cut(arg, "#")
	return before
}

// ParseTarget checks the URL given on the command line and drops its
// fragment, which may carry a key: it is never sent and never printed.
func ParseTarget(raw string) (*url.URL, error) {
	raw = StripFragment(raw)
	u, err := url.Parse(raw)
	if err != nil {
		return nil, errors.New("not a URL: " + raw)
	}
	switch {
	case u.Scheme == "" || u.Host == "":
		return nil, errors.New("not an absolute http(s) URL")
	case u.Scheme != "http" && u.Scheme != "https":
		return nil, fmt.Errorf("unsupported scheme %q: a review page is served over https", u.Scheme)
	case u.User != nil:
		return nil, errors.New("the URL must not carry credentials")
	}
	return u, nil
}

func ok(id, msg string) Check { return Check{ID: id, Status: OK, Message: msg} }

// runLimit caps the whole run: the page and every script it fetches.
const runLimit = 30 * time.Second

// Run fetches the page at u (from ParseTarget) and checks it.
func Run(u *url.URL, opts Options) *Report {
	rep := &Report{URL: u.String()}
	if u.Scheme == "http" && !isLocalHost(strings.ToLower(u.Hostname())) {
		rep.Checks = append(rep.Checks, Check{ID: "https", Status: Fail,
			Message: "the page is served over http, which is only for development on localhost",
			Fix:     "serve the page over https: the key in the link is only as safe as the connection that carries the page"})
		return rep
	}
	rep.Checks = append(rep.Checks, ok("https", httpsMessage(u)))
	ctx, cancel := context.WithTimeout(context.Background(), runLimit)
	defer cancel()
	client := newClient()
	resp, err := fetch(ctx, client, u, pageLimit, opts.Version)
	if err != nil {
		rep.Unreachable = !errors.Is(err, errOffOrigin)
		rep.Checks = append(rep.Checks, fetchFailure(err))
		return rep
	}
	pg, err := parsePage(bytes.NewReader(resp.Body))
	if err != nil {
		rep.Unreachable = true
		rep.Checks = append(rep.Checks, Check{ID: "fetch", Status: Fail, Message: "could not read the page: " + err.Error()})
		return rep
	}
	elem, relay := checkElement(pg)
	rep.Relay = relay
	comp := findComponent(ctx, client, resp.URL, pg, opts)
	rep.Component = Component{Src: comp.src, Version: comp.version}
	rep.Checks = append(rep.Checks, elem,
		checkCSP(resp.Header, pg, relay, origin(resp.URL)),
		checkScripts(resp.URL, pg, comp),
		checkVersion(comp, opts),
		checkReferrer(resp.Header, pg))
	return rep
}

// fetchFailure is the check for a page that could not be fetched. A redirect
// off the origin is the page's fault, so it is a failed check of its own
// ("redirect", exit 1), not a fetch error.
func fetchFailure(err error) Check {
	if errors.Is(err, errOffOrigin) {
		return Check{ID: "redirect", Status: Fail, Message: "the page redirects to another origin",
			Fix: "serve the review page at the URL you share, on one origin: doctor follows redirects within the origin only, and a review page never belongs to two"}
	}
	return Check{ID: "fetch", Status: Fail, Message: "could not fetch the page: " + err.Error()}
}

func httpsMessage(u *url.URL) string {
	if u.Scheme == "https" {
		return "served over https"
	}
	return "served over http from " + u.Hostname() + " (development)"
}

// checkElement wants one <pedit-review> with a valid relay, and returns that relay.
func checkElement(pg *page) (Check, string) {
	switch len(pg.Elements) {
	case 0:
		return Check{ID: "element", Status: Fail, Message: "no <pedit-review> element on the page",
			Fix: `add <pedit-review relay="https://edit.piconic.ai"></pedit-review>`}, ""
	case 1:
	default:
		return Check{ID: "element", Status: Fail,
			Message: fmt.Sprintf("%d <pedit-review> elements on the page; expected one", len(pg.Elements)),
			Fix:     "keep one <pedit-review> on the page"}, pg.Elements[0]
	}
	relay := pg.Elements[0]
	if _, err := parseRelay(relay); err != nil {
		return Check{ID: "element", Status: Fail, Message: "the relay attribute is not a valid relay: " + err.Error(),
			Fix: "set relay to the http(s) URL of your relay, without credentials"}, relay
	}
	return ok("element", "one <pedit-review>, relay "+relay), relay
}

func checkCSP(h http.Header, pg *page, relay, pageOrigin string) Check {
	policies := splitPolicies(h.Values("Content-Security-Policy"))
	if len(policies) == 0 {
		// No header, or one with no policy in it (such as ","): none is enforced.
		fix := "send the Content-Security-Policy that reviewCSP({ relay }) from @pedit/review gives, as a response header"
		if len(pg.MetaCSP) > 0 {
			return Check{ID: "csp", Status: Fail, Message: "the policy is in a <meta> tag only; send it as a response header", Fix: fix}
		}
		return Check{ID: "csp", Status: Fail, Message: "no Content-Security-Policy response header", Fix: fix}
	}
	expectedText, err := ReviewCSP(relay, nil)
	if err != nil {
		return Check{ID: "csp", Status: Fail, Message: "cannot be compared with the expected policy: no valid relay",
			Fix: "fix the <pedit-review> element first"}
	}
	problems, best := bestPolicy(policies, parseCSP(expectedText), pageOrigin)
	if len(problems) > 0 {
		return Check{ID: "csp", Status: Fail, Message: "the policy is looser than reviewCSP's: " + strings.Join(problems, "; "),
			Fix: "send exactly this policy (plus a frame-ancestors of your choice): " + expectedText}
	}
	return frameAncestorsResult(policies, best, pg)
}

// splitPolicies splits header values into policies: several may be joined by
// commas, and every one is enforced.
func splitPolicies(values []string) [][]directive {
	var out [][]directive
	for _, v := range values {
		for p := range strings.SplitSeq(v, ",") {
			if strings.TrimSpace(p) != "" {
				out = append(out, parseCSP(p))
			}
		}
	}
	return out
}

// bestPolicy returns no problems when one enforced policy is as strict as the
// expected one (the others can only restrict more), else the first one's.
func bestPolicy(policies [][]directive, expected []directive, pageOrigin string) ([]string, []directive) {
	var first []string
	for i, p := range policies {
		problems := cspProblems(p, expected, pageOrigin)
		if len(problems) == 0 {
			return nil, p
		}
		if i == 0 {
			first = problems
		}
	}
	return first, nil
}

// frameAncestorsResult is the choice of the integrator: shown, and a warning
// when there is none.
func frameAncestorsResult(policies [][]directive, best []directive, pg *page) Check {
	var fa []string
	found := false
	for _, p := range append([][]directive{best}, policies...) {
		if d, has := findDirective(p, "frame-ancestors"); has {
			fa, found = d.sources, true
			break
		}
	}
	metaFA := false
	for _, m := range pg.MetaCSP {
		metaFA = metaFA || strings.Contains(strings.ToLower(m), "frame-ancestors")
	}
	switch {
	case !found && metaFA:
		return Check{ID: "csp", Status: Warn, Message: "policy matches reviewCSP's, but frame-ancestors is in a <meta> tag, which browsers ignore",
			Fix: "send frame-ancestors in the response header, to say who may frame the page (clickjacking)"}
	case !found:
		return Check{ID: "csp", Status: Warn, Message: "policy matches reviewCSP's, but has no frame-ancestors",
			Fix: "add frame-ancestors 'none' (or the origins that may frame the page): without it anyone can frame the page (clickjacking)"}
	}
	return ok("csp", "policy matches reviewCSP's; frame-ancestors "+strings.Join(fa, " "))
}

type component struct {
	src     string // resolved
	version string
	cross   bool // loaded from another origin
}

var semverRe = regexp.MustCompile(`^v?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$`)

// releaseRe is a released pedit's version: a tag, not a dev build's pseudo-version
// (v0.6.1-0.20261106221436-45e6d69a29d2) or a local build.
var releaseRe = regexp.MustCompile(`^v\d+\.\d+\.\d+$`)

var banner = regexp.MustCompile(`^(?:\xef\xbb\xbf)?/\*! @pedit/review (\S+) \*/`)

const maxScriptFetches = 8

// scriptURLs resolves the external scripts against base: those of the page's
// origin, and the first of another origin.
func scriptURLs(base *url.URL, pg *page) (same []*url.URL, cross *url.URL) {
	for _, s := range pg.Scripts {
		u, err := base.Parse(s.Src)
		if s.Inline || badSrc(s.Src) || err != nil || u.User != nil || (u.Scheme != "http" && u.Scheme != "https") {
			continue
		}
		switch {
		case origin(u) == origin(base):
			same = append(same, u)
		case cross == nil:
			cross = u
		}
	}
	return same, cross
}

// findComponent finds the script whose first line is the @pedit/review
// banner. Only same-origin scripts are fetched. A page with a single script
// has that script as its component, banner or not.
func findComponent(ctx context.Context, client *http.Client, base *url.URL, pg *page, opts Options) component {
	same, cross := scriptURLs(base, pg)
	for _, u := range same[:min(len(same), maxScriptFetches)] {
		resp, err := fetch(ctx, client, u, scriptLimit, opts.Version)
		if err != nil {
			continue
		}
		// Browsers refuse a module script by its MIME type, banner or not.
		if !isJavaScript(resp.Header.Get("Content-Type")) {
			continue
		}
		if m := banner.FindSubmatch(firstLine(resp.Body)); m != nil {
			return component{src: u.String(), version: string(m[1])}
		}
		if len(pg.Scripts) == 1 {
			return component{src: u.String()}
		}
	}
	if len(pg.Scripts) == 1 && cross != nil {
		return component{src: cross.String(), cross: true}
	}
	return component{}
}

// badSrc is a src that browsers and Go may read as different URLs: a
// backslash is a slash to a browser, and whitespace or control characters are
// trimmed or dropped.
func badSrc(src string) bool {
	if strings.TrimSpace(src) != src || strings.Contains(src, "\\") {
		return true
	}
	return strings.IndexFunc(src, unicode.IsControl) >= 0
}

// isJavaScript reports whether a Content-Type names JavaScript, parameters aside.
func isJavaScript(contentType string) bool {
	mt, _, err := mime.ParseMediaType(contentType)
	return err == nil && (mt == "text/javascript" || mt == "application/javascript")
}

func firstLine(b []byte) []byte {
	if i := strings.IndexByte(string(b), '\n'); i >= 0 {
		return b[:i]
	}
	return b
}

func checkScripts(base *url.URL, pg *page, comp component) Check {
	var problems []string
	if comp.cross {
		problems = append(problems, "the component is loaded from another origin ("+comp.src+")")
	}
	if comp.src == "" && !comp.cross && len(pg.Scripts) == 0 {
		problems = append(problems, "no script: the review component is not loaded")
	}
	for _, s := range pg.Scripts {
		if s.Inline {
			problems = append(problems, "an inline script")
		} else if badSrc(s.Src) {
			problems = append(problems, fmt.Sprintf("the script src %q has a backslash, space or control character: browsers read it differently from other tools", s.Src))
		} else if u, err := base.Parse(s.Src); err == nil && u.User != nil {
			problems = append(problems, "a script src carries credentials (user:password@): they are never sent, and a script needs none")
		} else if comp.src == "" || err != nil || u.String() != comp.src {
			problems = append(problems, notComponent(base, s.Src))
		}
	}
	for _, h := range pg.Handlers {
		problems = append(problems, "an inline event handler ("+h+")")
	}
	for _, j := range pg.JSURLs {
		problems = append(problems, "a URL that runs code ("+j+")")
	}
	if len(problems) > 0 {
		return Check{ID: "scripts", Status: Fail, Message: strings.Join(problems, "; "),
			Fix: "put no other script on the page: anything that runs on it can read the key in the link. Serve the component from your own origin"}
	}
	if len(pg.Other) > 0 {
		return Check{ID: "scripts", Status: Warn, Message: "only the component runs, but the page has " + strings.Join(pg.Other, ", "),
			Fix: "remove them: the policy blocks most of what they do, but a review page needs none"}
	}
	return ok("scripts", "the component is the only script")
}

func notComponent(base *url.URL, src string) string {
	if u, err := base.Parse(src); err == nil && origin(u) != origin(base) {
		return "the script " + src + " is loaded from another origin and is not the component"
	}
	return "the script " + src + " is not the component"
}

func checkVersion(comp component, opts Options) Check {
	if comp.version == "" {
		return Check{ID: "version", Status: Warn, Message: "the component's version is unknown: no @pedit/review banner on its first line",
			Fix: "update @pedit/review to a release that carries the banner, and serve its file as it is"}
	}
	if !semverRe.MatchString(comp.version) {
		return Check{ID: "version", Status: Warn, Message: fmt.Sprintf("the component's banner has no version number: %q", comp.version),
			Fix: "serve the file of a @pedit/review release as it is"}
	}
	have, mine := "v"+strings.TrimPrefix(comp.version, "v"), opts.Version
	switch {
	case !releaseRe.MatchString(mine):
		return Check{ID: "version", Status: Warn, Message: "component " + comp.version + "; this pedit has no release version to compare with",
			Fix: "run doctor from a released pedit"}
	case have == mine:
		return ok("version", "component "+comp.version+" is this pedit's version")
	case opts.Newer != nil && opts.Newer(have, mine):
		return Check{ID: "version", Status: Warn, Message: "component " + comp.version + " is older than this pedit " + mine,
			Fix: "update @pedit/review to " + strings.TrimPrefix(mine, "v")}
	}
	return ok("version", "component "+comp.version+" is newer than this pedit "+mine+" (note: update pedit)")
}

// referrerPolicies are the tokens browsers recognise, with the legacy ones.
var referrerPolicies = map[string]bool{
	"no-referrer": true, "no-referrer-when-downgrade": true, "same-origin": true, "origin": true,
	"strict-origin": true, "origin-when-cross-origin": true, "strict-origin-when-cross-origin": true,
	"unsafe-url": true, "never": true, "default": true, "always": true, "origin-when-crossorigin": true,
}

// lastPolicy applies the last recognised token of the comma-separated values
// to policy, and leaves it when there is none.
func lastPolicy(policy string, values ...string) string {
	for _, v := range values {
		for tok := range strings.SplitSeq(v, ",") {
			if tok = strings.ToLower(strings.TrimSpace(tok)); referrerPolicies[tok] {
				policy = tok
			}
		}
	}
	return policy
}

// checkReferrer follows the browser: the response header sets the policy, and
// each <meta name="referrer"> after it overrides that.
func checkReferrer(h http.Header, pg *page) Check {
	fix := "send Referrer-Policy: no-referrer, so the page's URL is never passed on"
	policy := lastPolicy("", h.Values("Referrer-Policy")...)
	for _, m := range pg.MetaReferrer {
		policy = lastPolicy(policy, m)
	}
	switch policy {
	case "no-referrer", "never":
		return ok("referrer", "Referrer-Policy is no-referrer")
	case "":
		return Check{ID: "referrer", Status: Warn, Message: "no Referrer-Policy", Fix: fix}
	}
	return Check{ID: "referrer", Status: Warn, Message: "Referrer-Policy is " + policy + ", not no-referrer", Fix: fix}
}
