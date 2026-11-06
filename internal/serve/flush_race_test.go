package serve

import (
	"os"
	"strings"
	"sync"
	"testing"
	"time"
)

// Edits race Flush calls: a Flush never leaves older text scheduled over a
// newer edit, so after one more Flush the file equals the doc.
func TestServerFlushRacingEditsLeavesTheFileEqualToTheDoc(t *testing.T) {
	s, file, _ := openWith(t, "\n", func(o *Options) { o.WriteDelay = time.Millisecond })
	c := dial(t, s)
	eventually(t, "synced", func() bool { return c.get() == "\n" })
	const edits = 200
	var wg sync.WaitGroup
	done := make(chan struct{})
	wg.Add(1)
	go func() {
		defer wg.Done()
		for {
			select {
			case <-done:
				return
			default:
				_ = s.Flush()
			}
		}
	}()
	for i := 0; i < edits; i++ {
		c.insert(0, "x")
	}
	eventually(t, "every edit reached the server", func() bool { return strings.Count(s.render(), "x") == edits })
	close(done)
	wg.Wait()
	if err := s.Flush(); err != nil {
		t.Fatal(err)
	}
	if b, _ := os.ReadFile(file); string(b) != s.render() {
		t.Fatalf("file %d bytes, doc %d bytes", len(b), len(s.render()))
	}
}
