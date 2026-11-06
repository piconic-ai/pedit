package protocol

import (
	"fmt"
	"regexp"
	"strconv"
	"strings"
)

// MaxOrigins is the most origins a room admits. Keep it equal to MAX_ORIGINS
// in packages/worker/src/origins.ts.
const MaxOrigins = 4

var (
	// A DNS name or IPv4 address and an optional port: no wildcards, no userinfo.
	httpsOrigin = regexp.MustCompile(`^https://([a-z0-9.-]+)(?::(\d{1,5}))?$`)
	localOrigin = regexp.MustCompile(`^http://(?:localhost|127\.0\.0\.1):(\d{1,5})$`)
	// What the URL parser takes for a number: decimal digits, or 0x and hex
	// digits (possibly none).
	numericLabel = regexp.MustCompile(`^(?:[0-9]+|0x[0-9a-f]*)$`)
)

// validOrigin mirrors validOrigin in packages/worker/src/origins.ts: what the
// patterns match and that is also the URL's own origin, so no default port, no
// leading zeros and nothing else a URL parser would write differently.
func validOrigin(origin string) bool {
	host, port, ok := originParts(origin)
	return ok && canonicalPort(port) && canonicalHost(host)
}

// originParts splits an origin the patterns match. Port 443 (or 80 for http)
// is the default one, which an origin never spells out.
func originParts(origin string) (host, port string, ok bool) {
	if m := httpsOrigin.FindStringSubmatch(origin); m != nil {
		return m[1], m[2], m[2] != "443"
	}
	if m := localOrigin.FindStringSubmatch(origin); m != nil {
		return "", m[1], m[1] != "80"
	}
	return "", "", false
}

// canonicalPort accepts no port, or one the URL parser writes back as it is.
func canonicalPort(port string) bool {
	if port == "" {
		return true
	}
	n, _ := strconv.Atoi(port)
	return n <= 65535 && strconv.Itoa(n) == port
}

// canonicalHost accepts a name. A host the URL parser reads as an IPv4
// address (its last label, ignoring one trailing dot, is numeric) is accepted
// only as dotted decimal in the form the parser writes back.
func canonicalHost(host string) bool {
	labels := strings.Split(strings.TrimSuffix(host, "."), ".")
	if host == "" || !numericLabel.MatchString(labels[len(labels)-1]) {
		return true
	}
	return len(labels) == 4 && !strings.HasSuffix(host, ".") && allCanonicalOctets(labels)
}

func allCanonicalOctets(labels []string) bool {
	for _, l := range labels {
		n, err := strconv.Atoi(l)
		if err != nil || n > 255 || strconv.Itoa(n) != l {
			return false
		}
	}
	return true
}

// ParseOrigins checks the origins a host asks to admit, as the relay checks
// X-Pedit-Origins: at most MaxOrigins, each exactly `https://host[:port]`, or
// `http://localhost:<port>` or `http://127.0.0.1:<port>`. Duplicates are
// dropped and the order is kept. An empty list admits none.
func ParseOrigins(list []string) ([]string, error) {
	if len(list) > MaxOrigins {
		return nil, fmt.Errorf("at most %d origins", MaxOrigins)
	}
	out := make([]string, 0, len(list))
	seen := map[string]bool{}
	for _, o := range list {
		if !validOrigin(o) {
			return nil, fmt.Errorf("%q is not an allowed origin: use https://host[:port], or http://localhost:<port>", o)
		}
		if !seen[o] {
			seen[o] = true
			out = append(out, o)
		}
	}
	return out, nil
}
