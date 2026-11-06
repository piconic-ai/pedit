package doctor

import (
	"io"
	"strings"

	"golang.org/x/net/html"
)

type script struct {
	Src    string // as written; empty for an inline script
	Inline bool
	Type   string
}

// page is what the checks need from the HTML of a review page.
type page struct {
	Elements     []string // the relay attribute of each <pedit-review>
	Scripts      []script
	Handlers     []string // "onclick on <button>"
	JSURLs       []string // "href on <a>"
	MetaCSP      []string
	MetaReferrer []string
	Other        []string // <base>, <iframe>, <object>, <embed>, <form action>
}

func parsePage(r io.Reader) (*page, error) {
	doc, err := html.Parse(r)
	if err != nil {
		return nil, err
	}
	p := &page{}
	p.visit(doc)
	return p, nil
}

func (p *page) visit(n *html.Node) {
	if n.Type == html.ElementNode {
		p.element(n)
	}
	for c := n.FirstChild; c != nil; c = c.NextSibling {
		p.visit(c)
	}
}

func attr(n *html.Node, key string) (string, bool) {
	for _, a := range n.Attr {
		if a.Key == key {
			return a.Val, true
		}
	}
	return "", false
}

func (p *page) element(n *html.Node) {
	switch n.Data {
	case "pedit-review":
		relay, _ := attr(n, "relay")
		p.Elements = append(p.Elements, relay)
	case "script":
		p.addScript(n)
	case "meta":
		p.addMeta(n)
	case "base", "iframe", "object", "embed":
		p.Other = append(p.Other, "<"+n.Data+">")
	case "form":
		if _, ok := attr(n, "action"); ok {
			p.Other = append(p.Other, "<form action>")
		}
	}
	p.scanAttrs(n)
}

// dataTypes are script types a browser never runs.
func isDataScript(typ string) bool {
	typ = strings.ToLower(strings.TrimSpace(typ))
	return strings.Contains(typ, "json") || typ == "speculationrules"
}

func (p *page) addScript(n *html.Node) {
	typ, _ := attr(n, "type")
	if isDataScript(typ) {
		return
	}
	src, ext := attr(n, "src")
	p.Scripts = append(p.Scripts, script{Src: src, Inline: !ext, Type: strings.ToLower(strings.TrimSpace(typ))})
}

func (p *page) addMeta(n *html.Node) {
	content, _ := attr(n, "content")
	if equiv, _ := attr(n, "http-equiv"); strings.EqualFold(equiv, "content-security-policy") {
		p.MetaCSP = append(p.MetaCSP, content)
	}
	if name, _ := attr(n, "name"); strings.EqualFold(name, "referrer") {
		p.MetaReferrer = append(p.MetaReferrer, strings.ToLower(strings.TrimSpace(content)))
	}
}

// scanAttrs notes inline event handlers and javascript: URLs.
func (p *page) scanAttrs(n *html.Node) {
	for _, a := range n.Attr {
		switch {
		case strings.HasPrefix(a.Key, "on"):
			p.Handlers = append(p.Handlers, a.Key+" on <"+n.Data+">")
		case a.Key == "href" || a.Key == "src" || a.Key == "action" || a.Key == "formaction":
			if isJavascriptURL(a.Val) {
				p.JSURLs = append(p.JSURLs, a.Key+" on <"+n.Data+">")
			}
		}
	}
}

// isJavascriptURL ignores the leading space and control characters, and the
// tabs and newlines inside the scheme, that browsers drop.
func isJavascriptURL(v string) bool {
	v = strings.Map(func(r rune) rune {
		if r == '\t' || r == '\n' || r == '\r' {
			return -1
		}
		return r
	}, strings.TrimLeft(v, "\x00\x01\x02\x03\x04\x05\x06\x07\x08\x09\x0a\x0b\x0c\x0d\x0e\x0f\x10\x11\x12\x13\x14\x15\x16\x17\x18\x19\x1a\x1b\x1c\x1d\x1e\x1f "))
	return strings.HasPrefix(strings.ToLower(v), "javascript:")
}
