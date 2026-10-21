package meta_test

import (
	"errors"
	"strconv"
	"strings"
	"testing"

	"github.com/piconic-ai/pedit/internal/meta"
)

const sample = `{
  "version": 1,
  "path": "docs/spec.md",
  "comments": {
    "c1": {
      "anchor": {
        "type": "text",
        "exact": "world",
        "prefix": "hello ",
        "suffix": "!",
        "offset": 6
      },
      "quote": "world",
      "resolved": false,
      "messages": {
        "m1": {
          "author": "Ada <ada@example.com>",
          "time": "2026-10-21T02:00:00.000Z",
          "body": "Which world?"
        }
      }
    },
    "c2": {
      "anchor": {
        "type": "cells",
        "from": {
          "exact": "banana",
          "prefix": "apple,1,10\n",
          "suffix": ",2",
          "offset": 26
        },
        "to": {
          "exact": "2",
          "prefix": "banana,",
          "suffix": ",20",
          "offset": 33
        }
      },
      "quote": "banana,2",
      "resolved": true,
      "messages": {}
    },
    "c3": {
      "anchor": {
        "type": "node",
        "id": "n1"
      },
      "quote": "Ideas",
      "resolved": false,
      "messages": {}
    }
  },
  "suggestions": {"s1":[1,2]}
}
`

func TestRenderWritesBackWhatParseRead(t *testing.T) {
	f, err := meta.Parse([]byte(sample))
	if err != nil {
		t.Fatal(err)
	}
	if f.Path != "docs/spec.md" || len(f.Comments) != 3 {
		t.Fatalf("read %+v", f)
	}
	c1 := f.Comments["c1"]
	if c1.Anchor.Type != meta.AnchorText || c1.Anchor.Text.Exact != "world" || c1.Anchor.Text.Offset != 6 {
		t.Fatalf("c1 anchor %+v", c1.Anchor)
	}
	if m := c1.Messages["m1"]; m.Author != "Ada <ada@example.com>" || m.Body != "Which world?" {
		t.Fatalf("c1 message %+v", m)
	}
	if c2 := f.Comments["c2"]; !c2.Resolved || c2.Anchor.From.Exact != "banana" || c2.Anchor.To.Exact != "2" {
		t.Fatalf("c2 %+v", c2)
	}
	if c3 := f.Comments["c3"]; c3.Anchor.ID != "n1" {
		t.Fatalf("c3 %+v", c3)
	}
	// The same bytes: keys in order, the unknown "suggestions" kept, and no
	// HTML escaping of the author's angle brackets.
	out, err := meta.Render(f)
	if err != nil {
		t.Fatal(err)
	}
	if string(out) != sample {
		t.Fatalf("render:\n%s\nwant:\n%s", out, sample)
	}
}

func TestRenderANewFile(t *testing.T) {
	out, err := meta.Render(&meta.File{Path: "notes.md"})
	if err != nil {
		t.Fatal(err)
	}
	want := "{\n  \"version\": 1,\n  \"path\": \"notes.md\",\n  \"comments\": {}\n}\n"
	if string(out) != want {
		t.Fatalf("render %q, want %q", out, want)
	}
	if _, err := meta.Parse(out); err != nil {
		t.Fatalf("parse what Render wrote: %v", err)
	}
}

func TestParseRefusesAFileThatBreaksARule(t *testing.T) {
	thread := func(body string) string {
		return `{"version":1,"path":"a.md","comments":{"c1":` + body + `}}`
	}
	anchor := func(a string) string {
		return thread(`{"anchor":` + a + `,"quote":"","resolved":false,"messages":{}}`)
	}
	message := func(id, m string) string {
		return thread(`{"anchor":{"type":"node","id":"n"},"quote":"","resolved":false,"messages":{"` + id + `":` + m + `}}`)
	}
	okMessage := `{"author":"a","time":"2026-10-21T00:00:00Z","body":"b"}`
	if _, err := meta.Parse([]byte(message("m1", okMessage))); err != nil {
		t.Fatalf("a valid file: %v", err)
	}
	many := func(n int, item func(i int) string) string {
		parts := make([]string, n)
		for i := range parts {
			parts[i] = item(i)
		}
		return strings.Join(parts, ",")
	}
	for name, data := range map[string]string{
		"not JSON":                  `{"version":1,`,
		"not an object":             `[1]`,
		"null":                      `null`,
		"trailing data":             `{"version":1,"path":"a.md"} {}`,
		"trailing brace":            `{"version":1,"path":"a.md"}}`,
		"trailing bracket":          `{"version":1,"path":"a.md"}]`,
		"no version":                `{"path":"a.md"}`,
		"version zero":              `{"version":0,"path":"a.md"}`,
		"version not a number":      `{"version":"1","path":"a.md"}`,
		"no path":                   `{"version":1}`,
		"unsafe path":               `{"version":1,"path":"../a.md"}`,
		"comments not a map":        `{"version":1,"path":"a.md","comments":[]}`,
		"thread id":                 `{"version":1,"path":"a.md","comments":{"bad id":{"anchor":{"type":"node","id":"n"},"quote":"","resolved":false,"messages":{}}}}`,
		"unknown thread key":        thread(`{"anchor":{"type":"node","id":"n"},"quote":"","resolved":false,"messages":{},"colour":"red"}`),
		"unknown anchor":            anchor(`{"type":"edge","id":"e"}`),
		"anchor extra key":          anchor(`{"type":"node","id":"n","exact":"x"}`),
		"empty node id":             anchor(`{"type":"node","id":""}`),
		"long node id":              anchor(`{"type":"node","id":"` + strings.Repeat("n", meta.MaxNodeID+1) + `"}`),
		"cells without to":          anchor(`{"type":"cells","from":{"exact":"a","prefix":"","suffix":"","offset":0}}`),
		"negative offset":           anchor(`{"type":"text","exact":"a","prefix":"","suffix":"","offset":-1}`),
		"long prefix":               anchor(`{"type":"text","exact":"a","prefix":"` + strings.Repeat("p", meta.MaxContext+1) + `","suffix":"","offset":0}`),
		"long quote":                thread(`{"anchor":{"type":"node","id":"n"},"quote":"` + strings.Repeat("q", meta.MaxQuote+1) + `","resolved":false,"messages":{}}`),
		"message id":                message("m 1", okMessage),
		"bad time":                  message("m1", `{"author":"a","time":"yesterday","body":"b"}`),
		"time not in UTC":           message("m1", `{"author":"a","time":"2026-10-21T09:00:00+09:00","body":"b"}`),
		"time with a comma":         message("m1", `{"author":"a","time":"2026-10-21T00:00:00,5Z","body":"b"}`),
		"empty text anchor":         anchor(`{"type":"text","exact":"","prefix":"a","suffix":"b","offset":0}`),
		"cell with nothing to find": anchor(`{"type":"cells","from":{"exact":"","prefix":"","suffix":"","offset":0},"to":{"exact":"a","prefix":"","suffix":"","offset":0}}`),
		// Emoji take two UTF-16 code units each, as in a browser.
		"long prefix in UTF-16":          anchor(`{"type":"text","exact":"a","prefix":"` + strings.Repeat("😀", meta.MaxContext/2+1) + `","suffix":"","offset":0}`),
		"long body":                      message("m1", `{"author":"a","time":"2026-10-21T00:00:00Z","body":"`+strings.Repeat("b", meta.MaxBody+1)+`"}`),
		"long author":                    message("m1", `{"author":"`+strings.Repeat("a", meta.MaxAuthor+1)+`","time":"2026-10-21T00:00:00Z","body":"b"}`),
		"unknown message key":            message("m1", `{"author":"a","time":"2026-10-21T00:00:00Z","body":"b","html":"<b>"}`),
		"a key in another case":          message("m1", `{"author":"a","time":"2026-10-21T00:00:00Z","body":"b","BODY":"other"}`),
		"a type in another case":         anchor(`{"type":"node","id":"n","ID":"m"}`),
		"a thread key in another case":   thread(`{"anchor":{"type":"node","id":"n"},"quote":"","Quote":"x","resolved":false,"messages":{}}`),
		"a selector key in another case": anchor(`{"type":"cells","from":{"exact":"a","prefix":"","suffix":"","offset":0,"Exact":"b"},"to":{"exact":"a","prefix":"","suffix":"","offset":0}}`),
		"nested too deep":                `{"version":1,"path":"a.md","x":` + strings.Repeat("[", 33) + strings.Repeat("]", 33) + `}`,
		"too many messages": thread(`{"anchor":{"type":"node","id":"n"},"quote":"","resolved":false,"messages":{` +
			many(meta.MaxMessages+1, func(i int) string { return `"m` + strconv.Itoa(i) + `":` + okMessage }) + `}}`),
		"too many threads": `{"version":1,"path":"a.md","comments":{` +
			many(meta.MaxThreads+1, func(i int) string {
				return `"c` + strconv.Itoa(i) + `":{"anchor":{"type":"node","id":"n"},"quote":"","resolved":false,"messages":{}}`
			}) + `}}`,
		"too large": `{"version":1,"path":"a.md","pad":"` + strings.Repeat(" ", meta.MaxFileBytes) + `"}`,
	} {
		if _, err := meta.Parse([]byte(data)); err == nil {
			t.Errorf("%s: parsed", name)
		}
	}
}

func TestParseCountsTextInUTF16(t *testing.T) {
	prefix := strings.Repeat("😀", meta.MaxContext/2)
	data := `{"version":1,"path":"a.md","comments":{"c1":{"anchor":{"type":"text","exact":"a","prefix":"` + prefix +
		`","suffix":"","offset":0},"quote":"","resolved":false,"messages":{"m1":{"author":"a","time":"2026-10-21T00:00:00.123Z","body":"b"}}}}}`
	if _, err := meta.Parse([]byte(data)); err != nil {
		t.Fatalf("%d emoji, %d code units: %v", meta.MaxContext/2, meta.MaxContext, err)
	}
	// A cell with no text is found by its neighbours.
	cell := `{"version":1,"path":"a.csv","comments":{"c1":{"anchor":{"type":"cells","from":{"exact":"","prefix":"a,","suffix":",b","offset":2},"to":{"exact":"","prefix":"a,","suffix":",b","offset":2}},"quote":"","resolved":false,"messages":{}}}}`
	if _, err := meta.Parse([]byte(cell)); err != nil {
		t.Fatalf("an empty cell: %v", err)
	}
}

func TestRenderRefusesWhatParseWouldRefuse(t *testing.T) {
	// A text anchor without its selector would read back as another anchor.
	broken := &meta.File{Path: "a.md", Comments: map[string]meta.Thread{"c1": {Anchor: meta.Anchor{Type: meta.AnchorText}}}}
	if _, err := meta.Render(broken); err == nil {
		t.Fatal("rendered a text anchor without its selector")
	}
	// Every limit kept, yet too large together: 500 threads of 200 messages.
	big := &meta.File{Path: "a.md", Comments: map[string]meta.Thread{}}
	for i := range meta.MaxThreads {
		messages := map[string]meta.Message{}
		for j := range 3 {
			messages["m"+strconv.Itoa(j)] = meta.Message{Author: "a", Time: "2026-10-21T00:00:00Z", Body: strings.Repeat("b", meta.MaxBody)}
		}
		big.Comments["c"+strconv.Itoa(i)] = meta.Thread{Anchor: meta.Anchor{Type: meta.AnchorNode, ID: "n"}, Messages: messages}
	}
	if _, err := meta.Render(big); err == nil {
		t.Fatal("rendered a file larger than MaxFileBytes")
	}
}

func TestParseTellsANewerVersionApart(t *testing.T) {
	_, err := meta.Parse([]byte(`{"version":2,"path":"a.md","comments":{"x":"anything"}}`))
	if !errors.Is(err, meta.ErrVersion) {
		t.Fatalf("version 2: %v", err)
	}
}

func TestRenderWritesANewerPeditsKeysAsTheyAre(t *testing.T) {
	// Nested as deep as Parse allows, many times over: indenting it again
	// would write far more than was read.
	deep := strings.Repeat("[", 31) + strings.Repeat("]", 31)
	var keys []string
	for i := range 1000 {
		keys = append(keys, `"k`+strconv.Itoa(i)+`":`+deep)
	}
	data := `{"version":1,"path":"a.md",` + strings.Join(keys, ",") + `}`
	f, err := meta.Parse([]byte(data))
	if err != nil {
		t.Fatal(err)
	}
	out, err := meta.Render(f)
	if err != nil || len(out) > 2*len(data) {
		t.Fatalf("rendered %d bytes from %d, %v", len(out), len(data), err)
	}
}
