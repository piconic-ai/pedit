//go:build darwin

package keptclient

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"errors"
	"io"
	"net/http"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/piconic-ai/pedit/internal/hoststate"
)

type roundTripFunc func(*http.Request) (*http.Response, error)

func (f roundTripFunc) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }

func TestCloseDoesNotFollowRedirectOrExposeToken(t *testing.T) {
	token := base64.RawURLEncoding.EncodeToString(bytes.Repeat([]byte{9}, 32))
	hash := sha256.Sum256([]byte(token))
	room := base64.RawURLEncoding.EncodeToString(hash[:])[:22]
	credentials := hoststate.Credentials{Version: 1, Origin: "https://example.test", RoomID: room, HostToken: token, Generation: 1}
	credentials.HostSeed[0] = 1
	credentials.EditSecret[0] = 1
	store, err := hoststate.Open(filepath.Join(t.TempDir(), "state"))
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	if err = store.Save(credentials); err != nil {
		t.Fatal(err)
	}
	calls := 0
	client := &http.Client{Transport: roundTripFunc(func(r *http.Request) (*http.Response, error) {
		calls++
		if r.URL.Host != "example.test" || r.Header.Get("Authorization") != "Host "+token {
			t.Fatal("wrong request")
		}
		return &http.Response{StatusCode: http.StatusFound, Header: http.Header{"Location": []string{"https://attacker.test/"}}, Body: io.NopCloser(strings.NewReader("")), Request: r}, nil
	})}
	host, err := Open(store, room, client)
	if err != nil {
		t.Fatal(err)
	}
	err = host.CloseRoom(context.Background())
	if err == nil || strings.Contains(err.Error(), token) || calls != 1 {
		t.Fatalf("redirect: calls=%d err=%v", calls, err)
	}
}

func TestInitializeStoredRequiresBaselineBeforeNetwork(t *testing.T) {
	token := base64.RawURLEncoding.EncodeToString(bytes.Repeat([]byte{29}, 32))
	hash := sha256.Sum256([]byte(token))
	room := base64.RawURLEncoding.EncodeToString(hash[:])[:22]
	c := hoststate.Credentials{Version: 1, Origin: "https://example.test", RoomID: room, HostToken: token, Generation: 1}
	c.HostSeed[0] = 1
	c.EditSecret[0] = 1
	store, err := hoststate.Open(filepath.Join(t.TempDir(), "state"))
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	if err = store.Save(c); err != nil {
		t.Fatal(err)
	}
	calls := 0
	client := &http.Client{Transport: roundTripFunc(func(*http.Request) (*http.Response, error) { calls++; return nil, errors.New("unexpected request") })}
	host, err := Open(store, room, client)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = host.InitializeStored(context.Background(), time.Hour); err == nil || calls != 0 {
		t.Fatalf("missing baseline: %v, calls %d", err, calls)
	}
}
