// Generates deterministic cross-language structural mutation cases.
package main

import (
	"encoding/base64"
	"encoding/json"
	"fmt"
	"os"

	"github.com/piconic-ai/pedit/internal/protocol"
)

type vector struct {
	Name  string `json:"name"`
	Kind  string `json:"kind"`
	Hex   string `json:"hex"`
	Valid bool   `json:"valid"`
}

func main() {
	data, err := os.ReadFile("packages/testdata/kept-text-payload-vectors.json")
	if err != nil {
		panic(err)
	}
	var fixture struct {
		Payload string `json:"payload"`
	}
	if err = json.Unmarshal(data, &fixture); err != nil {
		panic(err)
	}
	payload, err := base64.RawURLEncoding.DecodeString(fixture.Payload)
	if err != nil {
		panic(err)
	}
	decoded, err := protocol.DecodeKeptTextPayload(payload, 4)
	if err != nil {
		panic(err)
	}
	cases := []struct {
		kind string
		data []byte
	}{{"text", decoded.Documents[0]}, {"comments", decoded.Documents[7]}}
	var result []vector
	for _, c := range cases {
		add := func(name string, b []byte) {
			var err error
			if c.kind == "text" {
				err = protocol.CheckKeptTextState(b)
			} else {
				err = protocol.CheckKeptCommentsState(b)
			}
			result = append(result, vector{Name: name, Kind: c.kind, Hex: fmt.Sprintf("%x", b), Valid: err == nil})
		}
		add(c.kind+" original", c.data)
		for i := range c.data {
			for _, mask := range []byte{1, 0x40, 0x80, 0xff} {
				v := append([]byte(nil), c.data...)
				v[i] ^= mask
				add(fmt.Sprintf("%s byte %d xor %02x", c.kind, i, mask), v)
			}
			add(fmt.Sprintf("%s truncate %d", c.kind, i), c.data[:i])
		}
		add(c.kind+" trailing zero", append(append([]byte(nil), c.data...), 0))
	}
	out, err := json.MarshalIndent(result, "", "  ")
	if err != nil {
		panic(err)
	}
	fmt.Println(string(out))
}
