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

// parseCSP reads one policy. A directive named twice counts once, the first,
// as browsers do. Names and sources are lower-cased.
func parseCSP(policy string) []directive {
	var out []directive
	seen := map[string]bool{}
	for part := range strings.SplitSeq(policy, ";") {
		fields := strings.Fields(strings.ToLower(part))
		if len(fields) == 0 || seen[fields[0]] {
			continue
		}
		seen[fields[0]] = true
		out = append(out, directive{fields[0], fields[1:]})
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

// extraSources lists the sources of got that want does not have.
func extraSources(got, want []string) []string {
	var extra []string
	for _, s := range got {
		// 'none' allows nothing: it is never more than expected.
		if s != "'none'" && !slices.Contains(want, s) {
			extra = append(extra, s)
		}
	}
	return extra
}

// looseDirectives are not in the expected policy, but can let more run or
// load than script-src says.
var looseDirectives = []string{"script-src-elem", "script-src-attr", "worker-src"}

// cspProblems lists what policy allows beyond, or lacks of, the expected one.
// A directive may allow less than expected, never more.
func cspProblems(policy, expected []directive) []string {
	var problems []string
	for _, want := range expected {
		got, ok := findDirective(policy, want.name)
		if !ok {
			problems = append(problems, "no "+want.name+" directive")
			continue
		}
		if extra := extraSources(got.sources, want.sources); len(extra) > 0 {
			problems = append(problems, want.name+" also allows "+strings.Join(extra, " "))
		}
	}
	for _, name := range looseDirectives {
		if got, ok := findDirective(policy, name); ok {
			if extra := extraSources(got.sources, []string{"'self'", "'none'"}); len(extra) > 0 {
				problems = append(problems, name+" allows "+strings.Join(extra, " "))
			}
		}
	}
	return append(problems, evalProblems(policy)...)
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
