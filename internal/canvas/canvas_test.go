package canvas

import (
	"encoding/json"
	"errors"
	"math"
	"os"
	"reflect"
	"strings"
	"testing"

	"github.com/reearth/ygo/crdt"
)

// obsidianFile is laid out as Obsidian writes canvases: tabs, one item per line.
const obsidianFile = "{\n" +
	"\t\"nodes\":[\n" +
	"\t\t{\"id\":\"a1\",\"type\":\"text\",\"text\":\"Hello\\n\\\"world\\\" <b>\",\"x\":-340,\"y\":-160,\"width\":250,\"height\":60},\n" +
	"\t\t{\"id\":\"b2\",\"type\":\"file\",\"file\":\"notes/b.md\",\"x\":0,\"y\":0,\"width\":400,\"height\":400,\"color\":\"4\"},\n" +
	"\t\t{\"id\":\"c3\",\"type\":\"link\",\"url\":\"https://example.com\",\"x\":0,\"y\":500,\"width\":250.5,\"height\":60},\n" +
	"\t\t{\"id\":\"g4\",\"type\":\"group\",\"label\":\"Group\",\"x\":-400,\"y\":-200,\"width\":900,\"height\":800}\n" +
	"\t],\n" +
	"\t\"edges\":[\n" +
	"\t\t{\"id\":\"e1\",\"fromNode\":\"a1\",\"fromSide\":\"right\",\"toNode\":\"b2\",\"toSide\":\"left\"},\n" +
	"\t\t{\"id\":\"e2\",\"fromNode\":\"b2\",\"fromSide\":\"bottom\",\"toNode\":\"c3\",\"toSide\":\"top\",\"toEnd\":\"none\",\"label\":\"see\"}\n" +
	"\t]\n" +
	"}"

func mustParse(t *testing.T, text string) *File {
	t.Helper()
	f, err := Parse([]byte(text))
	if err != nil {
		t.Fatalf("Parse: %v", err)
	}
	return f
}

func problems(t *testing.T, text string) []Problem {
	t.Helper()
	_, err := Parse([]byte(text))
	var e *Error
	if !errors.As(err, &e) {
		t.Fatalf("Parse(%q) error = %v, want *Error", text, err)
	}
	return e.Problems
}

func TestParseReadsNodesAndEdges(t *testing.T) {
	c := mustParse(t, obsidianFile).Canvas
	if len(c.Nodes) != 4 || len(c.Edges) != 2 {
		t.Fatalf("got %d nodes, %d edges", len(c.Nodes), len(c.Edges))
	}
	want := map[string]any{"id": "a1", "type": "text", "text": "Hello\n\"world\" <b>", "x": int64(-340), "y": int64(-160), "width": int64(250), "height": int64(60)}
	if !reflect.DeepEqual(c.Nodes[0], want) {
		t.Errorf("node 0 = %#v", c.Nodes[0])
	}
	if c.Nodes[2]["width"] != 250.5 {
		t.Errorf("width = %#v, want 250.5", c.Nodes[2]["width"])
	}
	if c.Edges[1]["label"] != "see" {
		t.Errorf("edge 1 = %#v", c.Edges[1])
	}
}

// TestObsidianSample checks a file Obsidian wrote survives the whole trip, and
// that writing its content afresh gives what Obsidian itself wrote.
func TestObsidianSample(t *testing.T) {
	data, err := os.ReadFile("../../packages/testdata/obsidian.canvas")
	if err != nil {
		t.Fatal(err)
	}
	f := mustParse(t, string(data))
	if f.layout != obsidian {
		t.Errorf("layout = %+v, want Obsidian's", f.layout)
	}
	doc := crdt.New()
	Load(doc, f.Canvas)
	c := Read(doc)
	if got := Render(c, f); string(got) != string(data) {
		t.Errorf("round trip through the doc:\n%s", got)
	}
	if got := Render(c, nil); string(got) != string(data) {
		t.Errorf("written afresh:\n%s", got)
	}
}

func TestParseEmpty(t *testing.T) {
	for _, text := range []string{"", " \n", "{}", "{}\n"} {
		f := mustParse(t, text)
		if len(f.Canvas.Nodes) != 0 || len(f.Canvas.Edges) != 0 {
			t.Errorf("%q: %+v", text, f.Canvas)
		}
		// A file with neither list gets both, as Obsidian writes them: the one
		// exception to writing a file back as it was.
		want := "{\n\t\"nodes\":[],\n\t\"edges\":[]\n}"
		if strings.HasSuffix(text, "}\n") {
			want += "\n"
		}
		if got := string(Render(f.Canvas, f)); got != want {
			t.Errorf("%q renders as %q", text, got)
		}
	}
}

func TestRoundTripIsByteIdentical(t *testing.T) {
	var v any
	if err := json.Unmarshal([]byte(obsidianFile), &v); err != nil {
		t.Fatal(err)
	}
	pretty2, _ := json.MarshalIndent(v, "", "  ")
	prettyTab, _ := json.MarshalIndent(v, "", "\t")
	files := map[string]string{
		"obsidian":             obsidianFile,
		"obsidian and newline": obsidianFile + "\n",
		"two spaces":           string(pretty2),
		"tabs":                 string(prettyTab) + "\n",
		"unknown fields": strings.Replace(obsidianFile, `"id":"a1",`,
			`"id":"a1","plugin":{"z":1,"a":[1.50,"x"]},`, 1),
		"extra keys": "{\n\t\"nodes\":[],\n\t\"edges\":[],\n\t\"meta\":{\"v\" : 1}\n}",
		"only nodes": "{\n\t\"nodes\":[]\n}",
	}
	for name, text := range files {
		t.Run(name, func(t *testing.T) {
			f := mustParse(t, text)
			if got := string(Render(f.Canvas, f)); got != text {
				t.Errorf("Render =\n%s\nwant\n%s", got, text)
			}
		})
	}
}

func TestUnknownLayoutIsRewrittenOnceInObsidians(t *testing.T) {
	text := "{ \"nodes\" : [ {\"id\":\"a\", \"type\":\"text\",\"text\":\"\",\"x\":0,\"y\":0,\"width\":1,\"height\":1} ], \"meta\":{\"v\" : 1} }"
	f := mustParse(t, text)
	out := string(Render(f.Canvas, f))
	// Items and values keep their own text; only the skeleton changes.
	want := "{\n\t\"nodes\":[\n\t\t{\"id\":\"a\", \"type\":\"text\",\"text\":\"\",\"x\":0,\"y\":0,\"width\":1,\"height\":1}\n\t],\n\t\"meta\":{\"v\" : 1}\n}"
	if out != want {
		t.Fatalf("got\n%s\nwant\n%s", out, want)
	}
	again := mustParse(t, out)
	if got := string(Render(again.Canvas, again)); got != out {
		t.Errorf("not stable:\n%s", got)
	}
}

// change parses text, lets edit change the canvas, and renders it back.
func change(t *testing.T, text string, edit func(c *Canvas)) string {
	t.Helper()
	f := mustParse(t, text)
	c := f.Canvas
	edit(&c)
	out := Render(c, f)
	if _, err := Parse(out); err != nil {
		t.Fatalf("rendered canvas does not parse: %v\n%s", err, out)
	}
	return string(out)
}

func TestRenderChangesOnlyWhatChanged(t *testing.T) {
	out := change(t, obsidianFile, func(c *Canvas) {
		c.Nodes[1] = clone(c.Nodes[1])
		c.Nodes[1]["x"] = int64(20)
	})
	want := strings.Replace(obsidianFile, `"x":0,"y":0,"width":400`, `"x":20,"y":0,"width":400`, 1)
	if out != want {
		t.Errorf("got\n%s", out)
	}
}

func TestRenderKeepsKeyOrderAndAddsNewKeysInSpecOrder(t *testing.T) {
	text := `{"nodes":[{"x":0,"y":0,"id":"a","width":1,"height":1,"type":"text","text":"t","zz":true}]}`
	out := change(t, text, func(c *Canvas) {
		n := clone(c.Nodes[0])
		n["y"] = int64(5)
		n["color"] = "1"
		n["aa"] = []any{int64(1)}
		c.Nodes[0] = n
	})
	// The skeleton of a file in no known layout is rewritten once, in Obsidian's.
	want := "{\n\t\"nodes\":[\n\t\t{\"x\":0,\"y\":5,\"id\":\"a\",\"width\":1,\"height\":1,\"type\":\"text\",\"text\":\"t\",\"zz\":true,\"color\":\"1\",\"aa\":[1]}\n\t]\n}"
	if out != want {
		t.Errorf("got\n%s\nwant\n%s", out, want)
	}
}

func TestRenderAddsAndRemovesItems(t *testing.T) {
	out := change(t, obsidianFile, func(c *Canvas) {
		c.Nodes = append(c.Nodes[:3:3], map[string]any{"id": "n", "type": "text", "text": "New", "x": int64(1), "y": int64(2), "width": int64(3), "height": int64(4), "color": "2"})
		c.Edges = c.Edges[:1]
	})
	if !strings.Contains(out, "\t\t{\"id\":\"n\",\"type\":\"text\",\"text\":\"New\",\"x\":1,\"y\":2,\"width\":3,\"height\":4,\"color\":\"2\"}\n\t],") {
		t.Errorf("new node not written as Obsidian would:\n%s", out)
	}
	if strings.Contains(out, "g4") || strings.Contains(out, "e2") {
		t.Errorf("removed items remain:\n%s", out)
	}
	if !strings.Contains(out, "\"edges\":[\n\t\t{\"id\":\"e1\"") {
		t.Errorf("edges:\n%s", out)
	}
}

func TestRenderPrettyLayout(t *testing.T) {
	var v any
	_ = json.Unmarshal([]byte(obsidianFile), &v)
	pretty, _ := json.MarshalIndent(v, "", "  ")
	out := change(t, string(pretty), func(c *Canvas) {
		c.Nodes = c.Nodes[:1]
		n := clone(c.Nodes[0])
		n["text"] = "Hi"
		n["meta"] = map[string]any{"k": "v"}
		c.Nodes[0] = n
		c.Edges = nil
	})
	want := `{
  "edges": [],
  "nodes": [
    {
      "height": 60,
      "id": "a1",
      "text": "Hi",
      "type": "text",
      "width": 250,
      "x": -340,
      "y": -160,
      "meta": {
        "k": "v"
      }
    }
  ]
}`
	if out != want {
		t.Errorf("got\n%s\nwant\n%s", out, want)
	}
}

func TestRenderNewFile(t *testing.T) {
	c := Canvas{Nodes: []map[string]any{{"height": int64(1), "width": int64(1), "y": int64(0), "x": int64(0), "text": "a", "type": "text", "id": "n"}}}
	got := string(Render(c, nil))
	want := "{\n\t\"nodes\":[\n\t\t{\"id\":\"n\",\"type\":\"text\",\"text\":\"a\",\"x\":0,\"y\":0,\"width\":1,\"height\":1}\n\t],\n\t\"edges\":[]\n}"
	if got != want {
		t.Errorf("got\n%s\nwant\n%s", got, want)
	}
	f := mustParse(t, "")
	if got := string(Render(c, f)); got != want {
		t.Errorf("from an empty file:\n%s", got)
	}
}

// at returns the line and column of the last occurrence of marker in text.
func at(t *testing.T, text, marker string) (int, int) {
	t.Helper()
	i := strings.LastIndex(text, marker)
	if i < 0 {
		t.Fatalf("%q not in %q", marker, text)
	}
	return position(text, i)
}

func TestProblems(t *testing.T) {
	node := func(fields string) string {
		return `{"nodes":[` + "\n" + `{"id":"a","type":"text","text":"","x":0,"y":0,"width":1,"height":1` + fields + "}]}"
	}
	group := `{"id":"a","type":"group","x":0,"y":0,"width":1,"height":1}`
	tests := []struct {
		name, text string
		// Where the problem is: the last occurrence of this in the text.
		at        string
		path, msg string
	}{
		{"trailing comma", "{\"nodes\":[\n  {\"id\":\"a\"},\n]}", "]}", "", "comma before a closing bracket"},
		{"comment", "{\n// note\n}", "//", "", "does not allow comments"},
		{"comment after a value", "{\n\t\"nodes\":[] // the nodes\n}", "//", "", "does not allow comments"},
		{"comment after an element", "{\"nodes\":[{} # one\n]}", "#", "", "does not allow comments"},
		{"missing comma", "{\"nodes\":[]\n\"edges\":[]}", `"edges"`, "", "comma is probably missing"},
		{"missing comma in a list", "{\"nodes\":[{} {}]}", `{}]`, "", "comma is probably missing"},
		{"missing colon", `{"nodes":[], "meta" "x"}`, `"x"`, "", "colon is probably missing"},
		{"single quotes", "{'nodes':[]}", "'nodes'", "", "double quotes"},
		{"after the end", "{} {}", "{}", "", "after top-level value"},
		{"not an object", "[]", "[]", "", "must be an object, not a list"},
		{"nodes not a list", `{"nodes":{}}`, "{}", "nodes", "must be a list, not an object"},
		{"no id", "{\"nodes\":[\n{\"type\":\"text\",\"text\":\"\",\"x\":0,\"y\":0,\"width\":1,\"height\":1}]}", `{"type"`, "nodes[0]", `has no "id"`},
		{"duplicate key", node(`,"width":2`), `"width"`, `nodes[0] (id "a")`, `"width" appears more than once`},
		{"x as string", strings.Replace(node(""), `"x":0`, `"x":"0"`, 1), `"0"`, `nodes[0] (id "a")`, `"x" must be a number, not a string`},
		{"no height", strings.Replace(node(""), `,"height":1`, ``, 1), `{"id"`, `nodes[0] (id "a")`, `has no "height"`},
		{"text node without text", strings.Replace(node(""), `"text":"",`, ``, 1), `{"id"`, `nodes[0] (id "a")`, `has no "text"`},
		{"url on a text node not a string", node(`,"url":{"__bfMarkup":"<b>"}`), `{"__bfMarkup"`, `nodes[0] (id "a")`, `"url" must be a string, not an object`},
		{"bad background style", strings.Replace(node(`,"backgroundStyle":"tile"`), `"type":"text","text":""`, `"type":"group"`, 1), `"tile"`, `nodes[0] (id "a")`, `"backgroundStyle" is "tile"; it must be one of "cover", "ratio", "repeat"`},
		{"duplicate id", "{\"nodes\":[\n" + group + ",\n" + group + "]}", `"a"`, `nodes[1] (id "a")`, `id "a" is used more than once`},
		{"edge to nowhere", "{\"nodes\":[],\"edges\":[\n{\"id\":\"e\",\"fromNode\":\"a\",\"toNode\":\"b\"}]}", `"a"`, `edges[0] (id "e")`, `"fromNode" is "a", which is not the id of any node`},
		{"bad side", "{\"nodes\":[" + group + "],\"edges\":[\n{\"id\":\"e\",\"fromNode\":\"a\",\"toNode\":\"a\",\"toSide\":\"middle\"}]}", `"middle"`, `edges[0] (id "e")`, `"toSide" is "middle"; it must be one of "top", "right", "bottom", "left"`},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			p := problems(t, tt.text)[0]
			line, col := at(t, tt.text, tt.at)
			if p.Line != line || p.Column != col || p.Path != tt.path || !strings.Contains(p.Message, tt.msg) {
				t.Errorf("got %d:%d %q %q, want %d:%d %q ~%q", p.Line, p.Column, p.Path, p.Message, line, col, tt.path, tt.msg)
			}
		})
	}
}

func TestProblemUnclosedPointsAtTheEnd(t *testing.T) {
	p := problems(t, "{\"nodes\":[")[0]
	if p.Line != 1 || p.Column != 11 || !strings.Contains(p.Message, "ends too early") {
		t.Errorf("got %+v", p)
	}
}

func TestProblemsListsEverythingWithColumnsInCharacters(t *testing.T) {
	text := "{\"nodes\":[\n{\"id\":\"日本\",\"type\":\"text\",\"text\":1,\"x\":0,\"y\":0,\"width\":1},\n{\"id\":\"b\"}\n]}"
	ps := problems(t, text)
	var got []string
	for _, p := range ps {
		got = append(got, p.Message)
	}
	// Node 0 lacks height and has a number for text; node 1 lacks type, x, y, width and height.
	if len(ps) != 7 {
		t.Fatalf("got %d problems: %q", len(ps), got)
	}
	// "text":1 sits after the two-character id: columns count characters, not bytes.
	if p := ps[1]; p.Line != 2 || p.Column != 33 || !strings.Contains(p.Message, `"text" must be a string`) {
		t.Errorf("text problem = %+v", p)
	}
}

func TestProblemsAreCapped(t *testing.T) {
	var b strings.Builder
	b.WriteString(`{"nodes":[`)
	for i := range 30 {
		if i > 0 {
			b.WriteString(",")
		}
		b.WriteString(`{"type":"group","x":0,"y":0,"width":1,"height":1}`)
	}
	b.WriteString("]}")
	_, err := Parse([]byte(b.String()))
	var e *Error
	if !errors.As(err, &e) || len(e.Problems) != maxProblems || e.More != 10 {
		t.Fatalf("got %v", err)
	}
	if !strings.Contains(e.Report("b.canvas"), "and 10 more") {
		t.Error(e.Report("b.canvas"))
	}
}

func TestReport(t *testing.T) {
	_, err := Parse([]byte("{\"nodes\":[\n{\"id\":\"a\",\"type\":\"text\",\"x\":0,\"y\":0,\"width\":1,\"height\":1}]}"))
	var e *Error
	if !errors.As(err, &e) {
		t.Fatal(err)
	}
	want := "board.canvas is not a valid JSON Canvas (https://jsoncanvas.org/spec/1.0/):\n" +
		"  board.canvas:2:1: nodes[0] (id \"a\"): has no \"text\"; add it as a string\n" +
		"Fix the file and run pedit again."
	if got := e.Report("board.canvas"); got != want {
		t.Errorf("got\n%s\nwant\n%s", got, want)
	}
}

func TestErrorLines(t *testing.T) {
	e := &Error{
		Problems: []Problem{
			{Line: 2, Column: 1, Path: `nodes[0] (id "a")`, Message: `has no "text"; add it as a string`},
			{Line: 7, Column: 12, Message: "the JSON ends too early"},
		},
		More: 3,
	}
	want := []string{
		`board.canvas:2:1: nodes[0] (id "a"): has no "text"; add it as a string`,
		"board.canvas:7:12: the JSON ends too early",
		"and 3 more",
	}
	if got := e.Lines("board.canvas"); !reflect.DeepEqual(got, want) {
		t.Errorf("got %q\nwant %q", got, want)
	}
	// Report indents the same lines.
	wantReport := "board.canvas is not a valid JSON Canvas (https://jsoncanvas.org/spec/1.0/):\n" +
		"  " + strings.Join(want, "\n  ") + "\n" +
		"Fix the file and run pedit again."
	if got := e.Report("board.canvas"); got != wantReport {
		t.Errorf("Report:\n%s\nwant\n%s", got, wantReport)
	}

	// Without a name, and when nothing is left out.
	e.More = 0
	want = []string{
		`the file:2:1: nodes[0] (id "a"): has no "text"; add it as a string`,
		"the file:7:12: the JSON ends too early",
	}
	if got := e.Lines(""); !reflect.DeepEqual(got, want) {
		t.Errorf("got %q\nwant %q", got, want)
	}
}

func TestDocRoundTrip(t *testing.T) {
	text := strings.Replace(obsidianFile, `"id":"a1",`, `"id":"a1","plugin":{"k":[1,"two",2.5]},`, 1)
	text = strings.Replace(text, "{\n", "{\n\t\"version\":\"1\",\n", 1)
	f := mustParse(t, text)
	doc := crdt.New()
	Load(doc, f.Canvas)

	got := Read(doc)
	if !equal(toAny(got), toAny(f.Canvas)) {
		t.Fatalf("Read = %#v\nwant %#v", got, f.Canvas)
	}
	if out := string(Render(got, f)); out != text {
		t.Errorf("rendered from the doc:\n%s", out)
	}
	// The text node's text is a Y.Text, so typing into it merges by character.
	m := doc.GetArray(NodesKey).Get(0).(*crdt.YMap)
	v, _ := m.Get(TextKey)
	if _, ok := v.(*crdt.YText); !ok {
		t.Errorf("text is %T, want *crdt.YText", v)
	}
}

func TestReadNormalisesNumbers(t *testing.T) {
	doc := crdt.New()
	nodes := doc.GetArray(NodesKey)
	doc.Transact(func(txn *crdt.Transaction) {
		m := crdt.NewMapPrelim()
		m.Set(txn, "id", "g")
		m.Set(txn, "type", "group")
		m.Set(txn, "x", float32(1.5))
		m.Set(txn, "y", float64(3))
		m.Set(txn, "width", 7)
		m.Set(txn, "height", uint8(2))
		nodes.PushType(txn, m)
	})
	got := Read(doc).Nodes[0]
	want := map[string]any{"id": "g", "type": "group", "x": 1.5, "y": int64(3), "width": int64(7), "height": int64(2)}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("got %#v", got)
	}
}

// TestReadSkipsWhatAFileCannotHold: an edge to a node deleted meanwhile, and
// items a newer or broken peer left incomplete, are not written to the file.
func TestReadSkipsWhatAFileCannotHold(t *testing.T) {
	f := mustParse(t, obsidianFile)
	a := crdt.New()
	Load(a, f.Canvas)
	b := crdt.New()
	if err := crdt.ApplyUpdateV1(b, a.EncodeStateAsUpdate(), nil); err != nil {
		t.Fatal(err)
	}
	sa, sb := a.StateVector(), b.StateVector()
	an := a.GetArray(NodesKey)
	a.Transact(func(txn *crdt.Transaction) { an.Delete(txn, 3, 1) }) // g4
	bn, be := b.GetArray(NodesKey), b.GetArray(EdgesKey)
	b.Transact(func(txn *crdt.Transaction) {
		e := crdt.NewMapPrelim()
		e.Set(txn, "id", "e3")
		e.Set(txn, "fromNode", "a1")
		e.Set(txn, "toNode", "g4")
		be.PushType(txn, e)
		broken := crdt.NewMapPrelim()
		broken.Set(txn, "id", "x9")
		broken.Set(txn, "type", "text")
		bn.PushType(txn, broken)
		dup := crdt.NewMapPrelim()
		for k, v := range f.Canvas.Nodes[1] {
			dup.Set(txn, k, v)
		}
		bn.PushType(txn, dup)
	})
	_ = crdt.ApplyUpdateV1(a, crdt.EncodeStateAsUpdateV1(b, sb), nil)
	_ = crdt.ApplyUpdateV1(b, crdt.EncodeStateAsUpdateV1(a, sa), nil)

	c := Read(a)
	var ids []string
	for _, n := range c.Nodes {
		ids = append(ids, n["id"].(string))
	}
	if !reflect.DeepEqual(ids, []string{"a1", "b2", "c3"}) {
		t.Errorf("nodes = %v", ids)
	}
	for _, e := range c.Edges {
		if e["id"] == "e3" {
			t.Errorf("edge to the deleted node kept")
		}
	}
	if _, err := Parse(Render(c, f)); err != nil {
		t.Errorf("rendered canvas does not parse: %v", err)
	}
}

func clone(m map[string]any) map[string]any {
	out := make(map[string]any, len(m))
	for k, v := range m {
		out[k] = v
	}
	return out
}

func toAny(c Canvas) any {
	nodes := make([]any, len(c.Nodes))
	for i, n := range c.Nodes {
		nodes[i] = n
	}
	edges := make([]any, len(c.Edges))
	for i, e := range c.Edges {
		edges[i] = e
	}
	return map[string]any{"nodes": nodes, "edges": edges, "extra": c.Extra}
}

// TestConcurrentEditsStayValid edits one canvas in two documents at once, the
// cases that broke the JSON when canvases were shared as text.
func TestConcurrentEditsStayValid(t *testing.T) {
	f := mustParse(t, obsidianFile)
	a := crdt.New()
	Load(a, f.Canvas)
	b := crdt.New()
	if err := crdt.ApplyUpdateV1(b, a.EncodeStateAsUpdate(), nil); err != nil {
		t.Fatal(err)
	}
	sa, sb := a.StateVector(), b.StateVector()

	// a moves node a1, types into its text and deletes node b2 with its edges.
	an := a.GetArray(NodesKey)
	ae := a.GetArray(EdgesKey)
	a1 := an.Get(0).(*crdt.YMap)
	at, _ := a1.Get(TextKey)
	a.Transact(func(txn *crdt.Transaction) {
		a1.Set(txn, "x", int64(1))
		at.(*crdt.YText).Insert(txn, 0, "A: ", nil)
		an.Delete(txn, 1, 1)
		ae.Delete(txn, 0, 2)
	})
	// b moves the same node elsewhere, types at the end of its text and edits node b2.
	bn := b.GetArray(NodesKey)
	b1 := bn.Get(0).(*crdt.YMap)
	b2 := bn.Get(1).(*crdt.YMap)
	bt, _ := b1.Get(TextKey)
	b.Transact(func(txn *crdt.Transaction) {
		b1.Set(txn, "x", int64(2))
		txt := bt.(*crdt.YText)
		txt.Insert(txn, txt.Len(), " (B)", nil)
		b2.Set(txn, "color", "1")
	})

	if err := crdt.ApplyUpdateV1(a, crdt.EncodeStateAsUpdateV1(b, sb), nil); err != nil {
		t.Fatal(err)
	}
	if err := crdt.ApplyUpdateV1(b, crdt.EncodeStateAsUpdateV1(a, sa), nil); err != nil {
		t.Fatal(err)
	}
	ca, cb := Read(a), Read(b)
	if !equal(toAny(ca), toAny(cb)) {
		t.Fatalf("documents differ:\n%#v\n%#v", ca, cb)
	}
	out := Render(ca, f)
	got, err := Parse(out)
	if err != nil {
		t.Fatalf("merged canvas does not parse: %v\n%s", err, out)
	}
	n := got.Canvas.Nodes
	if len(n) != 3 || n[0]["text"] != "A: Hello\n\"world\" <b> (B)" || len(got.Canvas.Edges) != 0 {
		t.Errorf("merged:\n%s", out)
	}
	if x := n[0]["x"]; x != int64(1) && x != int64(2) {
		t.Errorf("x = %v, want one of the two moves", x)
	}
}

// TestReadDropsWhatJSONCannotHold: a peer can put any value in the document,
// such as NaN or a Y.XmlElement. They become nil, so the host neither fails
// to write the file nor panics when an edit moves the item.
func TestReadDropsWhatJSONCannotHold(t *testing.T) {
	f := mustParse(t, obsidianFile)
	host := crdt.New()
	Load(host, f.Canvas)
	peer := crdt.New()
	if err := crdt.ApplyUpdateV1(peer, host.EncodeStateAsUpdate(), nil); err != nil {
		t.Fatal(err)
	}
	sv := peer.StateVector()
	extra, nodes := peer.GetMap(ExtraKey), peer.GetArray(NodesKey)
	a1, b2 := nodes.Get(0).(*crdt.YMap), nodes.Get(1).(*crdt.YMap)
	peer.Transact(func(txn *crdt.Transaction) {
		extra.Set(txn, "nan", math.NaN())
		a1.Set(txn, "x", math.Inf(1))
		b2.Set(txn, "plugin", crdt.NewYXmlElement("p"))
	})
	if err := crdt.ApplyUpdateV1(host, crdt.EncodeStateAsUpdateV1(peer, sv), nil); err != nil {
		t.Fatal(err)
	}

	c := Read(host)
	if v, ok := c.Extra["nan"]; !ok || v != nil {
		t.Errorf("extra nan = %#v, want nil", v)
	}
	if got := ids(c.Nodes); !reflect.DeepEqual(got, []string{"b2", "c3", "g4"}) {
		t.Errorf("nodes = %v, want a1 with an infinite x skipped", got)
	}
	if v, ok := c.Nodes[0]["plugin"]; !ok || v != nil {
		t.Errorf("plugin = %#v, want nil", v)
	}
	if _, err := Parse(Render(c, f)); err != nil {
		t.Errorf("rendered canvas does not parse: %v", err)
	}

	// Bringing b2 to the front rebuilds it with its plugin value.
	next := c
	next.Nodes = append([]map[string]any{c.Nodes[1], c.Nodes[0]}, c.Nodes[2:]...)
	Apply(host, c, next, nil)
	if got := ids(Read(host).Nodes); !reflect.DeepEqual(got, []string{"c3", "b2", "g4"}) {
		t.Errorf("nodes after the move = %v", got)
	}
}

func TestNumberRejectsWhatJSONCannotHold(t *testing.T) {
	for _, v := range []float64{math.NaN(), math.Inf(1), math.Inf(-1)} {
		if _, ok := number(v); ok {
			t.Errorf("number(%v) ok", v)
		}
	}
}
