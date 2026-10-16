package protocol

import "testing"

func TestReplayGuard(t *testing.T) {
	g := replayGuard{self: Sender{9}}
	for _, c := range []struct {
		from    Sender
		counter uint64
		want    bool
	}{
		{Sender{1}, 1, true},
		{Sender{1}, 1, false}, // again
		{Sender{1}, 3, true},  // one dropped on the way is fine
		{Sender{1}, 2, false}, // but not one older than the last
		{Sender{2}, 1, true},  // each sender counts on its own
		{Sender{1}, 0, false},
		{Sender{9}, 100, false}, // our own, sent back
	} {
		if got := g.accept(c.from, c.counter); got != c.want {
			t.Errorf("accept(%v, %d) = %v", c.from[0], c.counter, got)
		}
	}
}

func TestFrameRoundTrip(t *testing.T) {
	from := Sender{1, 2, 3}
	data := EncodeFrame(from, 1<<40+5, []byte{byte(MessageSync), 7})
	got, counter, message, err := DecodeFrame(data)
	if err != nil || got != from || counter != 1<<40+5 || string(message) != "\x00\x07" {
		t.Fatalf("DecodeFrame = %v, %d, %x, %v", got, counter, message, err)
	}
	if _, _, _, err := DecodeFrame(data[:SenderBytes+7]); err == nil {
		t.Error("a frame without a whole counter decoded")
	}
}
