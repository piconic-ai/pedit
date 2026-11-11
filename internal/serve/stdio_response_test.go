package serve

import (
	"context"
	"errors"
	"testing"
	"time"
)

func TestEventContextWaitsForQueueSpaceAndCancels(t *testing.T) {
	st := &Stdio{out: make(chan []byte), closing: make(chan struct{})}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- st.EventContext(ctx, "comments_page", map[string]any{"done": true}) }()
	select {
	case err := <-done:
		t.Fatalf("dropped a response while stdout was slow: %v", err)
	case <-time.After(eventWait + 20*time.Millisecond):
	}
	select {
	case frame := <-st.out:
		if frame[0] != kindEvent {
			t.Fatal("not an event")
		}
	case <-time.After(time.Second):
		t.Fatal("response was lost")
	}
	if err := <-done; err != nil {
		t.Fatal(err)
	}
	go func() { done <- st.EventContext(ctx, "comments_page", map[string]any{}) }()
	cancel()
	if err := <-done; !errors.Is(err, context.Canceled) {
		t.Fatalf("cancel: %v", err)
	}
	close(st.closing)
	if err := st.EventContext(context.Background(), "comments_page", map[string]any{}); err == nil {
		t.Fatal("closed stdio accepted a response")
	}
}
