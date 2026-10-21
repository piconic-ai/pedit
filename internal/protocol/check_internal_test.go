package protocol

import (
	"errors"
	"testing"
	"time"

	"github.com/reearth/ygo/crdt"
	ysync "github.com/reearth/ygo/sync"
)

// fakeClock is a clock for a timeShare that tests move by hand.
func fakeClock() (*time.Time, func() time.Time) {
	now := time.Unix(1, 0)
	return &now, func() time.Time { return now }
}

func TestChecksTakeTheirShareOfTheTimeOnly(t *testing.T) {
	now, clock := fakeClock()
	checks := 0
	share := timeShare{now: clock}
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
		t.Fatalf("take = %v after %d checks", err, checks)
	}
	*now = now.Add(checkShare * checkBurst)
	if err := check(); !errors.Is(err, ErrRetryLater) {
		t.Fatalf("checked with nothing in hand: %v", err)
	}
	*now = now.Add(checkShare * time.Millisecond)
	if err := check(); err != nil || checks != 2 {
		t.Fatalf("take = %v after %d checks", err, checks)
	}
}

func TestCheckedFilesShareTheirTime(t *testing.T) {
	now, clock := fakeClock()
	slow := func(*crdt.Doc, []byte) error {
		*now = now.Add(2 * checkBurst)
		return nil
	}
	update := ysync.EncodeUpdate(crdt.EncodeStateAsUpdateV1(crdt.New(), nil))
	share := timeShare{now: clock}
	one := &fileDoc{doc: crdt.New(), check: slow}
	two := &fileDoc{doc: crdt.New(), check: slow}
	if _, _, err := one.apply(update, nil, &share); err != nil {
		t.Fatal(err)
	}
	// The other file's turn is spent too.
	if _, _, err := two.apply(update, nil, &share); !errors.Is(err, ErrRetryLater) {
		t.Fatalf("apply = %v", err)
	}
}
