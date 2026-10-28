//go:build darwin

package keptclient

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/piconic-ai/pedit/internal/hoststate"
	"github.com/piconic-ai/pedit/internal/protocol"
)

type testForward struct {
	target *url.URL
	room   string
}

func (f testForward) RoundTrip(r *http.Request) (*http.Response, error) {
	req := r.Clone(r.Context())
	u := *req.URL
	u.Scheme = f.target.Scheme
	u.Host = f.target.Host
	req.URL = &u
	req.Host = u.Host
	req.Header = req.Header.Clone()
	req.Header.Set("X-Test-Room", f.room)
	return http.DefaultTransport.RoundTrip(req)
}
func TestLiveHostLifecycle(t *testing.T) {
	live := os.Getenv("PEDIT_TEST_LIVE_ROOM")
	if live == "" {
		t.Skip("requires test Worker")
	}
	target, err := url.Parse(live)
	if err != nil {
		t.Fatal(err)
	}
	token := base64.RawURLEncoding.EncodeToString(bytes.Repeat([]byte{9}, 32))
	sum := sha256.Sum256([]byte(token))
	room := base64.RawURLEncoding.EncodeToString(sum[:])[:22]
	c := hoststate.Credentials{Version: 1, Origin: "https://example.test", RoomID: room, HostToken: token, Generation: 1}
	copy(c.HostSeed[:], bytes.Repeat([]byte{7}, 32))
	copy(c.EditSecret[:], bytes.Repeat([]byte{3}, 32))
	store, err := hoststate.Open(filepath.Join(t.TempDir(), "state"))
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	if err = store.Save(c); err != nil {
		t.Fatal(err)
	}
	client := &http.Client{Transport: testForward{target, room}}
	host, err := Open(store, room, client)
	if err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile("../../packages/testdata/kept-text-payload-vectors.json")
	if err != nil {
		t.Fatal(err)
	}
	var vector struct{ Payload string }
	if err = json.Unmarshal(data, &vector); err != nil {
		t.Fatal(err)
	}
	payload, err := base64.RawURLEncoding.DecodeString(vector.Payload)
	if err != nil {
		t.Fatal(err)
	}
	keys, private, err := c.Keys()
	if err != nil {
		t.Fatal(err)
	}
	var epoch [32]byte
	for i := range epoch {
		epoch[i] = 5
	}
	cp, err := protocol.SealKeptCheckpoint(keys, private, protocol.KeptCheckpointContext{RoomID: room, Epoch: epoch, Generation: 1}, payload)
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	bad := append([]byte(nil), cp...)
	bad[len(bad)-1] ^= 1
	if _, err := host.Initialize(ctx, epoch, bad, time.Hour); err == nil {
		t.Fatal("accepted altered checkpoint")
	}
	effective, err := host.Initialize(ctx, epoch, cp, 24*time.Hour)
	if err != nil || effective != time.Hour {
		t.Fatalf("initialize: %v %v", effective, err)
	}
	state := func(want string) {
		t.Helper()
		for i := 0; i < 100; i++ {
			req, _ := http.NewRequestWithContext(ctx, http.MethodGet, live+"/__test/state", nil)
			req.Header.Set("X-Test-Room", room)
			r, e := http.DefaultClient.Do(req)
			if e == nil {
				var v struct{ Host string }
				e = json.NewDecoder(r.Body).Decode(&v)
				r.Body.Close()
				if e == nil && v.Host == want {
					return
				}
			}
			time.Sleep(20 * time.Millisecond)
		}
		t.Fatalf("room did not become %s", want)
	}
	state("away")
	for i := 0; i < 70; i++ {
		if _, err := host.Inspect(ctx, &protocol.KeptReadAnchor{}); err == nil {
			t.Fatal("mismatched read anchor accepted")
		}
	}
	inspection, err := host.Inspect(ctx, nil)
	if err != nil || inspection.Snapshot.Generation != 1 || len(inspection.Records) != 0 {
		t.Fatalf("read: %#v %v", inspection, err)
	}
	socket, err := host.Connect(ctx)
	if err != nil {
		t.Fatal(err)
	}
	state("connected")
	if err = socket.Close(websocket.StatusNormalClosure, ""); err != nil {
		t.Fatal(err)
	}
	state("away")
	socket, err = host.Connect(ctx)
	if err != nil {
		t.Fatal(err)
	}
	state("connected")
	if err = host.CloseRoom(ctx); err != nil {
		t.Fatal(err)
	}
	state("closed")
	socket.CloseNow()
	if _, err = host.Connect(ctx); err == nil {
		t.Fatal("closed room reconnected")
	}
}
