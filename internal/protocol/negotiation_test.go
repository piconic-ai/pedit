package protocol_test

import (
	"net/http"
	"strings"
	"testing"

	"github.com/piconic-ai/pedit/internal/protocol"
	"github.com/piconic-ai/pedit/internal/protocol/prototest"
)

func offeredList(h http.Header) []string {
	var out []string
	for _, p := range strings.Split(h.Get("Sec-WebSocket-Protocol"), ",") {
		out = append(out, strings.TrimSpace(p))
	}
	return out
}

func TestHostOffersBothVersionsAndRegistersTheCommentToken(t *testing.T) {
	keys := editKeys(t, protocol.GenerateKey())
	h := protocol.HandshakeHeader(nil, keys, true)
	want := []string{"pedit-v8", "pedit-v7", protocol.AdmissionProtocolPrefix + keys.EditAdmission}
	if got := offeredList(h); strings.Join(got, " ") != strings.Join(want, " ") {
		t.Fatalf("offered %v, want %v", got, want)
	}
	if h.Get(protocol.CommentAdmissionHeader) != keys.CommentAdmission || keys.CommentAdmission == "" {
		t.Fatalf("%s = %q", protocol.CommentAdmissionHeader, h.Get(protocol.CommentAdmissionHeader))
	}
	if h.Get(protocol.ReadAdmissionHeader) != keys.ReadAdmission {
		t.Fatal("the read admission is no longer registered")
	}
}

// A guest, the CLI guest included, offers both versions and its own token,
// and never the comment token or the host's headers.
func TestGuestsOfferBothVersionsButNoCommentToken(t *testing.T) {
	key := protocol.GenerateKey()
	for name, keys := range map[string]*protocol.RoomKeys{
		"edit":    editKeys(t, key),
		"comment": lowerKeys(t, key, protocol.AccessComment),
		"read":    lowerKeys(t, key, protocol.AccessRead),
	} {
		h := protocol.HandshakeHeader(nil, keys, false)
		token := keys.ReadAdmission
		if keys.Access == protocol.AccessEdit {
			token = keys.EditAdmission
		}
		want := []string{"pedit-v8", "pedit-v7", protocol.AdmissionProtocolPrefix + token}
		if got := offeredList(h); strings.Join(got, " ") != strings.Join(want, " ") {
			t.Fatalf("%s link offered %v, want %v", name, got, want)
		}
		if strings.Contains(h.Get("Sec-WebSocket-Protocol"), protocol.CommentAdmissionPrefix) ||
			h.Get(protocol.CommentAdmissionHeader) != "" || h.Get(protocol.ReadAdmissionHeader) != "" {
			t.Fatalf("%s link sent a host or comment credential", name)
		}
	}
}

func TestClientReadsTheAcceptedVersion(t *testing.T) {
	for subprotocol, want := range map[string]int{"pedit-v8": 8, "pedit-v7": 7} {
		relay := &prototest.Scripted{Subprotocol: subprotocol}
		client, _ := scriptedPeer(t, relay, protocol.GenerateKey(), protocol.ClientOptions{})
		waitConn(t, relay)
		prototest.WaitFor(t, wait, func() bool { return client.Version() == want }, subprotocol)
	}
	if protocol.ProtocolVersion != 8 || protocol.SocketProtocols != "pedit-v8, pedit-v7" {
		t.Fatalf("version %d offers %q", protocol.ProtocolVersion, protocol.SocketProtocols)
	}
}
