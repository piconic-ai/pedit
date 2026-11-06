package serve

import (
	"os"
	"testing"
	"time"
)

func TestServerFlushWritesNowAndKeepsServing(t *testing.T) {
	s, file, _ := openWith(t, "x\n", func(o *Options) { o.WriteDelay = time.Hour })
	c := dial(t, s)
	eventually(t, "synced", func() bool { return c.get() == "x\n" })
	c.insert(0, "a:")
	eventually(t, "the server has the edit", func() bool { return s.render() == "a:x\n" })
	if b, _ := os.ReadFile(file); string(b) != "x\n" {
		t.Fatalf("written before Flush: %q", b)
	}
	if err := s.Flush(); err != nil {
		t.Fatal(err)
	}
	if b, _ := os.ReadFile(file); string(b) != "a:x\n" {
		t.Fatalf("file %q after Flush", b)
	}
	// Still open: another edit is served and saved at close.
	c.insert(0, "b:")
	eventually(t, "the edit after Flush", func() bool { return s.render() == "b:a:x\n" })
	if err := s.Close(); err != nil {
		t.Fatal(err)
	}
	if b, _ := os.ReadFile(file); string(b) != "b:a:x\n" {
		t.Fatalf("file %q after Close", b)
	}
}
