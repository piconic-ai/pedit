//go:build darwin

package session

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/piconic-ai/pedit/internal/hoststate"
	"github.com/piconic-ai/pedit/internal/keptclient"
	"github.com/piconic-ai/pedit/internal/meta"
	"github.com/piconic-ai/pedit/internal/protocol"
	"github.com/reearth/ygo/crdt"
	ysync "github.com/reearth/ygo/sync"
)

type observerRoundTrip func(*http.Request) (*http.Response, error)

func (f observerRoundTrip) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }

func TestLiveKeptHostObserver(t *testing.T) {
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
	if err = os.WriteFile(file, []byte("base"), 0600); err != nil {
		t.Fatal(err)
	}
	initial, err := captureKeptInitial(file, dir, protocol.KeptAttachmentsNone)
	if err != nil {
		t.Fatal(err)
	}
	defer initial.Close()
	statePath := filepath.Join(t.TempDir(), "state")
	store, err := hoststate.Open(statePath)
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	token := base64.RawURLEncoding.EncodeToString(bytes.Repeat([]byte{44}, 32))
	sum := sha256.Sum256([]byte(token))
	room := base64.RawURLEncoding.EncodeToString(sum[:])[:22]
	c := hoststate.Credentials{Version: 1, Origin: "https://example.test", RoomID: room, HostToken: token, Generation: 1}
	c.EditSecret[0] = 3
	c.HostSeed[0] = 7
	c, err = initial.persist(store, c)
	if err != nil {
		t.Fatal(err)
	}
	record, err := loadKeptInitial(c)
	if err != nil {
		t.Fatal(err)
	}
	keys, _, err := c.Keys()
	if err != nil {
		t.Fatal(err)
	}
	plain, err := protocol.OpenKeptCheckpoint(keys, protocol.KeptCheckpointContext{RoomID: room, Epoch: record.Epoch, Generation: 1}, record.Checkpoint)
	if err != nil {
		t.Fatal(err)
	}
	cp, err := protocol.DecodeKeptTextPayload(plain, protocol.MaxKeptCheckpointReceipts)
	if err != nil {
		t.Fatal(err)
	}
	guest := crdt.New()
	defer guest.Destroy()
	if err = crdt.ApplyUpdateV1(guest, cp.Documents[0], nil); err != nil {
		t.Fatal(err)
	}
	text := guest.GetText("content")
	var updates [][]byte
	guest.OnUpdate(func(b []byte, _ any) { updates = append(updates, bytes.Clone(b)) })
	guest.Transact(func(tx *crdt.Transaction) { text.Insert(tx, 4, " one", nil) })
	guest.Transact(func(tx *crdt.Transaction) { text.Insert(tx, 8, " two", nil) })
	comments := crdt.New()
	defer comments.Destroy()
	if err = crdt.ApplyUpdateV1(comments, cp.Documents[1], nil); err != nil {
		t.Fatal(err)
	}
	root := comments.GetMap(meta.CommentsKey)
	var commentUpdate []byte
	comments.OnUpdate(func(b []byte, _ any) { commentUpdate = bytes.Clone(b) })
	comments.Transact(func(tx *crdt.Transaction) {
		thread := crdt.NewMapPrelim()
		root.Set(tx, "c1", thread)
		thread.Set(tx, meta.QuoteKey, "comment")
	})
	fileUpdate, err := protocol.EncodeFileDoc(1, protocol.MessageSync, ysync.EncodeUpdate(commentUpdate))
	if err != nil {
		t.Fatal(err)
	}
	messages := [][]byte{protocol.EncodeMessage(protocol.MessageSync, ysync.EncodeUpdate(updates[0])), protocol.EncodeMessage(protocol.MessageSync, ysync.EncodeUpdate(updates[1])), protocol.EncodeMessage(protocol.MessageFiles, fileUpdate), protocol.EncodeMessage(protocol.MessageSync, []byte{255})}
	sender := ed25519.NewKeyFromSeed(bytes.Repeat([]byte{11}, 32))
	cert, err := protocol.CreateKeptSenderCertificate(keys, sender.Public().(ed25519.PublicKey))
	if err != nil {
		t.Fatal(err)
	}
	frames := make([]string, len(messages))
	for i, m := range messages {
		frame, e := protocol.SealKeptRecord(keys, protocol.KeptRecordContext{RoomID: room, Epoch: record.Epoch, Generation: 1}, sender, cert, uint64(i+1), m)
		if e != nil {
			t.Fatal(e)
		}
		frames[i] = base64.StdEncoding.EncodeToString(frame)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	appendFrames := func(items ...string) error {
		body, e := json.Marshal(map[string]any{"token": keys.EditAdmission, "epoch": hex.EncodeToString(record.Epoch[:]), "records": items})
		if e != nil {
			return e
		}
		req, e := http.NewRequestWithContext(ctx, http.MethodPost, live+"/__test/populate", bytes.NewReader(body))
		if e != nil {
			return e
		}
		req.Header.Set("X-Test-Room", room)
		response, e := http.DefaultClient.Do(req)
		if e != nil {
			return e
		}
		response.Body.Close()
		if response.StatusCode != 204 {
			return errors.New("append failed")
		}
		return nil
	}
	forward := initialForward{target: target}
	inject := false
	var v5Calls atomic.Int32
	client := &http.Client{Transport: observerRoundTrip(func(r *http.Request) (*http.Response, error) {
		if strings.HasPrefix(r.URL.Path, "/api/rooms") {
			v5Calls.Add(1)
		}
		response, e := forward.RoundTrip(r)
		if e == nil && inject && r.Method == http.MethodPost && r.URL.Path == "/internal/kept/"+room+"/read" {
			inject = false
			if e = appendFrames(frames[1], frames[2]); e != nil {
				response.Body.Close()
				return nil, e
			}
		}
		return response, e
	})}
	host, err := keptclient.Open(store, room, client)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = host.InitializeStored(ctx, time.Hour); err != nil {
		t.Fatal(err)
	}
	observer, err := newKeptHostObserver(store, room, client)
	if err != nil {
		t.Fatal(err)
	}
	defer observer.Disconnect()
	original := observer.Snapshot()
	baseDoc := crdt.New()
	defer baseDoc.Destroy()
	if err = crdt.ApplyUpdateV1(baseDoc, original.text, nil); err != nil {
		t.Fatal(err)
	}
	if !equalStateVector(baseDoc.StateVector(), guestStateBefore(t, cp.Documents[0])) {
		t.Fatal("initial Yjs identity changed")
	}
	if err = observer.Connect(ctx); err != nil {
		t.Fatal(err)
	}
	if err = observer.Refresh(ctx); err != nil {
		t.Fatal(err)
	}
	var group sync.WaitGroup
	group.Add(2)
	go func() { defer group.Done(); _ = observer.Disconnect() }()
	go func() { defer group.Done(); _ = observer.Connect(ctx) }()
	group.Wait()
	observer.mu.Lock()
	connected := observer.socket != nil
	observer.mu.Unlock()
	if !connected {
		if err = observer.Connect(ctx); err != nil {
			t.Fatal(err)
		}
	}
	if err = observer.Refresh(ctx); err != nil {
		t.Fatal(err)
	}
	if err = os.WriteFile(file, []byte("local external"), 0600); err != nil {
		t.Fatal(err)
	}
	if err = appendFrames(frames[0]); err != nil {
		t.Fatal(err)
	}
	inject = true
	if err = observer.Refresh(ctx); err != nil {
		t.Fatal(err)
	}
	assertObservedText(t, observer.Snapshot(), "base one", 1)
	if err = observer.Refresh(ctx); err != nil {
		t.Fatal(err)
	}
	current := observer.Snapshot()
	assertObservedText(t, current, "base one two", 3)
	if len(current.receipts) != 3 {
		t.Fatal("guest ledger receipts missing")
	}
	copyState := observer.Snapshot()
	copyState.text[0] ^= 1
	copyState.comments[0] ^= 1
	copyState.receipts[0].Sequence = 999
	again := observer.Snapshot()
	if !bytes.Equal(again.text, current.text) || !bytes.Equal(again.comments, current.comments) || again.receipts[0].Sequence != current.receipts[0].Sequence {
		t.Fatal("snapshot aliases observer state")
	}

	metaDoc := crdt.New()
	defer metaDoc.Destroy()
	if err = crdt.ApplyUpdateV1(metaDoc, current.comments, nil); err != nil {
		t.Fatal(err)
	}
	if _, ok := metaDoc.GetMap(meta.CommentsKey).Get("c1"); !ok {
		t.Fatal("comment missing")
	}
	if err = observer.Disconnect(); err != nil {
		t.Fatal(err)
	}
	if err = observer.Refresh(ctx); err == nil {
		t.Fatal("read while disconnected")
	}
	if err = observer.Connect(ctx); err != nil {
		t.Fatal(err)
	}
	if err = observer.Refresh(ctx); err != nil {
		t.Fatal(err)
	}
	if err = observer.Disconnect(); err != nil {
		t.Fatal(err)
	}
	if err = store.Close(); err != nil {
		t.Fatal(err)
	}
	store, err = hoststate.Open(statePath)
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	observer, err = newKeptHostObserver(store, room, client)
	if err != nil {
		t.Fatal(err)
	}
	defer observer.Disconnect()
	if err = observer.Connect(ctx); err != nil {
		t.Fatal(err)
	}
	if err = observer.Refresh(ctx); err != nil {
		t.Fatal(err)
	}
	assertObservedText(t, observer.Snapshot(), "base one two", 3)
	before := observer.Snapshot()
	if err = appendFrames(frames[3]); err != nil {
		t.Fatal(err)
	}
	if err = observer.Refresh(ctx); err == nil {
		t.Fatal("accepted invalid update")
	}
	after := observer.Snapshot()
	if before.tail != after.tail || !bytes.Equal(before.text, after.text) || !bytes.Equal(before.comments, after.comments) || len(before.receipts) != len(after.receipts) {
		t.Fatal("invalid update changed candidate")
	}
	if err = observer.Disconnect(); err != nil {
		t.Fatal(err)
	}
	if err = store.Close(); err != nil {
		t.Fatal(err)
	}
	store, err = hoststate.Open(statePath)
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	observer, err = newKeptHostObserver(store, room, client)
	if err != nil {
		t.Fatal(err)
	}
	defer observer.Disconnect()
	afterRestart := observer.Snapshot()
	if afterRestart.tail != before.tail || !bytes.Equal(afterRestart.text, before.text) || !bytes.Equal(afterRestart.comments, before.comments) {
		t.Fatal("last valid candidate lost on restart")
	}
	if err = observer.Connect(ctx); err != nil {
		t.Fatal(err)
	}
	if err = observer.Refresh(ctx); err == nil {
		t.Fatal("accepted invalid tail after restart")
	}
	if !bytes.Equal(observer.Snapshot().text, before.text) {
		t.Fatal("invalid tail replaced restored candidate")
	}
	rawEvidence, err := store.LoadObserver(room)
	if err != nil {
		t.Fatal(err)
	}
	damaged := bytes.Clone(rawEvidence)
	damaged[len(damaged)/2] ^= 1
	if err = store.SaveObserver(room, rawEvidence, damaged); err != nil {
		t.Fatal(err)
	}
	if _, err = newKeptHostObserver(store, room, client); err == nil {
		t.Fatal("accepted damaged evidence")
	}
	if err = store.SaveObserver(room, damaged, rawEvidence); err != nil {
		t.Fatal(err)
	}
	if err = host.CloseRoom(ctx); err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(3 * time.Second)
	for {
		observer.mu.Lock()
		connected := observer.socket != nil
		observer.mu.Unlock()
		if !connected {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("remote close did not release presence socket")
		}
		time.Sleep(10 * time.Millisecond)
	}
	if err = observer.Connect(ctx); err == nil {
		t.Fatal("reconnected a closed room")
	}
	if v5Calls.Load() != 0 {
		t.Fatal("observer contacted v5 route")
	}
	disk, err := os.ReadFile(file)
	if err != nil || string(disk) != "local external" {
		t.Fatalf("source changed: %q %v", disk, err)
	}
}

func assertObservedText(t *testing.T, state keptObservedState, want string, tail uint64) {
	t.Helper()
	doc := crdt.New()
	defer doc.Destroy()
	if err := crdt.ApplyUpdateV1(doc, state.text, nil); err != nil {
		t.Fatal(err)
	}
	if got := doc.GetText("content").ToString(); got != want || state.tail != tail || state.tailStatus != "tail-unverified" || state.attachmentStatus != "attachments-unverified" {
		t.Fatalf("observed %q tail %d", got, state.tail)
	}
}
func guestStateBefore(t *testing.T, update []byte) map[crdt.ClientID]uint64 {
	t.Helper()
	doc := crdt.New()
	defer doc.Destroy()
	if err := crdt.ApplyUpdateV1(doc, update, nil); err != nil {
		t.Fatal(err)
	}
	return doc.StateVector()
}
func equalStateVector(a, b map[crdt.ClientID]uint64) bool {
	if len(a) != len(b) {
		return false
	}
	for k, v := range a {
		if b[k] != v {
			return false
		}
	}
	return true
}
