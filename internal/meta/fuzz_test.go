package meta_test

import (
	"bytes"
	"testing"

	"github.com/piconic-ai/pedit/internal/meta"
)

// FuzzParse checks that no file makes Parse panic, and that what it accepts
// renders to a file it reads back the same.
func FuzzParse(f *testing.F) {
	f.Add([]byte(sample))
	f.Add([]byte(`{"version":1,"path":"a.md"}`))
	f.Add([]byte(`{"version":1,"path":"a.md","comments":{"c":{"anchor":{"type":"node","id":"n"},"quote":"","resolved":false,"messages":null}}}`))
	f.Fuzz(func(t *testing.T, data []byte) {
		file, err := meta.Parse(data)
		if err != nil {
			return
		}
		out, err := meta.Render(file)
		if err != nil {
			t.Fatalf("render: %v", err)
		}
		again, err := meta.Parse(out)
		if err != nil {
			t.Fatalf("parse what Render wrote: %v\n%s", err, out)
		}
		out2, err := meta.Render(again)
		if err != nil || !bytes.Equal(out, out2) {
			t.Fatalf("render is not stable: %v\n%s\n%s", err, out, out2)
		}
	})
}
