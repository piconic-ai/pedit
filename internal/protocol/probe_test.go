package protocol_test

import (
	"sync"
	"testing"

	"github.com/piconic-ai/pedit/internal/protocol"
	"github.com/piconic-ai/pedit/internal/protocol/prototest"
	"github.com/reearth/ygo/crdt"
)

// answers records the answers to a probe: by whom, and the clock of the
// prober's client they reach.
type answers struct {
	mu    sync.Mutex
	host  []uint64
	other []uint64
}

func (a *answers) add(client crdt.ClientID) func(uint64, bool, []byte) {
	return func(_ uint64, fromHost bool, update []byte) {
		raw, err := crdt.EncodeStateVectorFromUpdate(update)
		if err != nil {
			return
		}
		sv, err := crdt.DecodeStateVectorV1(raw)
		if err != nil {
			return
		}
		a.mu.Lock()
		defer a.mu.Unlock()
		if fromHost {
			a.host = append(a.host, sv[client])
		} else {
			a.other = append(a.other, sv[client])
		}
	}
}

func (a *answers) hostReached(clock uint64) bool {
	a.mu.Lock()
	defer a.mu.Unlock()
	for _, c := range a.host {
		if c >= clock {
			return true
		}
	}
	return false
}

func TestAProbeShowsWhatTheHostHas(t *testing.T) {
	relay := prototest.NewRelay(false)
	key := protocol.GenerateKey()
	host := join(t, relay, key, joinOpts{state: map[string]any{"role": "host"}})
	hostComments := newFileText("")
	if err := host.AddCommentsFile(2, hostComments.doc, nil); err != nil {
		t.Fatal(err)
	}
	// An editor that is not the host answers too, and does not count.
	editor := join(t, relay, key, joinOpts{state: map[string]any{"role": "guest"}})
	if err := editor.AddCommentsFile(2, newFileText("").doc, nil); err != nil {
		t.Fatal(err)
	}
	var got answers
	comments := newFileText("")
	commenter := join(t, relay, key, joinOpts{link: lowerLink(t, key, protocol.AccessComment), onFileAnswer: got.add(comments.doc.ClientID())})
	if err := commenter.AddCommentsFile(2, comments.doc, nil); err != nil {
		t.Fatal(err)
	}
	prototest.WaitFor(t, wait, func() bool { return len(commenter.aw.GetStates()) >= 3 }, "the editors' states")

	comments.insert(0, "a comment")
	prototest.WaitFor(t, wait, func() bool { return hostComments.String() == "a comment" }, "the comment at the host")
	sv := comments.doc.StateVector()
	lowered := crdt.StateVector{}
	for client, clock := range sv {
		lowered[client] = clock - 1
	}
	if err := commenter.ProbeFile(2, lowered); err != nil {
		t.Fatal(err)
	}
	clock := sv[comments.doc.ClientID()]
	prototest.WaitFor(t, wait, func() bool { return got.hostReached(clock) }, "the host's answer covering the comment")
	prototest.WaitFor(t, wait, func() bool {
		got.mu.Lock()
		defer got.mu.Unlock()
		return len(got.other) > 0
	}, "the editor's answer, not taken as the host's")
	if err := commenter.ProbeFile(9, lowered); err == nil {
		t.Fatal("a probe of a file not added")
	}
}
