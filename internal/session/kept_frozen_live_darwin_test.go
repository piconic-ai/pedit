//go:build darwin

package session

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/piconic-ai/pedit/internal/hoststate"
)

func testPending(ctx context.Context, endpoint, room, host string) (*observedFrozenCut, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint+"/__test/pending", nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("X-Test-Room", room)
	req.Header.Set("X-Test-Host", host)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		return nil, errors.New("pending request refused")
	}
	var cut *observedFrozenCut
	if json.NewDecoder(resp.Body).Decode(&cut) != nil {
		return nil, errors.New("invalid pending response")
	}
	return cut, nil
}

func TestFrozenObservationChild(t *testing.T) {
	dir := os.Getenv("PEDIT_FROZEN_STORE")
	if dir == "" {
		t.Skip("fresh process only")
	}
	room, endpoint := os.Getenv("PEDIT_FROZEN_ROOM"), os.Getenv("PEDIT_TEST_LIVE_ROOM")
	store, err := hoststate.Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	creds, err := store.Load(room)
	if err != nil {
		t.Fatal(err)
	}
	target, err := url.Parse(endpoint)
	if err != nil {
		t.Fatal(err)
	}
	client := &http.Client{Transport: initialForward{target: target}}
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	result, err := captureFrozenEvidence(ctx, store, room, client, func(c context.Context) (*observedFrozenCut, error) {
		return testPending(c, endpoint, room, creds.HostToken)
	})
	if err != nil || result.ObservationPath == "" || result.ReadPath == "" {
		t.Fatalf("observe: %v", err)
	}
	raw, err := json.Marshal(result)
	if err != nil {
		t.Fatal(err)
	}
	if err = os.WriteFile(filepath.Join(os.Getenv("PEDIT_FROZEN_RESULT"), "paths"), raw, 0600); err != nil {
		t.Fatal(err)
	}
}
