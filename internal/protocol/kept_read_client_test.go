package protocol

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

type readFixture struct{ RoomID, HostToken, Fragment, Epoch, Record string }

func loadReadFixture(t *testing.T) (readFixture, KeptReadSnapshot, KeptReadPage, *KeptRoomKeys) {
	t.Helper()
	var v readFixture
	raw, err := os.ReadFile("../../packages/testdata/kept-read-interop.json")
	if err != nil {
		t.Fatal(err)
	}
	if err = json.Unmarshal(raw, &v); err != nil {
		t.Fatal(err)
	}
	var capture struct {
		Snapshot json.RawMessage `json:"snapshot"`
		Page     json.RawMessage `json:"page"`
	}
	raw, err = os.ReadFile("../../packages/testdata/kept-read-response.json")
	if err != nil {
		t.Fatal(err)
	}
	if err = json.Unmarshal(raw, &capture); err != nil {
		t.Fatal(err)
	}
	var snapshotWire, pageWire bytes.Buffer
	if err := json.Compact(&snapshotWire, capture.Snapshot); err != nil {
		t.Fatal(err)
	}
	if err := json.Compact(&pageWire, capture.Page); err != nil {
		t.Fatal(err)
	}
	snapshot, err := ParseKeptReadSnapshot(snapshotWire.Bytes())
	if err != nil {
		t.Fatal(err)
	}
	page, err := ParseKeptReadPage(pageWire.Bytes(), 0, 1)
	if err != nil {
		t.Fatal(err)
	}
	link, err := ParseKeptFragment(v.Fragment)
	if err != nil {
		t.Fatal(err)
	}
	keys, err := DeriveKeptRoomKeys(link, v.RoomID)
	if err != nil {
		t.Fatal(err)
	}
	return v, snapshot, page, keys
}
func TestReadKeptHostRetriesCursorAndKeepsFixedTail(t *testing.T) {
	v, snapshot, page, keys := loadReadFixture(t)
	e, err := hex.DecodeString(v.Epoch)
	if err != nil {
		t.Fatal(err)
	}
	var epoch [32]byte
	copy(epoch[:], e)
	sender := ed25519.NewKeyFromSeed(bytes.Repeat([]byte{11}, 32))
	cert, err := CreateKeptSenderCertificate(keys, sender.Public().(ed25519.PublicKey))
	if err != nil {
		t.Fatal(err)
	}
	sealed, err := SealKeptRecord(keys, KeptRecordContext{RoomID: v.RoomID, Epoch: epoch, Generation: 1}, sender, cert, 2, []byte("second"))
	if err != nil {
		t.Fatal(err)
	}
	next := "11111111-1111-4111-8111-111111111111"
	snapshot.Tail = 2
	page.Next = &next
	last := KeptReadPage{Entries: []KeptReadEntry{{Sequence: 2, Ciphertext: base64.StdEncoding.EncodeToString(sealed)}}, Next: nil}
	var mu sync.Mutex
	attempts := 0
	finishes := 0
	var cursors []string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/internal/kept/"+v.RoomID+"/read" || r.Header.Get("Authorization") != "Host "+v.HostToken {
			w.WriteHeader(403)
			return
		}
		if r.Method == "POST" {
			b, _ := json.Marshal(snapshot)
			w.Write(b)
			return
		}
		if r.Method == "DELETE" {
			finishes++
			w.WriteHeader(http.StatusNoContent)
			return
		}
		if r.Method != "GET" {
			t.Errorf("unexpected method %s", r.Method)
			w.WriteHeader(405)
			return
		}
		mu.Lock()
		defer mu.Unlock()
		c := r.Header.Get("X-Pedit-Read-Cursor")
		cursors = append(cursors, c)
		if r.Header.Get("X-Pedit-Read-Session") != snapshot.Session {
			w.WriteHeader(403)
			return
		}
		if c == snapshot.Cursor {
			attempts++
			if attempts == 1 {
				w.Header().Set("Content-Length", "1000")
				fmt.Fprint(w, "{")
				return
			}
			b, _ := json.Marshal(page)
			w.Write(b)
			return
		}
		if c == next {
			b, _ := json.Marshal(last)
			w.Write(b)
			return
		}
		w.WriteHeader(403)
	}))
	defer server.Close()
	client := *server.Client()
	got, err := ReadKeptHost(context.Background(), &client, server.URL, v.RoomID, v.HostToken, keys, nil)
	if err != nil {
		t.Fatal(err)
	}
	if got.Completeness != "tail-unverified" || got.Snapshot.Tail != 2 || len(got.Records) != 2 || got.Records[1].Sequence != 2 {
		t.Fatalf("unexpected result %#v", got)
	}
	if finishes != 1 {
		t.Fatalf("read session finished %d times", finishes)
	}
	if len(cursors) != 3 || cursors[0] != snapshot.Cursor || cursors[1] != snapshot.Cursor || cursors[2] != next {
		t.Fatalf("cursor retries %#v", cursors)
	}
}

func TestReadKeptHostRejectsDeniedInvalidAndRollback(t *testing.T) {
	v, snapshot, page, keys := loadReadFixture(t)
	for _, mode := range []string{"unauthorized", "bad-checkpoint", "bad-record", "unsupported-payload", "ledger-gap", "rollback", "redirect"} {
		t.Run(mode, func(t *testing.T) {
			current := snapshot
			recordPage := page
			anchor := (*KeptReadAnchor)(nil)
			if mode == "bad-checkpoint" {
				current.Ciphertext = base64.StdEncoding.EncodeToString([]byte("bad"))
			}
			if mode == "bad-record" {
				recordPage.Entries[0].Ciphertext = base64.StdEncoding.EncodeToString([]byte("bad"))
			}
			if mode == "unsupported-payload" || mode == "ledger-gap" {
				e, _ := hex.DecodeString(v.Epoch)
				var epoch [32]byte
				copy(epoch[:], e)
				if mode == "unsupported-payload" {
					host := ed25519.NewKeyFromSeed(bytes.Repeat([]byte{7}, 32))
					sealed, err := SealKeptCheckpoint(keys, host, KeptCheckpointContext{RoomID: v.RoomID, Epoch: epoch, Generation: 1, Cutoff: 0}, []byte("unknown format"))
					if err != nil {
						t.Fatal(err)
					}
					current.Ciphertext = base64.StdEncoding.EncodeToString(sealed)
				} else {
					sender := ed25519.NewKeyFromSeed(bytes.Repeat([]byte{11}, 32))
					cert, err := CreateKeptSenderCertificate(keys, sender.Public().(ed25519.PublicKey))
					if err != nil {
						t.Fatal(err)
					}
					sealed, err := SealKeptRecord(keys, KeptRecordContext{RoomID: v.RoomID, Epoch: epoch, Generation: 1}, sender, cert, 2, []byte("gap"))
					if err != nil {
						t.Fatal(err)
					}
					recordPage.Entries[0].Ciphertext = base64.StdEncoding.EncodeToString(sealed)
				}
			}
			if mode == "rollback" {
				anchor = &KeptReadAnchor{Epoch: snapshot.Epoch, Generation: snapshot.Generation, Cutoff: snapshot.Cutoff, Tail: snapshot.Tail + 1, Ciphertext: snapshot.Ciphertext}
			}
			var methods []string
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				methods = append(methods, r.Method)
				if mode == "unauthorized" {
					w.WriteHeader(http.StatusForbidden)
					return
				}
				if mode == "redirect" {
					http.Redirect(w, r, "https://invalid.example/", http.StatusFound)
					return
				}
				if r.Method == "DELETE" {
					w.WriteHeader(http.StatusNoContent)
					return
				}
				if r.Method == "POST" {
					b, _ := json.Marshal(current)
					w.Write(b)
					return
				}
				if r.Method == "GET" {
					b, _ := json.Marshal(recordPage)
					w.Write(b)
					return
				}
				t.Errorf("unexpected method %s", r.Method)
			}))
			defer server.Close()
			result, err := ReadKeptHost(context.Background(), server.Client(), server.URL, v.RoomID, v.HostToken, keys, anchor)
			if err == nil {
				t.Fatal("accepted invalid response")
			}
			if len(result.Records) != 0 || result.Completeness != "" {
				t.Fatal("returned partial success")
			}
			for _, method := range methods {
				if method != "POST" && method != "GET" && method != "DELETE" {
					t.Fatalf("mutating method %s", method)
				}
			}
		})
	}
}

func TestReadKeptHostDoesNotReturnCandidateWhenFinishFails(t *testing.T) {
	v, snapshot, page, keys := loadReadFixture(t)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == "DELETE" {
			w.WriteHeader(http.StatusServiceUnavailable)
			return
		}
		var value any = snapshot
		if r.Method == "GET" {
			value = page
		}
		b, _ := json.Marshal(value)
		w.Write(b)
	}))
	defer server.Close()
	got, err := ReadKeptHost(context.Background(), server.Client(), server.URL, v.RoomID, v.HostToken, keys, nil)
	if err == nil || len(got.Frames) != 0 {
		t.Fatal("returned a read after finish failed")
	}
}

func TestReadKeptHostCancelsFailedSessions(t *testing.T) {
	v, snapshot, _, keys := loadReadFixture(t)
	for _, mode := range []string{"bad-snapshot", "anchor-mismatch", "page-failure", "cancelled-context"} {
		t.Run(mode, func(t *testing.T) {
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			calls := 0
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.Method == "DELETE" {
					calls++
					if r.Header.Get("Authorization") != "Host "+v.HostToken || r.Header.Get("X-Pedit-Read-Session") != snapshot.Session || r.Header.Get("X-Pedit-Read-Cursor") != "" {
						t.Error("invalid cancellation credentials")
					}
					w.WriteHeader(http.StatusNoContent)
					return
				}
				if r.Method == "GET" {
					if mode == "cancelled-context" {
						cancel()
					}
					w.WriteHeader(500)
					return
				}
				current := snapshot
				if mode == "bad-snapshot" {
					current.Generation = 0
				}
				b, _ := json.Marshal(current)
				w.Write(b)
			}))
			defer server.Close()
			var anchor *KeptReadAnchor
			if mode == "anchor-mismatch" {
				anchor = &KeptReadAnchor{Epoch: snapshot.Epoch, Generation: snapshot.Generation + 1, Cutoff: snapshot.Cutoff, Ciphertext: snapshot.Ciphertext}
			}
			if _, err := ReadKeptHost(ctx, server.Client(), server.URL, v.RoomID, v.HostToken, keys, anchor); err == nil {
				t.Fatal("invalid read accepted")
			}
			if calls != 1 {
				t.Fatalf("got %d cancellation requests", calls)
			}
		})
	}
}

func TestReadKeptHostCancellationIsBounded(t *testing.T) {
	v, snapshot, _, keys := loadReadFixture(t)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == "DELETE" {
			<-r.Context().Done()
			return
		}
		b, _ := json.Marshal(snapshot)
		w.Write(b)
	}))
	defer server.Close()
	anchor := KeptReadAnchor{Epoch: snapshot.Epoch, Generation: snapshot.Generation + 1, Cutoff: snapshot.Cutoff, Ciphertext: snapshot.Ciphertext}
	start := time.Now()
	if _, err := ReadKeptHost(context.Background(), server.Client(), server.URL, v.RoomID, v.HostToken, keys, &anchor); err == nil {
		t.Fatal("anchor accepted")
	}
	if time.Since(start) > 3*time.Second {
		t.Fatal("cancellation stalled recovery")
	}
}

func TestReadSessionIDRequiresUnambiguousJSON(t *testing.T) {
	session := "11111111-1111-4111-8111-111111111111"
	for _, input := range []string{`{"session":"` + session + `","session":"` + session + `"}`, `{"session":"` + session + `"} garbage`, `{"session":"bad"}`} {
		if readSessionID([]byte(input)) != "" {
			t.Fatal("ambiguous session accepted")
		}
	}
}

func TestReadKeptHostBoundsFinishAndCancels(t *testing.T) {
	v, snapshot, page, keys := loadReadFixture(t)
	var cancelled atomic.Bool
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == "DELETE" {
			if r.Header.Get("X-Pedit-Read-Cursor") != "" {
				<-r.Context().Done()
				return
			}
			cancelled.Store(true)
			w.WriteHeader(http.StatusNoContent)
			return
		}
		var value any = snapshot
		if r.Method == "GET" {
			value = page
		}
		b, _ := json.Marshal(value)
		w.Write(b)
	}))
	defer server.Close()
	start := time.Now()
	if _, err := ReadKeptHost(context.Background(), server.Client(), server.URL, v.RoomID, v.HostToken, keys, nil); err == nil {
		t.Fatal("stalled finish accepted")
	}
	if !cancelled.Load() {
		t.Fatal("failed finish did not cancel")
	}
	if time.Since(start) > 3*time.Second {
		t.Fatal("finish stalled recovery")
	}
}

type readRoundTripFunc func(*http.Request) (*http.Response, error)

func (f readRoundTripFunc) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }

func TestFetchKeptReadDoesNotRetryRefusal(t *testing.T) {
	calls := 0
	client := &http.Client{Transport: readRoundTripFunc(func(r *http.Request) (*http.Response, error) {
		calls++
		return &http.Response{StatusCode: http.StatusForbidden, Body: io.NopCloser(strings.NewReader("")), Header: make(http.Header)}, nil
	})}
	base, err := url.Parse("https://example.test/read")
	if err != nil {
		t.Fatal(err)
	}
	_, err = fetchKeptRead(client, base, "token", context.Background(), http.MethodGet, "session", "cursor", true)
	if err == nil || calls != 1 {
		t.Fatalf("refusal: error %v, calls %d", err, calls)
	}
}
