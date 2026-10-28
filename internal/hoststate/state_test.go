package hoststate

import (
	"fmt"
	"strings"
	"testing"
)

func TestCredentialsFormattingDoesNotRevealSecrets(t *testing.T) {
	c := Credentials{HostToken: "sensitive-token"}
	c.EditSecret[0] = 42
	c.HostSeed[0] = 99
	for _, f := range []string{"%v", "%+v", "%#v"} {
		s := fmt.Sprintf(f, c)
		if strings.Contains(s, "sensitive-token") || strings.Contains(s, "42") || strings.Contains(s, "99") {
			t.Fatal("credentials leaked through formatting")
		}
	}
}
