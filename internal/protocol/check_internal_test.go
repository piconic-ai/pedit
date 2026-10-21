package protocol

import (
	"errors"
	"testing"
	"time"

	"github.com/reearth/ygo/crdt"
	ysync "github.com/reearth/ygo/sync"
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
	var share timeShare
	check := func() error {
		_, err := share.take(func() ([]byte, error) {
			checks++
			*now = now.Add(2 * checkBurst)
			return nil, nil
		})
		return err
	}
	if err := check(); err != nil {
		t.Fatal(err)
	}
	// The check took more than was in hand: none until it is made up.
	if err := check(); !errors.Is(err, ErrRetryLater) || checks != 1 {
		t.Fatalf("timedCheck = %v after %d checks", err, checks)
	}
	*now = now.Add(checkShare * checkBurst)
	if err := check(); !errors.Is(err, ErrRetryLater) {
		t.Fatalf("checked with nothing in hand: %v", err)
	}
	*now = now.Add(checkShare * time.Millisecond)
	if err := check(); err != nil || checks != 2 {
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

func TestCheckedFilesShareTheirTime(t *testing.T) {
	now := fakeClock(t)
	slow := func(*crdt.Doc, []byte) error {
		*now = now.Add(2 * checkBurst)
		return nil
	}
	update := ysync.EncodeUpdate(crdt.EncodeStateAsUpdateV1(crdt.New(), nil))
	var share timeShare
	one := &fileDoc{doc: crdt.New(), check: slow}
	two := &fileDoc{doc: crdt.New(), check: slow}
	if _, err := one.apply(update, nil, &share); err != nil {
		t.Fatal(err)
	}
	// The other file's turn is spent too.
	if _, err := two.apply(update, nil, &share); !errors.Is(err, ErrRetryLater) {
		t.Fatalf("apply = %v", err)
	}
}
