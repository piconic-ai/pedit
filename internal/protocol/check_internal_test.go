package protocol

import (
	"errors"
	"testing"
	"time"

	"github.com/reearth/ygo/crdt"
)

// fakeClock stands in for checkClock until the test ends.
func fakeClock(t *testing.T) *time.Time {
	now := time.Unix(1, 0)
	checkClock = func() time.Time { return now }
	t.Cleanup(func() { checkClock = time.Now })
	return &now
}

func TestChecksTakeTheirShareOfTheTimeOnly(t *testing.T) {
	now := fakeClock(t)
	checks := 0
	f := &fileDoc{doc: crdt.New(), credit: checkBurst, counted: *now}
	f.check = func(*crdt.Doc, []byte) error {
		checks++
		*now = now.Add(2 * checkBurst)
		return nil
	}
	if err := f.timedCheck(nil); err != nil {
		t.Fatal(err)
	}
	// The check took more than was in hand: none until it is made up.
	if err := f.timedCheck(nil); !errors.Is(err, ErrRetryLater) || checks != 1 {
		t.Fatalf("timedCheck = %v after %d checks", err, checks)
	}
	*now = now.Add(checkShare * checkBurst)
	if err := f.timedCheck(nil); !errors.Is(err, ErrRetryLater) {
		t.Fatalf("checked with nothing in hand: %v", err)
	}
	*now = now.Add(checkShare * time.Millisecond)
	if err := f.timedCheck(nil); err != nil || checks != 2 {
		t.Fatalf("timedCheck = %v after %d checks", err, checks)
	}
}

func TestResyncsAreSpacedOut(t *testing.T) {
	now := fakeClock(t)
	f := &fileDoc{}
	if !f.mayResync() || f.mayResync() {
		t.Fatal("not one resync at first")
	}
	*now = now.Add(resyncEvery)
	if !f.mayResync() {
		t.Fatal("no resync later")
	}
}
