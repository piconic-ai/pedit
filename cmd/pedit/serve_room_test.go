package main

import (
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"reflect"
	"testing"

	"github.com/piconic-ai/pedit/internal/protocol"
	"github.com/piconic-ai/pedit/internal/session"
	"github.com/reearth/ygo/encoding"
)

func startRoomApp(t *testing.T, file string) *app {
	t.Helper()
	a := startApp(t, file)
	t.Cleanup(func() {
		if code := a.stop(); code != 0 {
			t.Errorf("serve exited %d: %s", code, a.stderr.String())
		}
	})
	return a
}

func TestServeRoomReportsEffectiveRelayAndAuthoritativeMetadata(t *testing.T) {
	env := keptEnv(t)
	env.keep.set(1800)
	a := startRoomApp(t, writeFile(t, "hello\n"))
	shared := a.shareKeptAt(env, cmsOrigin)
	if shared["relay"] != env.server.URL || shared["keep"] != float64(1800) || shared["ends"] == nil || shared["lifeEnd"] == nil {
		t.Fatalf("shared metadata: %v", shared)
	}
	a.command(`{"cmd":"unshare"}`)
	a.event("unshared", 1)
	env.keep.setAway(true)
	status := a.status(1)
	if status["relay"] != env.server.URL || status["roomState"] != float64(1) {
		t.Fatalf("status: %v", status)
	}
	env.keep.setAway(false)
	a.command(fmt.Sprintf(`{"cmd":"share","relay":"https://unused.invalid","origins":[%q]}`, cmsOrigin))
	resumed := a.event("shared", 2)
	if resumed["relay"] != env.server.URL || resumed["resumed"] != true {
		t.Fatalf("resumed: %v", resumed)
	}
}

func TestServeRoomEnrichmentFailureDoesNotRejectSharing(t *testing.T) {
	env := keptEnv(t)
	env.keep.force(http.StatusServiceUnavailable)
	a := startRoomApp(t, writeFile(t, "hello\n"))
	shared := a.shareKeptAt(env, cmsOrigin)
	if shared["relay"] != env.server.URL || shared["ends"] != nil || shared["lifeEnd"] != nil {
		t.Fatalf("unknown metadata: %v", shared)
	}
	if shared["keep"] != float64(3600) {
		t.Fatalf("granted keep: %v", shared)
	}
	a.command(`{"cmd":"unshare"}`)
	a.event("unshared", 1)
	live := a.share(fmt.Sprintf(`,"relay":%q`, env.server.URL))
	if live["keep"] != float64(0) {
		t.Fatalf("live keep: %v", live)
	}
}

func TestServeRoomCloseFailureLeavesRoomQueryableAndOneRetryClosesIt(t *testing.T) {
	env := keptEnv(t)
	env.keep.set(3600)
	a := startRoomApp(t, writeFile(t, "hello\n"))
	shared := a.shareKeptAt(env, cmsOrigin)
	env.busy.Store(http.StatusConflict)
	a.command(`{"cmd":"close","id":"fail"}`)
	a.event("unshared", 1)
	a.errorOf(1, "close", "stays kept")
	env.keep.setAway(true)
	status := a.status(1)
	if status["room"] != shared["room"] || status["host"] != "away" || status["relay"] != env.server.URL {
		t.Fatalf("after failure: %v", status)
	}
	env.busy.Store(0)
	a.command(`{"cmd":"close","id":"retry"}`)
	if ended := a.event("room_ended", 1); ended["id"] != "retry" {
		t.Fatalf("ended: %v", ended)
	}
	if status := a.status(2); status["room"] != nil {
		t.Fatalf("closed status: %v", status)
	}
}

func TestServeRoomLocalPeerWireAndTerminalBarrier(t *testing.T) {
	env := newShareEnv(t)
	a := startRoomApp(t, writeFile(t, "hello\n"))
	a.share(fmt.Sprintf(`,"relay":%q`, env.server.URL))
	ls := &liveShare{stopped: true}
	if got := peersEvent([]session.Person{{Name: "same", Access: protocol.AccessRead, Local: true}})["peers"]; !reflect.DeepEqual(got, []map[string]any{{"name": "same", "access": "read", "local": true}}) {
		t.Fatalf("peers: %v", got)
	}
	l := &liveSharer{}
	l.peers(ls, []session.Person{{Name: "late", Access: protocol.AccessEdit}})
	if ls.last != nil {
		t.Fatal("a stopped session published peers")
	}
}

func TestServeRoomUsesConfiguredRelayPrefixByDefault(t *testing.T) {
	env := newShareEnv(t)
	file := writeFile(t, "hello\n")
	config := filepath.Join(filepath.Dir(file), ".pedit")
	if err := os.MkdirAll(config, 0700); err != nil {
		t.Fatal(err)
	}
	relay := env.server.URL + "/prefix"
	if err := os.WriteFile(filepath.Join(config, "config.yaml"), []byte("server: "+relay+"\n"), 0600); err != nil {
		t.Fatal(err)
	}
	a := startRoomApp(t, file)
	if shared := a.share(""); shared["relay"] != relay {
		t.Fatalf("relay: %v", shared)
	}
	if status := a.status(1); status["relay"] != relay {
		t.Fatalf("status relay: %v", status)
	}
}

func TestServeRoomReportsLocalPagesAndRemovals(t *testing.T) {
	env := newShareEnv(t)
	a := startRoomApp(t, writeFile(t, "hello\n"))
	for i, role := range []byte{0, 1} {
		stream := uint32(i + 1)
		a.send(1, stream, []byte{role})
		msg := encoding.NewEncoder()
		msg.WriteVarUint(1)
		msg.WriteVarBytes(protocol.EncodeState(uint64(4242+i), 1, []byte(`{"name":"same"}`)))
		a.send(2, stream, msg.Bytes())
	}
	shared := a.share(fmt.Sprintf(`,"relay":%q`, env.server.URL))
	links := shared["links"].(map[string]any)
	env.join(t, links["edit"].(string), "same")
	latest := func() []any {
		var out []any
		for _, f := range wholeFrames(a.out.String()) {
			if f.kind != 4 {
				continue
			}
			var ev map[string]any
			if json.Unmarshal(f.payload, &ev) == nil && ev["event"] == "peers" {
				out, _ = ev["peers"].([]any)
			}
		}
		return out
	}
	want := []any{
		map[string]any{"name": "same", "access": "edit", "local": true},
		map[string]any{"name": "same", "access": "edit"},
		map[string]any{"name": "same", "access": "read", "local": true},
	}
	eventually(t, "local pages and remote guest", func() bool { return reflect.DeepEqual(latest(), want) })
	a.send(3, 1, nil)
	eventually(t, "local page removal", func() bool { return reflect.DeepEqual(latest(), want[1:]) })
}
