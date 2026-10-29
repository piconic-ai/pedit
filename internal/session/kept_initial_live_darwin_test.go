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
	"os/exec"
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
	stateDir := filepath.Join(t.TempDir(), "state")
	store, err := hoststate.Open(stateDir)
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
	store, err = hoststate.Open(stateDir)
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
	evidencePath, err := captureReadEvidence(ctx, store, room, client)
	if err != nil {
		t.Fatal(err)
	}
	evidence, err := openReadEvidence(store, room, evidencePath)
	if err != nil {
		t.Fatal(err)
	}
	if evidence.TailStatus != "unverified" || len(evidence.Entries) != 2 || evidence.Entries[0].Sequence >= evidence.Entries[1].Sequence {
		t.Fatal("wrong observed tail evidence")
	}
	artifacts, err := publishRecoveryBundle(store, room, evidencePath)
	if err != nil {
		t.Fatal(err)
	}
	bundle, err := openRecoveryBundle(store, room, artifacts.Manifest)
	if err != nil || string(bundle.Text) != "initial file guest" || !bytes.Contains(bundle.Comments, []byte("guest quote")) || bundle.TailStatus != "unverified" || bundle.AttachmentStatus != "unverified" || bundle.CommentsFormat != "inspection-json" || bundle.TextPath != artifacts.Text || bundle.CommentsPath != artifacts.Comments || bundle.EvidencePath != evidencePath {
		t.Fatal("invalid recovery bundle", err)
	}
	intentPaths, err := prepareRecoveryIntent(store, room, artifacts.Manifest)
	if err != nil {
		t.Fatal(err)
	}
	intentView, err := openRecoveryIntent(store, room, intentPaths.IntentPath)
	if err != nil || string(intentView.NewText) != "initial file guest" || intentView.MetadataStatus != "not-generated" {
		t.Fatal("live recovery intent", err)
	}
	if err = store.Close(); err != nil {
		t.Fatal(err)
	}
	intentChild := exec.Command(os.Args[0], "-test.run=^TestLiveRecoveryIntentChild$")
	intentChild.Env = append(os.Environ(), "PEDIT_LIVE_INTENT_STORE="+stateDir, "PEDIT_LIVE_INTENT_ROOM="+room, "PEDIT_LIVE_INTENT_PATH="+intentPaths.IntentPath)
	if output, e := intentChild.CombinedOutput(); e != nil {
		t.Fatalf("live intent restart: %v %s", e, output)
	}
	store, err = hoststate.Open(stateDir)
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	currentHost, err := keptclient.Open(store, room, client)
	if err != nil {
		t.Fatal(err)
	}
	currentRead, err := currentHost.Inspect(ctx, nil)
	if err != nil || len(currentRead.Records) != 2 {
		t.Fatalf("intent changed relay records: %v", err)
	}
	if data, e := os.ReadFile(file); e != nil || string(data) != "initial file" {
		t.Fatal("intent changed source", e)
	}
	for _, path := range []string{artifacts.Evidence, artifacts.Text, artifacts.Comments, artifacts.Manifest} {
		original, e := os.ReadFile(path)
		if e != nil {
			t.Fatal(e)
		}
		if e = os.WriteFile(path, append(bytes.Clone(original), 'x'), 0600); e != nil {
			t.Fatal(e)
		}
		if _, e = openRecoveryBundle(store, room, artifacts.Manifest); e == nil {
			t.Fatalf("accepted altered artifact %s", path)
		}
		if e = os.WriteFile(path, original, 0600); e != nil {
			t.Fatal(e)
		}
	}
	if err = os.Rename(artifacts.Text, artifacts.Text+".missing"); err != nil {
		t.Fatal(err)
	}
	if _, err = openRecoveryBundle(store, room, artifacts.Manifest); err == nil {
		t.Fatal("accepted missing text")
	}
	if err = os.Rename(artifacts.Text+".missing", artifacts.Text); err != nil {
		t.Fatal(err)
	}
	signAndReject := func(changed recoveryEvidence) {
		t.Helper()
		message, e := evidenceMessage(changed)
		if e != nil {
			t.Fatal(e)
		}
		changed.Signature = ed25519.Sign(signer, message)
		raw, e := json.Marshal(changed)
		if e != nil {
			t.Fatal(e)
		}
		if _, e = verifyReadEvidence(saved, raw); e == nil {
			t.Fatal("accepted inconsistent signed evidence")
		}
	}
	badSignature := evidence
	badSignature.Signature = bytes.Clone(badSignature.Signature)
	badSignature.Signature[0] ^= 1
	rawBad, err := json.Marshal(badSignature)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = verifyReadEvidence(saved, rawBad); err == nil {
		t.Fatal("accepted bad evidence signature")
	}
	altered := evidence
	altered.Text = bytes.Clone(altered.Text)
	altered.Text[len(altered.Text)-1] ^= 1
	signAndReject(altered)
	altered = evidence
	altered.Ledger = bytes.Clone(altered.Ledger)
	altered.Ledger[len(altered.Ledger)-1] ^= 1
	signAndReject(altered)
	altered = evidence
	altered.Tail++
	signAndReject(altered)
	altered = evidence
	altered.Entries = append([]evidenceEntry(nil), altered.Entries...)
	altered.Entries[0].Ciphertext = bytes.Clone(altered.Entries[0].Ciphertext)
	altered.Entries[0].Ciphertext[0] ^= 1
	signAndReject(altered)
	// The freeze response is deliberately discarded. A fresh host process
	// recovers the pending cut and records only a historical observation.
	freezeReq, err := http.NewRequestWithContext(ctx, http.MethodPost, live+"/__test/freeze", nil)
	if err != nil {
		t.Fatal(err)
	}
	freezeReq.Header.Set("X-Test-Room", room)
	freezeReq.Header.Set("X-Test-Host", token)
	freezeReq.Header.Set("X-Test-Epoch", hex.EncodeToString(record.Epoch[:]))
	freezeResp, err := http.DefaultClient.Do(freezeReq)
	if err != nil {
		t.Fatal(err)
	}
	freezeResp.Body.Close()
	if freezeResp.StatusCode != 200 {
		t.Fatalf("freeze: %d", freezeResp.StatusCode)
	}
	if _, e := testPending(ctx, live, room, keys.EditAdmission); e == nil {
		t.Fatal("non-host inspected pending cut")
	}
	appendReq, err := http.NewRequestWithContext(ctx, http.MethodPost, live+"/internal/kept/"+room+"/append", bytes.NewReader([]byte{1}))
	if err != nil {
		t.Fatal(err)
	}
	appendReq.Header.Set("Authorization", "Bearer "+keys.EditAdmission)
	appendReq.Header.Set("X-Pedit-Epoch", hex.EncodeToString(record.Epoch[:]))
	appendResp, err := http.DefaultClient.Do(appendReq)
	if err != nil {
		t.Fatal(err)
	}
	appendResp.Body.Close()
	if appendResp.StatusCode != 403 {
		t.Fatalf("frozen append: %d", appendResp.StatusCode)
	}
	if err = store.Close(); err != nil {
		t.Fatal(err)
	}
	resultDir := t.TempDir()
	freezeChild := exec.Command(os.Args[0], "-test.run=^TestFrozenObservationChild$")
	freezeChild.Env = append(os.Environ(), "PEDIT_FROZEN_STORE="+stateDir, "PEDIT_FROZEN_ROOM="+room, "PEDIT_FROZEN_RESULT="+resultDir, "PEDIT_TEST_LIVE_ROOM="+live)
	if output, e := freezeChild.CombinedOutput(); e != nil {
		t.Fatalf("frozen observation process: %v %s", e, output)
	}
	store, err = hoststate.Open(stateDir)
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	pathBytes, err := os.ReadFile(filepath.Join(resultDir, "paths"))
	if err != nil {
		t.Fatal(err)
	}
	var frozen frozenCapture
	if err = json.Unmarshal(pathBytes, &frozen); err != nil {
		t.Fatal(err)
	}
	observed, err := openFrozenEvidence(store, room, frozen.ObservationPath)
	if err != nil || observed.Status != "observed-not-complete" || observed.Cut.Cutoff != 2 {
		t.Fatalf("frozen observation: %v", err)
	}
	assertFrozenRejected := func(bad frozenEvidence) {
		t.Helper()
		msg, e := frozenMessage(bad)
		if e != nil {
			t.Fatal(e)
		}
		bad.Signature = ed25519.Sign(signer, msg)
		raw, e := json.Marshal(bad)
		if e != nil {
			t.Fatal(e)
		}
		path, e := store.PublishCandidate(room, raw)
		if e != nil {
			t.Fatal(e)
		}
		if _, e = openFrozenEvidence(store, room, path); e == nil {
			t.Fatal("accepted inconsistent frozen observation")
		}
	}
	wrongCut := observed
	wrongCut.Cut.Cutoff++
	assertFrozenRejected(wrongCut)
	wrongHash := observed
	wrongHash.EvidenceHash[0] ^= 1
	assertFrozenRejected(wrongHash)
	wrongStatus := observed
	wrongStatus.Status = "complete"
	assertFrozenRejected(wrongStatus)
	callsPending := 0
	failed, err := captureFrozenEvidence(ctx, store, room, client, func(c context.Context) (*observedFrozenCut, error) {
		cut, e := testPending(c, live, room, token)
		callsPending++
		if e == nil && callsPending == 2 {
			cut.Token = "00000000-0000-4000-8000-000000000000"
		}
		return cut, e
	})
	if err == nil || failed.ReadPath == "" || failed.ObservationPath != "" {
		t.Fatal("accepted changed pending cut")
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
			store, err = hoststate.Open(stateDir)
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
	if err = os.Remove(file); err != nil {
		t.Fatal(err)
	}
	missing, e := inspectKeptRecovery(ctx, store, room, client)
	if e != nil {
		t.Fatal(e)
	}
	if missing.path == "" || missing.session.Text.ToString() != "initial file guest" {
		t.Fatal("missing-file candidate unavailable")
	}
	if e = missing.session.Stop(); !errors.Is(e, filewriter.ErrRecoveryHeld) {
		t.Fatalf("missing hold: %v", e)
	}
	if _, e = os.Lstat(file); !errors.Is(e, os.ErrNotExist) {
		t.Fatal("missing source was recreated")
	}
	missingReopened, e := openRecoveryExport(ctx, Options{File: file, Root: dir, Project: dir, Server: c.Origin}, store, room, missing.path)
	if e != nil {
		t.Fatal(e)
	}
	if missingReopened.session.Text.ToString() != "initial file guest" {
		t.Fatal("missing-file export lost candidate")
	}
	if e = missingReopened.session.Stop(); !errors.Is(e, filewriter.ErrRecoveryHeld) {
		t.Fatalf("missing reopen hold: %v", e)
	}
	if _, e = os.Lstat(file); !errors.Is(e, os.ErrNotExist) {
		t.Fatal("missing source recreated on reopen")
	}
	if err = os.WriteFile(file, []byte(external), 0600); err != nil {
		t.Fatal(err)
	}
	if err = os.WriteFile(metadata, []byte("not json"), 0600); err != nil {
		t.Fatal(err)
	}
	malformed, e := inspectKeptRecovery(ctx, store, room, client)
	if e != nil {
		t.Fatal(e)
	}
	if malformed.path == "" || malformed.session.Text.ToString() != "initial file guest" {
		t.Fatal("malformed metadata candidate unavailable")
	}
	if e = malformed.session.Stop(); !errors.Is(e, filewriter.ErrRecoveryHeld) {
		t.Fatalf("malformed metadata hold: %v", e)
	}
	dataBefore, e := os.ReadFile(metadata)
	if e != nil || string(dataBefore) != "not json" {
		t.Fatal("malformed metadata changed")
	}
	malformedReopened, e := openRecoveryExport(ctx, Options{File: file, Root: dir, Project: dir, Server: c.Origin}, store, room, malformed.path)
	if e != nil {
		t.Fatal(e)
	}
	if e = malformedReopened.session.Stop(); !errors.Is(e, filewriter.ErrRecoveryHeld) {
		t.Fatalf("malformed reopen hold: %v", e)
	}
	if err = os.WriteFile(metadata, []byte(localMeta), 0600); err != nil {
		t.Fatal(err)
	}
	invalid := []byte{0xff, 0xfe}
	if err = os.WriteFile(file, invalid, 0600); err != nil {
		t.Fatal(err)
	}
	nonUTF, e := inspectKeptRecovery(ctx, store, room, client)
	if e != nil || nonUTF.path == "" {
		t.Fatalf("non-UTF candidate: %v", e)
	}
	if e = nonUTF.session.Stop(); !errors.Is(e, filewriter.ErrRecoveryHeld) {
		t.Fatalf("non-UTF hold: %v", e)
	}
	source, e := os.ReadFile(file)
	if e != nil || !bytes.Equal(source, invalid) {
		t.Fatal("non-UTF source changed")
	}
	if err = os.Truncate(file, int64(protocol.MaxFrameBytes)+1); err != nil {
		t.Fatal(err)
	}
	large, e := inspectKeptRecovery(ctx, store, room, client)
	if e != nil || large.path == "" {
		t.Fatalf("large file candidate: %v", e)
	}
	if e = large.session.Stop(); !errors.Is(e, filewriter.ErrRecoveryHeld) {
		t.Fatalf("large file hold: %v", e)
	}
	if err = os.Remove(file); err != nil {
		t.Fatal(err)
	}
	targetFile := filepath.Join(dir, "target")
	if err = os.WriteFile(targetFile, []byte("untouched"), 0600); err != nil {
		t.Fatal(err)
	}
	if err = os.Symlink(targetFile, file); err != nil {
		t.Fatal(err)
	}
	unbound, e := inspectKeptRecovery(ctx, store, room, client)
	if e == nil || unbound == nil || unbound.path == "" || unbound.session != nil {
		t.Fatalf("symlink candidate unavailable: %#v %v", unbound, e)
	}
	retainedBytes, e := store.ReadCandidate(room, unbound.path)
	if e != nil {
		t.Fatal(e)
	}
	var retainedState recoveryExport
	if e = json.Unmarshal(retainedBytes, &retainedState); e != nil || retainedState.Text != "initial file guest" || retainedState.TextComparison != "unavailable" {
		t.Fatalf("symlink retained candidate: %v", e)
	}
	targetBytes, e := os.ReadFile(targetFile)
	if e != nil || string(targetBytes) != "untouched" {
		t.Fatal("symlink target changed")
	}
	if err = os.Remove(file); err != nil {
		t.Fatal(err)
	}
	if err = os.WriteFile(file, []byte(external), 0600); err != nil {
		t.Fatal(err)
	}
	moved := dir + "-moved"
	if err = os.Rename(dir, moved); err != nil {
		t.Fatal(err)
	}
	missingProject, e := inspectKeptRecovery(ctx, store, room, client)
	if e == nil || missingProject == nil || missingProject.path == "" || missingProject.session != nil {
		t.Fatalf("missing project candidate unavailable: %#v %v", missingProject, e)
	}
	rawCandidate, e := store.ReadCandidate(room, missingProject.path)
	if e != nil {
		t.Fatal(e)
	}
	var missingState recoveryExport
	if e = json.Unmarshal(rawCandidate, &missingState); e != nil || missingState.Text != "initial file guest" {
		t.Fatalf("missing project content: %v", e)
	}
	if err = os.Rename(moved, dir); err != nil {
		t.Fatal(err)
	}
	if _, err = openReadEvidence(store, room, evidencePath); err != nil {
		t.Fatalf("evidence after reopen: %v", err)
	}
	if err = store.Close(); err != nil {
		t.Fatal(err)
	}
	child := exec.Command(os.Args[0], "-test.run=^TestOpenReadEvidenceChild$")
	child.Env = append(os.Environ(), "PEDIT_EVIDENCE_STORE="+stateDir, "PEDIT_EVIDENCE_ROOM="+room, "PEDIT_EVIDENCE_PATH="+evidencePath, "PEDIT_BUNDLE_PATH="+artifacts.Manifest)
	if output, e := child.CombinedOutput(); e != nil {
		t.Fatalf("fresh process evidence: %v %s", e, output)
	}
	store, err = hoststate.Open(stateDir)
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
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

func TestOpenReadEvidenceChild(t *testing.T) {
	path := os.Getenv("PEDIT_EVIDENCE_STORE")
	if path == "" {
		t.Skip("evidence subprocess only")
	}
	store, err := hoststate.Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	e, err := openReadEvidence(store, os.Getenv("PEDIT_EVIDENCE_ROOM"), os.Getenv("PEDIT_EVIDENCE_PATH"))
	if err != nil || e.TailStatus != "unverified" || len(e.Entries) != 2 {
		t.Fatalf("fresh evidence: %v", err)
	}
	b, err := openRecoveryBundle(store, os.Getenv("PEDIT_EVIDENCE_ROOM"), os.Getenv("PEDIT_BUNDLE_PATH"))
	if err != nil || string(b.Text) != "initial file guest" || !bytes.Contains(b.Comments, []byte("guest quote")) {
		t.Fatalf("fresh bundle: %v", err)
	}
}

func TestLiveRecoveryIntentChild(t *testing.T) {
	path := os.Getenv("PEDIT_LIVE_INTENT_STORE")
	if path == "" {
		t.Skip("live intent subprocess only")
	}
	store, err := hoststate.Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	view, err := openRecoveryIntent(store, os.Getenv("PEDIT_LIVE_INTENT_ROOM"), os.Getenv("PEDIT_LIVE_INTENT_PATH"))
	if err != nil || string(view.NewText) != "initial file guest" || view.MetadataStatus != "not-generated" {
		t.Fatal("live intent unavailable after restart", err)
	}
}
