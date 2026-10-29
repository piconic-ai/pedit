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
	"testing"
	"time"

	"github.com/piconic-ai/pedit/internal/filewriter"
	"github.com/piconic-ai/pedit/internal/hoststate"
	"github.com/piconic-ai/pedit/internal/keptclient"
	"github.com/piconic-ai/pedit/internal/meta"
	"github.com/piconic-ai/pedit/internal/protocol"
	"github.com/reearth/ygo/crdt"
	ysync "github.com/reearth/ygo/sync"
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
	// Apply two authentic guest records after the host has disconnected.
	cp, err := protocol.DecodeKeptTextPayload(plain, protocol.MaxKeptCheckpointReceipts)
	if err != nil {
		t.Fatal(err)
	}
	doc := crdt.New()
	defer doc.Destroy()
	if err = crdt.ApplyUpdateV1(doc, cp.Documents[0], nil); err != nil {
		t.Fatal(err)
	}
	var textUpdate []byte
	doc.OnUpdate(func(u []byte, _ any) { textUpdate = bytes.Clone(u) })
	text := doc.GetText("content")
	doc.Transact(func(tx *crdt.Transaction) { text.Insert(tx, len("initial file"), " guest", nil) })
	comments := crdt.New()
	defer comments.Destroy()
	if err = crdt.ApplyUpdateV1(comments, cp.Documents[1], nil); err != nil {
		t.Fatal(err)
	}
	var commentsUpdate []byte
	comments.OnUpdate(func(u []byte, _ any) { commentsUpdate = bytes.Clone(u) })
	root := comments.GetMap(meta.CommentsKey)
	comments.Transact(func(tx *crdt.Transaction) {
		thread := crdt.NewMapPrelim()
		root.Set(tx, "c1", thread)
		thread.Set(tx, meta.QuoteKey, "guest quote")
	})
	payload, err := protocol.EncodeFileDoc(1, protocol.MessageSync, ysync.EncodeUpdate(commentsUpdate))
	if err != nil {
		t.Fatal(err)
	}
	messages := [][]byte{protocol.EncodeMessage(protocol.MessageSync, ysync.EncodeUpdate(textUpdate)), protocol.EncodeMessage(protocol.MessageFiles, payload)}
	sender := ed25519.NewKeyFromSeed(bytes.Repeat([]byte{11}, 32))
	cert, err := protocol.CreateKeptSenderCertificate(keys, sender.Public().(ed25519.PublicKey))
	if err != nil {
		t.Fatal(err)
	}
	records := make([]string, 0, len(messages))
	for i, message := range messages {
		frame, e := protocol.SealKeptRecord(keys, protocol.KeptRecordContext{RoomID: room, Epoch: record.Epoch, Generation: 1}, sender, cert, uint64(i+1), message)
		if e != nil {
			t.Fatal(e)
		}
		records = append(records, base64.StdEncoding.EncodeToString(frame))
	}
	body, err := json.Marshal(map[string]any{"token": keys.EditAdmission, "epoch": hex.EncodeToString(record.Epoch[:]), "records": records})
	if err != nil {
		t.Fatal(err)
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, live+"/__test/populate", bytes.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("X-Test-Room", room)
	response, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	response.Body.Close()
	if response.StatusCode != 204 {
		t.Fatalf("populate status %d", response.StatusCode)
	}
	external := "external edit"
	if err = os.WriteFile(file, []byte(external), 0600); err != nil {
		t.Fatal(err)
	}
	metadata := filepath.Join(dir, ".pedit", "meta", "notes.md.json")
	if err = os.MkdirAll(filepath.Dir(metadata), 0700); err != nil {
		t.Fatal(err)
	}
	localMeta := `{"version":1,"path":"notes.md","comments":{},"external":true}`
	if err = os.WriteFile(metadata, []byte(localMeta), 0600); err != nil {
		t.Fatal(err)
	}
	var retained string
	for i := 0; i < 2; i++ {
		if i == 1 {
			if err = store.Close(); err != nil {
				t.Fatal(err)
			}
			store, err = hoststate.Open(filepath.Join(dir, "state"))
			if err != nil {
				t.Fatal(err)
			}
			defer store.Close()
		}
		candidate, e := inspectKeptRecovery(ctx, store, room, client)
		if e != nil {
			t.Fatal(e)
		}
		if candidate.path == "" {
			t.Fatal("candidate was not durably retained")
		}
		if _, e = os.Stat(candidate.path); e != nil {
			t.Fatal(e)
		}
		retained = candidate.path
		local, recovered, diff, e := candidate.session.recoveryContents()
		if e != nil || local != external || recovered != "initial file guest" || !diff {
			t.Fatalf("held candidate %q %q %v %v", local, recovered, diff, e)
		}
		if candidate.tailStatus != "tail-unverified" || candidate.attachmentStatus != "attachments-unverified" {
			t.Fatal("unverified status lost")
		}
		item, ok := candidate.session.meta.doc.GetMap(meta.CommentsKey).Get("c1")
		if !ok {
			t.Fatal("guest comment missing")
		}
		quote, _ := item.(*crdt.YMap).Get(meta.QuoteKey)
		if quote != "guest quote" {
			t.Fatal("guest comment incorrect")
		}
		if e = candidate.session.Stop(); !errors.Is(e, filewriter.ErrRecoveryHeld) {
			t.Fatal(e)
		}
	}
	if err = host.CloseRoom(ctx); err != nil {
		t.Fatal(err)
	}
	reopened, e := openRecoveryExport(ctx, Options{File: file, Root: dir, Project: dir, Server: c.Origin}, store, room, retained)
	if e != nil {
		t.Fatal(e)
	}
	local, recovered, diff, e := reopened.session.recoveryContents()
	if e != nil || local != external || recovered != "initial file guest" || !diff {
		t.Fatalf("reopened candidate %q %q %v %v", local, recovered, diff, e)
	}
	if e = reopened.session.Stop(); !errors.Is(e, filewriter.ErrRecoveryHeld) {
		t.Fatalf("reopened hold: %v", e)
	}
	savedMeta, err := os.ReadFile(metadata)
	if err != nil || string(savedMeta) != localMeta {
		t.Fatalf("metadata changed: %q %v", savedMeta, err)
	}
	data, err := os.ReadFile(file)
	if err != nil || string(data) != external {
		t.Fatalf("file changed: %q %v", data, err)
	}
}
