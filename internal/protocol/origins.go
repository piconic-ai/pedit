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
)

// validOrigin mirrors validOrigin in packages/worker/src/origins.ts: what the
// patterns match and that is also the URL's own origin, so no default port, no
// leading zeros and nothing else a URL parser would write differently.
func validOrigin(origin string) bool {
	var host, port string
	if m := httpsOrigin.FindStringSubmatch(origin); m != nil {
		host, port = m[1], m[2]
		if port == "443" {
			return false
		}
	} else if m := localOrigin.FindStringSubmatch(origin); m != nil {
		port = m[1]
		if port == "80" {
			return false
		}
	} else {
		return false
	}
	if port != "" {
		n, _ := strconv.Atoi(port)
		if n > 65535 || strconv.Itoa(n) != port {
			return false
		}
	}
	// A host whose last label is a number is an IPv4 address, which must be
	// written the way the URL parser writes it back.
	if labels := strings.Split(host, "."); host != "" {
		if last := labels[len(labels)-1]; last != "" && strings.Trim(last, "0123456789") == "" {
			if len(labels) != 4 {
				return false
			}
			for _, l := range labels {
				n, err := strconv.Atoi(l)
				if err != nil || n > 255 || strconv.Itoa(n) != l {
					return false
				}
			}
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
