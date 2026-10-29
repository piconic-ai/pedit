package hoststate

import (
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"os"
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

func TestWorkerHostIdentityVectors(t *testing.T) {
	b, err := os.ReadFile("../../packages/testdata/host-identity-vectors.json")
	if err != nil {
		t.Fatal(err)
	}
	var vectors []struct {
		HostToken string `json:"hostToken"`
		RoomID    string `json:"roomId"`
	}
	if err = json.Unmarshal(b, &vectors); err != nil {
		t.Fatal(err)
	}
	for _, v := range vectors {
		c := Credentials{Version: 1, Origin: "https://edit.piconic.ai", RoomID: v.RoomID, HostToken: v.HostToken}
		c.EditSecret[0] = 1
		c.HostSeed[0] = 1
		if err := c.validate(); err != nil {
			t.Fatalf("valid Worker identity rejected: %v", err)
		}
		c.RoomID = "AAAAAAAAAAAAAAAAAAAAAA"
		if c.validate() == nil {
			t.Fatal("wrong room accepted")
		}
	}
}
func TestRejectInvalidHostToken(t *testing.T) {
	c := Credentials{Version: 1, Origin: "https://edit.piconic.ai", RoomID: "6oZqdX5MOLq_qBJ8vppAnT", HostToken: "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8"}
	c.EditSecret[0] = 1
	c.HostSeed[0] = 1
	for _, token := range []string{"host-token", c.HostToken + "=", c.HostToken[:42] + "9", strings.Repeat("A", 42) + "!"} {
		x := c
		x.HostToken = token
		if x.validate() == nil {
			t.Fatal("invalid token accepted")
		}
	}
}

func TestNonCanonicalTokenWithMatchingRoomIsRejected(t *testing.T) {
	token := "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh9"
	digest := sha256.Sum256([]byte(token))
	c := Credentials{Version: 1, Origin: "https://edit.piconic.ai", RoomID: base64.RawURLEncoding.EncodeToString(digest[:])[:22], HostToken: token}
	c.EditSecret[0] = 1
	c.HostSeed[0] = 1
	if c.validate() == nil {
		t.Fatal("noncanonical token accepted even though its room digest matches")
	}
}
