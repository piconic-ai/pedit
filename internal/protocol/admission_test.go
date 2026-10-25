package protocol_test

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/piconic-ai/pedit/internal/protocol"
	"github.com/piconic-ai/pedit/internal/protocol/prototest"
	"github.com/reearth/ygo/awareness"
	"github.com/reearth/ygo/crdt"
)

func TestDialDoesNotForwardAdmissionToRedirect(t *testing.T) {
	var hits atomic.Int32
	destination := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { hits.Add(1) }))
	defer destination.Close()
	origin := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, destination.URL, http.StatusTemporaryRedirect)
	}))
	defer origin.Close()
	header := http.Header{"Sec-WebSocket-Protocol": {protocol.SocketProtocol + ", " + protocol.AdmissionProtocolPrefix + strings.Repeat("A", 43)}}
	conn, err := protocol.DialWebSocket(context.Background(), origin.URL, header)
	if conn != nil {
		conn.Close()
	}
	if err == nil || hits.Load() != 0 {
		t.Fatal("followed a credential-bearing redirect")
	}
}

// Independently computed HKDF-SHA256 vector, also checked by TypeScript.
func TestAdmissionToken(t *testing.T) {
	key := "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8"
	raw, _ := protocol.DecodeKey(key)
	token, err := protocol.AdmissionToken(raw)
	if err != nil {
		t.Fatal(err)
	}
	if token != "G8eCuavz2F_pjyWhj9ozn44ZXf9ZGxvqFKL8L52-udA" {
		t.Fatalf("token = %q", token)
	}
	if _, err := protocol.AdmissionToken(raw[:31]); err == nil {
		t.Fatal("accepted invalid key")
	}
	keys, err := protocol.DeriveBlobKeys(raw)
	if err != nil || keys.Admission != token {
		t.Fatalf("blob admission mismatch: %v", err)
	}
	// A client offers the token of its room's frame key, never its link's secret.
	room, err := protocol.EditKeys(raw, "")
	if err != nil || room.ReadAdmission == token {
		t.Fatalf("room admission = %v, %v", room, err)
	}
	token = room.ReadAdmission
	relay := prototest.NewRelay(false)
	header := http.Header{"Cf-Access-Token": {"access-token"}}
	join(t, relay, key, joinOpts{header: header})
	prototest.WaitFor(t, wait, func() bool { return len(relay.Headers()) > 0 }, "handshake")
	got := relay.Headers()[0]
	if got.Get("Sec-WebSocket-Protocol") != protocol.SocketProtocol+", "+protocol.AdmissionProtocolPrefix+token {
		t.Fatal("admission missing from handshake")
	}
	if got.Get("Cf-Access-Token") != "access-token" || header.Get("Sec-WebSocket-Protocol") != "" {
		t.Fatal("Access header lost or caller header mutated")
	}
	if strings.Contains(got.Get("Sec-WebSocket-Protocol"), key) || strings.Contains(strings.Join(relay.URLs(), ""), token) {
		t.Fatal("secret in wrong transport")
	}
}

func TestSocketProtocolNamesProtocolVersion(t *testing.T) {
	if want := fmt.Sprintf("pedit-v%d", protocol.ProtocolVersion); protocol.SocketProtocol != want {
		t.Fatalf("SocketProtocol = %q, want %q", protocol.SocketProtocol, want)
	}
}

// The Room accepts an upgrade of another protocol version only to close it,
// so the close code must reach the client over a real WebSocket.
func TestOutdatedClientStopsOverWebSocket(t *testing.T) {
	var dials atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		dials.Add(1)
		c, err := websocket.Accept(w, r, &websocket.AcceptOptions{Subprotocols: []string{protocol.SocketProtocol}})
		if err != nil {
			return
		}
		c.Close(websocket.StatusCode(protocol.ClientOutdated), "pedit is outdated; update it")
	}))
	defer srv.Close()
	statuses := make(chan protocol.Status, 16)
	doc := crdt.New()
	client, err := protocol.NewClient(protocol.ClientOptions{
		URL:        "ws" + strings.TrimPrefix(srv.URL, "http"),
		Key:        make([]byte, protocol.KeyBytes),
		Doc:        doc,
		Awareness:  awareness.New(uint64(doc.ClientID())),
		MinBackoff: 10 * time.Millisecond,
		OnStatus:   func(s protocol.Status) { statuses <- s },
	})
	if err != nil {
		t.Fatal(err)
	}
	defer client.Destroy()
	client.Connect()
	timeout := time.After(5 * time.Second)
	for s := protocol.Status(""); s != protocol.StatusClientOutdated; {
		select {
		case s = <-statuses:
		case <-timeout:
			t.Fatalf("status = %v", client.Status())
		}
	}
	time.Sleep(100 * time.Millisecond)
	if n := dials.Load(); n != 1 {
		t.Fatalf("dialed %d times", n)
	}
}
