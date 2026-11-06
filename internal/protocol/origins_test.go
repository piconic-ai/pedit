package protocol_test

import (
	"encoding/json"
	"os"
	"slices"
	"testing"

	"github.com/piconic-ai/pedit/internal/protocol"
)

// origin-vectors.json is read by packages/worker/test/origins-vectors.test.ts
// too, so the relay and pedit accept the same lists.
func TestParseOriginsMatchesTheVectors(t *testing.T) {
	data, err := os.ReadFile("../../packages/testdata/origin-vectors.json")
	if err != nil {
		t.Fatal(err)
	}
	var vectors []struct {
		Origins []string `json:"origins"`
		OK      bool     `json:"ok"`
		Result  []string `json:"result"`
	}
	if err := json.Unmarshal(data, &vectors); err != nil {
		t.Fatal(err)
	}
	for _, v := range vectors {
		got, err := protocol.ParseOrigins(v.Origins)
		if (err == nil) != v.OK {
			t.Errorf("%q: ok %v, err %v", v.Origins, v.OK, err)
			continue
		}
		if !v.OK {
			continue
		}
		want := v.Result
		if want == nil {
			want = v.Origins
		}
		if !slices.Equal(got, want) {
			t.Errorf("%q: got %q, want %q", v.Origins, got, want)
		}
	}
}

func TestOriginsHeaderName(t *testing.T) {
	if protocol.OriginsHeader != "X-Pedit-Origins" {
		t.Fatal(protocol.OriginsHeader)
	}
}
