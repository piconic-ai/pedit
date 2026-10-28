package canvas

import (
	"reflect"
	"strings"
	"testing"

	"github.com/reearth/ygo/crdt"
)

// loaded returns a document holding text, and the parsed file.
func loaded(t *testing.T, text string) (*crdt.Doc, *File) {
	t.Helper()
	f := mustParse(t, text)
	doc := crdt.New()
	Load(doc, f.Canvas)
	return doc, f
}

// itemMap returns the Y.Map of the node or edge with id.
func itemMap(t *testing.T, doc *crdt.Doc, key, id string) *crdt.YMap {
	t.Helper()
	list := doc.GetArray(key)
	for i := 0; i < list.Len(); i++ {
		m := list.Get(i).(*crdt.YMap)
		if v, _ := m.Get("id"); v == id {
			return m
		}
	}
	t.Fatalf("no %s %q", key, id)
	return nil
}

func ids(items []map[string]any) []string {
	var out []string
	for _, v := range items {
		out = append(out, idOf(v))
	}
	return out
}

// TestApplyReproducesNext: applied to the document base came from, the
// change gives exactly next, written as next was.
func TestApplyReproducesNext(t *testing.T) {
	nextOf := map[string]string{
		"move":        strings.Replace(obsidianFile, `"x":0,"y":0,"width":400`, `"x":20,"y":0,"width":400`, 1),
		"text":        strings.Replace(obsidianFile, `Hello\n`, `Hello there\n`, 1),
		"color added": strings.Replace(obsidianFile, `"height":60},`, `"height":60,"color":"3"},`, 1),
		"color gone":  strings.Replace(obsidianFile, `,"color":"4"`, ``, 1),
		"node added": strings.Replace(obsidianFile, "\"height\":60},\n\t\t{\"id\":\"b2\"",
			"\"height\":60},\n\t\t{\"id\":\"n\",\"type\":\"text\",\"text\":\"new\",\"x\":1,\"y\":2,\"width\":3,\"height\":4},\n\t\t{\"id\":\"b2\"", 1),
		"node and its edges gone": strings.Replace(obsidianFile[:strings.Index(obsidianFile, "\t\"edges\"")],
			"\t\t{\"id\":\"b2\",\"type\":\"file\",\"file\":\"notes/b.md\",\"x\":0,\"y\":0,\"width\":400,\"height\":400,\"color\":\"4\"},\n", "", 1) +
			"\t\"edges\":[]\n}",
		"brought to front": strings.Replace(strings.Replace(obsidianFile,
			"\t\t{\"id\":\"a1\",\"type\":\"text\",\"text\":\"Hello\\n\\\"world\\\" <b>\",\"x\":-340,\"y\":-160,\"width\":250,\"height\":60},\n", "", 1),
			"\"height\":800}\n", "\"height\":800},\n\t\t{\"id\":\"a1\",\"type\":\"text\",\"text\":\"Hello\\n\\\"world\\\" <b>\",\"x\":-340,\"y\":-160,\"width\":250,\"height\":60}\n", 1),
		"extra key": strings.Replace(obsidianFile, "{\n", "{\n\t\"meta\":{\"v\":1},\n", 1),
		// Reordered while turning into a text node, and out of one.
		"group to back as text": strings.Replace(strings.Replace(obsidianFile,
			"},\n\t\t{\"id\":\"g4\",\"type\":\"group\",\"label\":\"Group\",\"x\":-400,\"y\":-200,\"width\":900,\"height\":800}\n", "}\n", 1),
			"\t\t{\"id\":\"a1\"", "\t\t{\"id\":\"g4\",\"type\":\"text\",\"text\":\"abc\",\"x\":-400,\"y\":-200,\"width\":900,\"height\":800},\n\t\t{\"id\":\"a1\"", 1),
		"text to back as group": strings.Replace(strings.Replace(obsidianFile,
			"\t\t{\"id\":\"a1\",\"type\":\"text\",\"text\":\"Hello\\n\\\"world\\\" <b>\",\"x\":-340,\"y\":-160,\"width\":250,\"height\":60},\n", "", 1),
			"\"height\":800}\n", "\"height\":800},\n\t\t{\"id\":\"a1\",\"type\":\"group\",\"x\":-340,\"y\":-160,\"width\":250,\"height\":60}\n", 1),
	}
	for name, next := range nextOf {
		t.Run(name, func(t *testing.T) {
			doc, base := loaded(t, obsidianFile)
			nf := mustParse(t, next)
			Apply(doc, base.Canvas, nf.Canvas, nil)
			if got := string(Render(Read(doc), nf)); got != next {
				t.Errorf("got\n%s\nwant\n%s", got, next)
			}
		})
	}
}

// TestApplyKeepsWhatOthersChanged: the document moved on from base, and the
// change is applied on top of that.
func TestApplyKeepsWhatOthersChanged(t *testing.T) {
	doc, base := loaded(t, obsidianFile)
	// Meanwhile someone moves c3, recolours a1, types at the end of a1's text,
	// deletes g4 and adds a node at the end.
	c3 := itemMap(t, doc, NodesKey, "c3")
	a1 := itemMap(t, doc, NodesKey, "a1")
	tv, _ := a1.Get(TextKey)
	text := tv.(*crdt.YText)
	nodes := doc.GetArray(NodesKey)
	doc.Transact(func(txn *crdt.Transaction) {
		c3.Set(txn, "x", int64(99))
		a1.Set(txn, "color", "2")
		text.Insert(txn, text.Len(), "!", nil)
		nodes.Delete(txn, 3, 1)
		m, _ := newItem(txn, map[string]any{"id": "z", "type": "group", "x": int64(0), "y": int64(0), "width": int64(1), "height": int64(1)})
		nodes.PushType(txn, m)
	})

	// The file changes a1's x and the start of its text, edits g4 and brings a1 to the front.
	next := base.Canvas
	next.Nodes = []map[string]any{next.Nodes[1], next.Nodes[2], clone(next.Nodes[3]), clone(next.Nodes[0])}
	next.Nodes[2]["label"] = "Renamed"
	next.Nodes[3]["x"] = int64(-1)
	next.Nodes[3][TextKey] = "Well, " + next.Nodes[3][TextKey].(string)
	Apply(doc, base.Canvas, next, nil)

	got := Read(doc)
	if want := []string{"b2", "c3", "z", "a1"}; !reflect.DeepEqual(ids(got.Nodes), want) {
		t.Fatalf("nodes = %v, want %v", ids(got.Nodes), want)
	}
	a := got.Nodes[3]
	if a["x"] != int64(-1) || a["color"] != "2" || a[TextKey] != "Well, Hello\n\"world\" <b>!" {
		t.Errorf("a1 = %#v", a)
	}
	if got.Nodes[1]["x"] != int64(99) {
		t.Errorf("c3 = %#v", got.Nodes[1])
	}
	// The moved node's text is a Y.Text again, so typing in it still merges by character.
	if v, _ := itemMap(t, doc, NodesKey, "a1").Get(TextKey); reflect.TypeOf(v) != reflect.TypeOf(text) {
		t.Errorf("text is %T", v)
	}
}

func TestConcurrentReordersCreateDuplicateRecords(t *testing.T) {
	a, base := loaded(t, obsidianFile)
	b := crdt.New()
	if err := crdt.ApplyUpdateV1(b, a.EncodeStateAsUpdate(), nil); err != nil {
		t.Fatal(err)
	}
	next := base.Canvas
	next.Nodes = append(append([]map[string]any{}, next.Nodes[1:]...), next.Nodes[0])
	sa, sb := a.StateVector(), b.StateVector()
	Apply(a, base.Canvas, next, nil)
	Apply(b, base.Canvas, next, nil)
	if err := crdt.ApplyUpdateV1(a, crdt.EncodeStateAsUpdateV1(b, sb), nil); err != nil {
		t.Fatal(err)
	}
	if err := crdt.ApplyUpdateV1(b, crdt.EncodeStateAsUpdateV1(a, sa), nil); err != nil {
		t.Fatal(err)
	}
	for _, doc := range []*crdt.Doc{a, b} {
		count := 0
		list := doc.GetArray(NodesKey)
		for i := 0; i < list.Len(); i++ {
			if m, ok := list.Get(i).(*crdt.YMap); ok {
				if id, _ := m.Get("id"); id == "a1" {
					count++
				}
			}
		}
		if count != 2 {
			t.Errorf("concurrent reorders left %d records for a1, want 2", count)
		}
	}
}

func TestConcurrentReorderCanHideTextEdit(t *testing.T) {
	a, base := loaded(t, obsidianFile)
	b := crdt.New()
	if err := crdt.ApplyUpdateV1(b, a.EncodeStateAsUpdate(), nil); err != nil {
		t.Fatal(err)
	}
	sa, sb := a.StateVector(), b.StateVector()
	next := base.Canvas
	next.Nodes = append(append([]map[string]any{}, next.Nodes[1:]...), next.Nodes[0])
	Apply(a, base.Canvas, next, nil)
	item := itemMap(t, b, NodesKey, "a1")
	v, _ := item.Get(TextKey)
	text := v.(*crdt.YText)
	b.Transact(func(txn *crdt.Transaction) { text.Insert(txn, text.Len(), " concurrent", nil) })
	if !strings.HasSuffix(text.ToString(), " concurrent") {
		t.Fatal("the text edit was not applied before syncing")
	}
	if err := crdt.ApplyUpdateV1(a, crdt.EncodeStateAsUpdateV1(b, sb), nil); err != nil {
		t.Fatal(err)
	}
	if err := crdt.ApplyUpdateV1(b, crdt.EncodeStateAsUpdateV1(a, sa), nil); err != nil {
		t.Fatal(err)
	}
	for _, doc := range []*crdt.Doc{a, b} {
		found := false
		for _, node := range Read(doc).Nodes {
			if node["id"] == "a1" {
				found = true
				if strings.Contains(node[TextKey].(string), " concurrent") {
					t.Error("the current model unexpectedly retained the concurrent text edit")
				}
			}
		}
		if !found {
			t.Error("the reordered node is missing")
		}
	}
}

func TestApplyTextMergesByCharacter(t *testing.T) {
	doc, base := loaded(t, obsidianFile)
	a1 := itemMap(t, doc, NodesKey, "a1")
	tv, _ := a1.Get(TextKey)
	text := tv.(*crdt.YText)
	doc.Transact(func(txn *crdt.Transaction) { text.Insert(txn, 0, "> ", nil) })

	next := base.Canvas
	next.Nodes = append([]map[string]any{clone(next.Nodes[0])}, next.Nodes[1:]...)
	next.Nodes[0][TextKey] = "Hello\n\"world\" <b> and more"
	Apply(doc, base.Canvas, next, nil)
	if got := text.ToString(); got != "> Hello\n\"world\" <b> and more" {
		t.Errorf("text = %q", got)
	}
}

func TestApplyEdgesAndNothingToDo(t *testing.T) {
	doc, base := loaded(t, obsidianFile)
	before := doc.EncodeStateAsUpdate()
	Apply(doc, base.Canvas, base.Canvas, nil)
	if after := doc.EncodeStateAsUpdate(); string(after) != string(before) {
		t.Error("an unchanged canvas changed the document")
	}

	next := base.Canvas
	next.Edges = []map[string]any{clone(next.Edges[1]), {"id": "e3", "fromNode": "c3", "toNode": "a1"}}
	next.Edges[0]["label"] = "read"
	Apply(doc, base.Canvas, next, nil)
	got := Read(doc).Edges
	if !reflect.DeepEqual(ids(got), []string{"e2", "e3"}) || got[0]["label"] != "read" {
		t.Errorf("edges = %#v", got)
	}
}

func TestApplyKeepsDeletionsMadeMeanwhile(t *testing.T) {
	doc, base := loaded(t, obsidianFile)
	nodes := doc.GetArray(NodesKey)
	doc.Transact(func(txn *crdt.Transaction) { nodes.Delete(txn, 2, 1) }) // c3

	next := base.Canvas
	next.Nodes = []map[string]any{next.Nodes[0], next.Nodes[1], clone(next.Nodes[2]), next.Nodes[3]}
	next.Nodes[2]["x"] = int64(5)
	Apply(doc, base.Canvas, next, nil)
	if got := ids(Read(doc).Nodes); !reflect.DeepEqual(got, []string{"a1", "b2", "g4"}) {
		t.Errorf("nodes = %v", got)
	}
}

func TestLongestIncreasing(t *testing.T) {
	for _, tt := range []struct {
		seq  []int
		keep int
	}{
		{nil, 0},
		{[]int{0, 1, 2}, 3},
		{[]int{1, 2, 3, 0}, 3},
		{[]int{3, 0, 1, 2}, 3},
		{[]int{2, 1, 0}, 1},
	} {
		if got := len(longestIncreasing(tt.seq)); got != tt.keep {
			t.Errorf("%v keeps %d, want %d", tt.seq, got, tt.keep)
		}
	}
	if moved := movedIDs(
		[]map[string]any{{"id": "a"}, {"id": "b"}, {"id": "c"}},
		[]map[string]any{{"id": "b"}, {"id": "c"}, {"id": "a"}},
	); !reflect.DeepEqual(moved, map[string]bool{"a": true}) {
		t.Errorf("moved = %v", moved)
	}
}
