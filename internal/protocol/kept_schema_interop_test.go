package protocol

import (
	"encoding/hex"
	"encoding/json"
	"os"
	"testing"
)

func TestKeptSchemaSharedMutationVectors(t *testing.T) {
	for _, file := range []string{"kept-schema-mutations.json", "kept-schema-generated-mutations.json"} {
		t.Run(file, func(t *testing.T) { runKeptSchemaVectors(t, "../../packages/testdata/"+file) })
	}
}
func runKeptSchemaVectors(t *testing.T, path string) {
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var vectors []struct {
		Name, Kind, Hex string
		Valid           bool
	}
	if err = json.Unmarshal(data, &vectors); err != nil {
		t.Fatal(err)
	}
	for _, v := range vectors {
		t.Run(v.Name, func(t *testing.T) {
			input, err := hex.DecodeString(v.Hex)
			if err != nil {
				t.Fatal(err)
			}
			switch v.Kind {
			case "text":
				err = CheckKeptTextState(input)
			case "comments":
				err = CheckKeptCommentsState(input)
			default:
				t.Fatal("unknown kind")
			}
			if (err == nil) != v.Valid {
				t.Fatalf("valid=%v err=%v", v.Valid, err)
			}
		})
	}
}
