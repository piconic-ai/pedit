package protocol

import (
	"testing"
	"time"
)

func TestPacerLetsABurstThroughThenKeepsTheRate(t *testing.T) {
	now := time.Unix(0, 0)
	clock := func() time.Time { return now }
	p := newPacer(Rate{Burst: 100, PerSecond: 100}, Rate{Burst: 800, PerSecond: 800}, clock)
	// 7/8 of 800 bytes at once.
	if d := p.take(700); d != 0 {
		t.Fatalf("within the burst: wait %v", d)
	}
	if d := p.take(70); d < 99*time.Millisecond || d > 101*time.Millisecond {
		t.Fatalf("70 bytes over, at 700 a second: wait %v", d)
	}
	now = now.Add(100 * time.Millisecond)
	if d := p.take(0); d != 0 {
		t.Fatalf("after waiting: wait %v", d)
	}
	// Messages count too: 7 of 8 at once, then 7 a second.
	many := newPacer(Rate{Burst: 8, PerSecond: 8}, Rate{}, clock)
	for range 7 {
		if d := many.take(1); d != 0 {
			t.Fatalf("within the message burst: wait %v", d)
		}
	}
	if d := many.take(1); d < 142*time.Millisecond || d > 143*time.Millisecond {
		t.Fatalf("one message over, at 7 a second: wait %v", d)
	}
	// Zero rates mean the relay's.
	if d := newPacer(Rate{}, Rate{}, clock).take(MaxFrameBytes); d != 0 {
		t.Fatalf("one frame on the relay's rates: wait %v", d)
	}
}
