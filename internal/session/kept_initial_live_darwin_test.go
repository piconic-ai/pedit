//go:build darwin

package session

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/piconic-ai/pedit/internal/hoststate"
	"github.com/piconic-ai/pedit/internal/keptclient"
	"github.com/piconic-ai/pedit/internal/protocol"
)

type initialForward struct {
	target *url.URL
	calls  *int
}

func (f initialForward) RoundTrip(r *http.Request) (*http.Response, error) {
	if f.calls != nil {
		*f.calls++
	}
	req := r.Clone(r.Context())
	u := *r.URL
	u.Scheme = f.target.Scheme
	u.Host = f.target.Host
	req.URL = &u
	req.Host = u.Host
	return http.DefaultTransport.RoundTrip(req)
}

func TestLiveKeptInitial(t *testing.T) {
	live := os.Getenv("PEDIT_TEST_LIVE_ROOM")
	if live == "" {
		t.Skip("requires test Worker")
	}
	target, err := url.Parse(live)
	if err != nil {
		t.Fatal(err)
	}
	dir := t.TempDir()
	file := filepath.Join(dir, "notes.md")
	if err = os.WriteFile(file, []byte("initial file"), 0600); err != nil {
		t.Fatal(err)
	}
	snapshot, err := captureKeptInitial(file, dir, protocol.KeptAttachmentsNone)
	if err != nil {
		t.Fatal(err)
	}
	defer snapshot.Close()
	store, err := hoststate.Open(filepath.Join(dir, "state"))
	if err != nil {
		t.Fatal(err)
	}
	token := base64.RawURLEncoding.EncodeToString(bytes.Repeat([]byte{26}, 32))
	digest := sha256.Sum256([]byte(token))
	room := base64.RawURLEncoding.EncodeToString(digest[:])[:22]
	c := hoststate.Credentials{Version: 1, Origin: "https://example.test", RoomID: room, HostToken: token, Generation: 1}
	c.EditSecret[0] = 3
	c.HostSeed[0] = 7
	saved, err := snapshot.persist(store, c)
	if err != nil {
		t.Fatal(err)
	}
	record, err := loadKeptInitial(saved)
	if err != nil {
		t.Fatal(err)
	}
	calls := 0
	client := &http.Client{Transport: initialForward{target: target, calls: &calls}}
	host, err := keptclient.Open(store, room, client)
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	keys, signer, err := saved.Keys()
	if err != nil {
		t.Fatal(err)
	}
	plain, err := protocol.OpenKeptCheckpoint(keys, protocol.KeptCheckpointContext{RoomID: room, Epoch: record.Epoch, Generation: 1}, record.Checkpoint)
	if err != nil {
		t.Fatal(err)
	}
	alternate, err := protocol.SealKeptCheckpoint(keys, signer, protocol.KeptCheckpointContext{RoomID: room, Epoch: record.Epoch, Generation: 1}, plain)
	if err != nil {
		t.Fatal(err)
	}
	if bytes.Equal(alternate, record.Checkpoint) {
		t.Fatal("expected fresh ciphertext")
	}
	before := calls
	if _, err = host.Initialize(ctx, record.Epoch, alternate, time.Hour); err == nil || calls != before {
		t.Fatal("different signed ciphertext reached relay")
	}
	otherEpoch := record.Epoch
	otherEpoch[0] ^= 1
	if _, err = host.Initialize(ctx, otherEpoch, record.Checkpoint, time.Hour); err == nil || calls != before {
		t.Fatal("different epoch reached relay")
	}
	effective, err := host.InitializeStored(ctx, 24*time.Hour)
	if err != nil || effective != time.Hour {
		t.Fatalf("initialize: %v %v", effective, err)
	}
	socket, err := host.Connect(ctx)
	if err != nil {
		t.Fatal(err)
	}
	socket.CloseNow()
	if err = store.Close(); err != nil {
		t.Fatal(err)
	}
	store, err = hoststate.Open(filepath.Join(dir, "state"))
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	saved, err = store.Load(room)
	if err != nil {
		t.Fatal(err)
	}
	record, err = loadKeptInitial(saved)
	if err != nil || record.Text != "initial file" {
		t.Fatalf("reload: %v", err)
	}
	host, err = keptclient.Open(store, room, client)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = host.Inspect(ctx, nil); err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(file)
	if err != nil || string(data) != "initial file" {
		t.Fatalf("file changed: %q %v", data, err)
	}
}
