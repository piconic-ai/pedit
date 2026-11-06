package doctor

import (
	"errors"
	"net"
	"net/url"
	"regexp"
	"slices"
	"strings"
)

// avatarHosts mirrors AVATAR_HOSTS in packages/protocol/src/avatar-hosts.ts.
// packages/testdata/review-csp-vectors.json pins the policy built from it.
var avatarHosts = []string{
	"gravatar.com",
	"www.gravatar.com",
	"secure.gravatar.com",
	"avatars.githubusercontent.com",
	"lh3.googleusercontent.com",
}

// ancestorSource is one source expression of frame-ancestors, as csp.ts
// accepts it: no quote, ';' or ',' beyond the two keywords.
var ancestorSource = regexp.MustCompile(`^(?:'self'|'none'|[A-Za-z0-9*.:/_-]+)$`)

// relayParts is a relay URL broken into what the policy needs.
type relayParts struct {
	Origin string // https://host[:port]
	Socket string // wss://host[:port]
}

// parseRelay accepts what parseRelayUrl in packages/review/src/relay.ts does:
// an http(s) URL without credentials.
func parseRelay(value string) (relayParts, error) {
	u, err := url.Parse(value)
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Hostname() == "" || u.User != nil {
		return relayParts{}, errors.New("relay must be an http(s) URL without credentials")
	}
	host := strings.ToLower(u.Hostname())
	if strings.Contains(host, ":") {
		host = "[" + host + "]"
	}
	if port := u.Port(); port != "" && !(u.Scheme == "https" && port == "443") && !(u.Scheme == "http" && port == "80") {
		host = net.JoinHostPort(strings.Trim(host, "[]"), port)
	}
	socket := "ws"
	if u.Scheme == "https" {
		socket = "wss"
	}
	return relayParts{Origin: u.Scheme + "://" + host, Socket: socket + "://" + host}, nil
}

// ReviewCSP is the Go twin of reviewCSP in packages/review/src/csp.ts: the
// policy a review page for relay must send. frameAncestors, when not nil, adds
// a frame-ancestors directive.
func ReviewCSP(relay string, frameAncestors *string) (string, error) {
	r, err := parseRelay(relay)
	if err != nil {
		return "", err
	}
	avatars := make([]string, len(avatarHosts))
	for i, h := range avatarHosts {
		avatars[i] = "https://" + h
	}
	directives := []string{
		"default-src 'none'",
		"script-src 'self'",
		"style-src 'self' 'unsafe-inline'",
		"img-src 'self' blob: " + strings.Join(avatars, " "),
		"connect-src " + r.Origin + " " + r.Socket,
		"base-uri 'none'",
		"form-action 'none'",
		"object-src 'none'",
	}
	if frameAncestors != nil {
		list := strings.Fields(*frameAncestors)
		if len(list) == 0 {
			return "", errors.New("frameAncestors must be source expressions")
		}
		for _, s := range list {
			if !ancestorSource.MatchString(s) {
				return "", errors.New("frameAncestors must be source expressions")
			}
		}
		directives = append(directives, "frame-ancestors "+strings.Join(list, " "))
	}
	return strings.Join(directives, "; "), nil
}

type directive struct {
	name    string
	sources []string
}

func isCSPSpace(r rune) bool {
	return r == ' ' || r == '\t' || r == '\n' || r == '\f' || r == '\r'
}

// asciiLower lower-cases ASCII letters only, as the CSP spec does.
func asciiLower(s string) string {
	b := []byte(s)
	for i, c := range b {
		if c >= 'A' && c <= 'Z' {
			b[i] = c + 'a' - 'A'
		}
	}
	return string(b)
}

func isASCII(s string) bool {
	for i := 0; i < len(s); i++ {
		if s[i] >= 0x80 {
			return false
		}
	}
	return true
}

// parseCSP reads one policy as the spec does: directives split on ';', tokens
// on ASCII whitespace only (not \v, not Unicode spaces), a name with a
// non-ASCII character skipped. Every directive is kept, also one named twice:
// browsers use the first, but the checks look at all of them.
func parseCSP(policy string) []directive {
	var out []directive
	for part := range strings.SplitSeq(policy, ";") {
		fields := strings.FieldsFunc(part, isCSPSpace)
		if len(fields) == 0 || !isASCII(fields[0]) {
			continue
		}
		d := directive{name: asciiLower(fields[0])}
		for _, f := range fields[1:] {
			d.sources = append(d.sources, asciiLower(f))
		}
		out = append(out, d)
	}
	return out
}

func findDirective(ds []directive, name string) (directive, bool) {
	for _, d := range ds {
		if d.name == name {
			return d, true
		}
	}
	return directive{}, false
}

// extraSources lists the sources of got that want does not allow. 'none'
// allows nothing and 'report-sample' is harmless. When want has 'self', the
// page's own origin is the same thing.
func extraSources(got, want []string, pageOrigin string) []string {
	var extra []string
	for _, s := range got {
		switch {
		case s == "'none'" || s == "'report-sample'" || slices.Contains(want, s):
		case pageOrigin != "" && s == asciiLower(pageOrigin) && slices.Contains(want, "'self'"):
		default:
			extra = append(extra, s)
		}
	}
	return extra
}

// looseDirectives are not in the expected policy, but can let more run or
// load than script-src says.
var looseDirectives = []string{"script-src-elem", "script-src-attr", "worker-src"}

// cspProblems lists what policy allows beyond, or lacks of, the expected one.
// A directive may allow less than expected, never more, in any of its copies.
// pageOrigin (scheme://host[:port], or "") is what 'self' means.
func cspProblems(policy, expected []directive, pageOrigin string) []string {
	var problems []string
	for _, want := range expected {
		problems = append(problems, directiveProblems(policy, want, pageOrigin)...)
	}
	for _, name := range looseDirectives {
		want := directive{name, []string{"'self'", "'none'"}}
		for _, d := range policy {
			if d.name == name {
				problems = append(problems, sourceProblems(d, want, pageOrigin)...)
			}
		}
	}
	return append(problems, evalProblems(policy)...)
}

// directiveProblems checks every copy of want's directive in policy. A missing
// one is a problem, except object-src, which falls back to default-src.
func directiveProblems(policy []directive, want directive, pageOrigin string) []string {
	var problems []string
	found := false
	for _, d := range policy {
		if d.name == want.name {
			found = true
			problems = append(problems, sourceProblems(d, want, pageOrigin)...)
		}
	}
	if !found && !(want.name == "object-src" && defaultIsNone(policy)) {
		problems = append(problems, "no "+want.name+" directive")
	}
	return problems
}

func defaultIsNone(policy []directive) bool {
	d, ok := findDirective(policy, "default-src")
	return ok && len(extraSources(d.sources, nil, "")) == 0
}

func sourceProblems(got, want directive, pageOrigin string) []string {
	if extra := extraSources(got.sources, want.sources, pageOrigin); len(extra) > 0 {
		return []string{want.name + " also allows " + strings.Join(extra, " ")}
	}
	return nil
}

// evalProblems flags 'unsafe-eval' wherever it appears.
func evalProblems(policy []directive) []string {
	var problems []string
	for _, d := range policy {
		if slices.Contains(d.sources, "'unsafe-eval'") {
			problems = append(problems, d.name+" allows 'unsafe-eval'")
		}
	}
	return problems
}
