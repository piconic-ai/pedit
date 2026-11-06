package doctor

import (
	"errors"
	"net/netip"
	"net/url"
	"strconv"
	"strings"

	"golang.org/x/net/idna"
)

// relayParts is a relay URL broken into what the policy needs.
type relayParts struct {
	Origin string // https://host[:port]
	Socket string // wss://host[:port]
}

var errRelay = errors.New("relay must be an http(s) URL without credentials")

// parseRelay reads a relay as `new URL(value)` does in
// packages/review/src/relay.ts, for an http(s) URL without credentials: the
// host as ASCII (IDNA) in lower case, IPv4 in any WHATWG form as dotted
// decimal, IPv6 compressed, the port as a number with the scheme's default
// dropped. packages/testdata/review-csp-vectors.json pins both sides.
func parseRelay(value string) (relayParts, error) {
	value = strings.Trim(value, "\x00\x01\x02\x03\x04\x05\x06\x07\x08\x09\x0a\x0b\x0c\x0d\x0e\x0f\x10\x11\x12\x13\x14\x15\x16\x17\x18\x19\x1a\x1b\x1c\x1d\x1e\x1f ")
	value = strings.NewReplacer("\t", "", "\n", "", "\r", "").Replace(value)
	scheme, rest, ok := strings.Cut(value, ":")
	scheme = strings.ToLower(scheme)
	if !ok || (scheme != "http" && scheme != "https") {
		return relayParts{}, errRelay
	}
	rest = strings.TrimLeft(rest, `/\`)
	if i := strings.IndexAny(rest, `/\?#`); i >= 0 {
		rest = rest[:i]
	}
	host, port, err := splitAuthority(rest)
	if err != nil {
		return relayParts{}, err
	}
	if host, err = canonicalHost(host); err != nil {
		return relayParts{}, err
	}
	n, err := parsePort(port)
	if err != nil {
		return relayParts{}, err
	}
	if n >= 0 && !(scheme == "https" && n == 443) && !(scheme == "http" && n == 80) {
		host += ":" + strconv.Itoa(n)
	}
	socket := "ws"
	if scheme == "https" {
		socket = "wss"
	}
	return relayParts{Origin: scheme + "://" + host, Socket: socket + "://" + host}, nil
}

// splitAuthority drops empty userinfo, refuses credentials, and splits the
// host from the port; an IPv6 host keeps its brackets.
func splitAuthority(auth string) (host, port string, err error) {
	if i := strings.LastIndex(auth, "@"); i >= 0 {
		if user := auth[:i]; user != "" && user != ":" {
			return "", "", errRelay
		}
		auth = auth[i+1:]
	}
	if strings.HasPrefix(auth, "[") {
		end := strings.Index(auth, "]")
		if end < 0 {
			return "", "", errRelay
		}
		host, port = auth[:end+1], auth[end+1:]
		if port != "" && !strings.HasPrefix(port, ":") {
			return "", "", errRelay
		}
		return host, strings.TrimPrefix(port, ":"), nil
	}
	host, port, _ = strings.Cut(auth, ":")
	return host, port, nil
}

// parsePort is -1 for no port. Digits only, at most 65535.
func parsePort(port string) (int, error) {
	if port == "" {
		return -1, nil
	}
	for _, r := range port {
		if r < '0' || r > '9' {
			return 0, errRelay
		}
	}
	n, err := strconv.Atoi(strings.TrimLeft(port, "0") + "0")
	if err != nil || n/10 > 65535 {
		return 0, errRelay
	}
	return n / 10, nil
}

// hostIDNA maps and checks a domain as the URL standard asks (UTS 46,
// non-transitional, no length or hyphen checks, underscores allowed).
var hostIDNA = idna.New(idna.MapForLookup(), idna.BidiRule(), idna.Transitional(false),
	idna.StrictDomainName(false), idna.CheckHyphens(false), idna.VerifyDNSLength(false))

func canonicalHost(host string) (string, error) {
	if strings.HasPrefix(host, "[") {
		return canonicalIPv6(strings.Trim(host, "[]"))
	}
	decoded, err := url.PathUnescape(host)
	if err != nil {
		return "", errRelay
	}
	ascii, err := hostIDNA.ToASCII(decoded)
	if err != nil || ascii == "" || strings.ContainsAny(ascii, " #/:<>?@[\\]^|%") {
		return "", errRelay
	}
	for _, r := range ascii {
		if r < 0x20 || r == 0x7f {
			return "", errRelay
		}
	}
	ascii = strings.ToLower(ascii)
	if endsInNumber(ascii) {
		return canonicalIPv4(ascii)
	}
	return ascii, nil
}

// canonicalIPv6 writes an address as the URL standard does: lower case, the
// longest run of zero pieces (two or more, the first) as "::", no dotted tail.
func canonicalIPv6(s string) (string, error) {
	addr, err := netip.ParseAddr(s)
	if err != nil || !addr.Is6() || addr.Zone() != "" {
		return "", errRelay
	}
	b := addr.As16()
	var pieces [8]uint16
	for i := range pieces {
		pieces[i] = uint16(b[2*i])<<8 | uint16(b[2*i+1])
	}
	start, length := -1, 0
	for i := 0; i < 8; {
		if pieces[i] != 0 {
			i++
			continue
		}
		j := i
		for j < 8 && pieces[j] == 0 {
			j++
		}
		if j-i > length && j-i >= 2 {
			start, length = i, j-i
		}
		i = j
	}
	var sb strings.Builder
	sb.WriteByte('[')
	for i := 0; i < 8; i++ {
		if i == start {
			sb.WriteString("::")
			i += length - 1
			continue
		}
		if sb.Len() > 1 && !strings.HasSuffix(sb.String(), ":") {
			sb.WriteByte(':')
		}
		sb.WriteString(strconv.FormatUint(uint64(pieces[i]), 16))
	}
	sb.WriteByte(']')
	return sb.String(), nil
}

// endsInNumber is the URL standard's test for a host that must be IPv4: its
// last label, a trailing dot aside, is decimal digits or a 0x number.
func endsInNumber(host string) bool {
	parts := strings.Split(host, ".")
	if parts[len(parts)-1] == "" {
		if len(parts) == 1 {
			return false
		}
		parts = parts[:len(parts)-1]
	}
	last := parts[len(parts)-1]
	if last != "" && strings.Trim(last, "0123456789") == "" {
		return true
	}
	_, ok := ipv4Number(last)
	return ok && (strings.HasPrefix(last, "0x") || strings.HasPrefix(last, "0X"))
}

// ipv4Number parses one part: 0x hex, a leading 0 octal, else decimal.
func ipv4Number(s string) (uint64, bool) {
	if s == "" {
		return 0, false
	}
	base := 10
	switch {
	case len(s) >= 2 && (s[:2] == "0x" || s[:2] == "0X"):
		s, base = s[2:], 16
	case len(s) >= 2 && s[0] == '0':
		s, base = s[1:], 8
	}
	if s == "" {
		return 0, true
	}
	n, err := strconv.ParseUint(s, base, 64)
	return n, err == nil
}

func canonicalIPv4(host string) (string, error) {
	parts := strings.Split(host, ".")
	if parts[len(parts)-1] == "" {
		parts = parts[:len(parts)-1]
	}
	if len(parts) > 4 {
		return "", errRelay
	}
	nums := make([]uint64, len(parts))
	for i, p := range parts {
		n, ok := ipv4Number(p)
		if !ok || (i < len(parts)-1 && n > 255) {
			return "", errRelay
		}
		nums[i] = n
	}
	last := len(nums) - 1
	if nums[last] >= 1<<(8*(5-len(nums))) {
		return "", errRelay
	}
	ip := nums[last]
	for i := 0; i < last; i++ {
		ip += nums[i] << (8 * (3 - i))
	}
	return strconv.FormatUint(ip>>24&255, 10) + "." + strconv.FormatUint(ip>>16&255, 10) + "." +
		strconv.FormatUint(ip>>8&255, 10) + "." + strconv.FormatUint(ip&255, 10), nil
}
