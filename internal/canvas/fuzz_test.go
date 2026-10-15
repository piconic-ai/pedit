package canvas

import "testing"

// A canvas file comes from disk, or from a guest's edit: Parse must reject
// anything malformed with an error, never a panic.
func FuzzParse(f *testing.F) {
	f.Add([]byte(`{}`))
	f.Add([]byte(`{"nodes":[{"id":"a","type":"text","text":"hi","x":0,"y":0,"width":10,"height":10}],"edges":[]}`))
	f.Add([]byte(`{"nodes":[{"id":"a"}],"edges":[{"id":"e","fromNode":"a","toNode":"b"}]}`))
	f.Add([]byte(`{"nodes":`))
	f.Add([]byte("\xff"))
	f.Fuzz(func(t *testing.T, data []byte) {
		_, _ = Parse(data)
	})
}
