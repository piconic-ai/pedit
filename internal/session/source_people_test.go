package session

import (
	"reflect"
	"sync"
	"sync/atomic"
	"testing"

	"github.com/piconic-ai/pedit/internal/protocol"
	"github.com/piconic-ai/pedit/internal/protocol/prototest"
)

func TestSourcePeopleAreLocalAndLegacyPeopleStayRemote(t *testing.T) {
	var mu sync.Mutex
	var people []Person
	var names []string
	f, _ := shareSource(t, "x\n", setupOpts{
		onPeers:  func(p []Person) { mu.Lock(); people = p; mu.Unlock() },
		onPeople: func(p []string) { mu.Lock(); names = p; mu.Unlock() },
	})
	g := joinAsGuest(t, f.relay, f.session.URL)
	g.aw.SetLocalState(map[string]any{"name": "same"})
	for i, reader := range []bool{false, true} {
		id := uint64(4242 + i)
		if err := f.session.FromSourceAwareness(id, reader, protocol.EncodeState(id, 1, []byte(`{"name":"same"}`))); err != nil {
			t.Fatal(err)
		}
	}
	want := []Person{
		{Name: "same", Access: protocol.AccessEdit, Local: true},
		{Name: "same", Access: protocol.AccessEdit},
		{Name: "same", Access: protocol.AccessRead, Local: true},
	}
	prototest.WaitFor(t, wait, func() bool {
		mu.Lock()
		defer mu.Unlock()
		return reflect.DeepEqual(people, want) && reflect.DeepEqual(names, []string{"same"})
	}, "local and remote people with the same name")
	if err := f.session.FromSourceAwareness(4242, false, protocol.EncodeState(4242, 2, []byte("null"))); err != nil {
		t.Fatal(err)
	}
	prototest.WaitFor(t, wait, func() bool {
		mu.Lock()
		defer mu.Unlock()
		return reflect.DeepEqual(people, want[1:])
	}, "removed local page")
}

func TestSourcePeopleCallbackRunsOutsideSourceLock(t *testing.T) {
	var session *Session
	done := make(chan struct{})
	var once sync.Once
	f, _ := shareSource(t, "x\n", setupOpts{onPeers: func(people []Person) {
		if len(people) == 0 {
			return
		}
		if len(session.sourcePeople()) != 1 {
			t.Error("source page missing from callback")
		}
		once.Do(func() { close(done) })
	}})
	session = f.session
	if err := session.FromSourceAwareness(pageID, true, pageUpdate(1, "local")); err != nil {
		t.Fatal(err)
	}
	<-done
}

func TestSourcePeopleNeverPublishAnOlderSnapshotAfterAChange(t *testing.T) {
	for _, state := range []string{"null", `{"name":"new"}`} {
		t.Run(state, func(t *testing.T) {
			entered, release := make(chan struct{}), make(chan struct{})
			var blocked atomic.Bool
			var mu sync.Mutex
			var delivered [][]Person
			defer func() {
				if t.Failed() {
					mu.Lock()
					defer mu.Unlock()
					t.Logf("delivered people snapshots: %#v", delivered)
				}
			}()
			f, _ := shareSource(t, "x\n", setupOpts{onPeers: func(people []Person) {
				if len(people) == 1 && people[0].Name == "old" && blocked.CompareAndSwap(false, true) {
					close(entered)
					<-release
				}
				mu.Lock()
				delivered = append(delivered, people)
				mu.Unlock()
			}})
			firstDone := make(chan struct{})
			go func() {
				defer close(firstDone)
				if err := f.session.FromSourceAwareness(pageID, false, pageUpdate(1, "old")); err != nil {
					t.Error(err)
				}
			}()
			<-entered
			if err := f.session.FromSourceAwareness(pageID, false, protocol.EncodeState(pageID, 2, []byte(state))); err != nil {
				t.Error(err)
			}
			close(release)
			<-firstDone
			prototest.WaitFor(t, wait, func() bool {
				mu.Lock()
				defer mu.Unlock()
				if len(delivered) < 2 {
					return false
				}
				last := delivered[len(delivered)-1]
				if state == "null" {
					return len(last) == 0
				}
				return len(last) == 1 && last[0].Name == "new"
			}, "the latest local page snapshot")
		})
	}
}

func TestSourcePeopleCallbacksCanUpdateTheirPage(t *testing.T) {
	var session *Session
	done := make(chan struct{})
	var once sync.Once
	f, _ := shareSource(t, "x\n", setupOpts{onPeers: func(people []Person) {
		if len(people) != 1 {
			return
		}
		if people[0].Name == "first" {
			if err := session.FromSourceAwareness(pageID, false, pageUpdate(2, "second")); err != nil {
				t.Error(err)
			}
		}
		if people[0].Name == "second" {
			once.Do(func() { close(done) })
		}
	}})
	session = f.session
	if err := session.FromSourceAwareness(pageID, false, pageUpdate(1, "first")); err != nil {
		t.Fatal(err)
	}
	<-done
}
