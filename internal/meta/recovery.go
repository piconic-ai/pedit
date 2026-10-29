package meta

import (
	"errors"
	"reflect"

	"github.com/reearth/ygo/crdt"
)

var errRecoveryComments = errors.New("comments cannot be converted without loss")

// RenderRecovery renders only fully understood text comments whose positions
// are still resolvable. It never falls back to an old selector or quote.
func RenderRecovery(doc *crdt.Doc, prev *File, tr *Tracker) ([]byte, error) {
	if doc == nil || prev == nil || tr == nil {
		return nil, errRecoveryComments
	}
	tr.Learn(doc)
	comments := doc.GetMap(CommentsKey)
	if len(comments.Keys()) > MaxThreads {
		return nil, errRecoveryComments
	}
	expected := make(map[string]Thread, len(comments.Keys()))
	for _, id := range comments.Keys() {
		value, _ := comments.Get(id)
		m, ok := value.(*crdt.YMap)
		if !ok || checkID(id) != nil || !sameKeys(m.Keys(), AnchorKey, QuoteKey, ResolvedKey, MessagesKey) {
			return nil, errRecoveryComments
		}
		thread, err := recoveryThread(m, tr, prev.Path)
		if err != nil {
			return nil, err
		}
		expected[id] = thread
	}
	// Read mutates prev; make an independent copy by round-tripping its bytes.
	baseline, err := Render(prev)
	if err != nil {
		return nil, err
	}
	copy, err := Parse(baseline)
	if err != nil {
		return nil, err
	}
	result := Read(doc, copy, tr)
	if !reflect.DeepEqual(result.Comments, expected) {
		return nil, errRecoveryComments
	}
	raw, err := Render(result)
	if err != nil {
		return nil, err
	}
	checked, err := Parse(raw)
	if err != nil || !reflect.DeepEqual(checked, result) {
		return nil, errRecoveryComments
	}
	return raw, nil
}

func sameKeys(keys []string, want ...string) bool {
	if len(keys) != len(want) {
		return false
	}
	for _, k := range keys {
		found := false
		for _, w := range want {
			if k == w {
				found = true
				break
			}
		}
		if !found {
			return false
		}
	}
	return true
}

func recoveryThread(m *crdt.YMap, tr *Tracker, path string) (Thread, error) {
	var result Thread
	raw, ok := get[map[string]any](m, AnchorKey)
	if !ok || len(raw) != 3 || raw[typeKey] != AnchorText || raw[startKey] == nil || raw[endKey] == nil {
		return result, errRecoveryComments
	}
	anchor, ok := placeNow(AnchorText, raw, textOf(tr, path))
	if !ok {
		return result, errRecoveryComments
	}
	quote, ok := get[string](m, QuoteKey)
	if !ok {
		return result, errRecoveryComments
	}
	resolved, ok := get[bool](m, ResolvedKey)
	if !ok {
		return result, errRecoveryComments
	}
	messages, ok := get[*crdt.YMap](m, MessagesKey)
	if !ok || len(messages.Keys()) > MaxMessages {
		return result, errRecoveryComments
	}
	result = Thread{Anchor: anchor, Quote: quote, Resolved: resolved, Messages: make(map[string]Message)}
	for _, id := range messages.Keys() {
		value, _ := messages.Get(id)
		fields, ok := value.(map[string]any)
		if !ok || len(fields) != 3 || checkID(id) != nil {
			return Thread{}, errRecoveryComments
		}
		message, ok := messageOut(value)
		if !ok || message.check() != nil {
			return Thread{}, errRecoveryComments
		}
		result.Messages[id] = message
	}
	if result.check() != nil {
		return Thread{}, errRecoveryComments
	}
	return result, nil
}
