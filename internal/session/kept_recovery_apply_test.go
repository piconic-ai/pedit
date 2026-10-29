package session

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"encoding/base64"
	"encoding/json"
	"errors"
	"net/http"
	"os"
	"path/filepath"
	"sync/atomic"
	"testing"

	"github.com/piconic-ai/pedit/internal/filewriter"
	"github.com/piconic-ai/pedit/internal/meta"
	"github.com/piconic-ai/pedit/internal/protocol"
	"github.com/reearth/ygo/crdt"
	ysync "github.com/reearth/ygo/sync"
)

type recoveryTransport struct{ calls atomic.Int32 }

func (r *recoveryTransport) RoundTrip(*http.Request) (*http.Response, error) {
	r.calls.Add(1)
	return nil, errors.New("unexpected network")
}

type recoveryFixture struct {
	opts                       Options
	checkpoint                 recoveryCheckpoint
	ledger                     protocol.KeptLedger
	keys, commenter            *protocol.KeptRoomKeys
	context                    protocol.KeptRecordContext
	sender                     ed25519.PrivateKey
	textUpdate, commentsUpdate []byte
}

func newRecoveryFixture(t *testing.T) recoveryFixture {
	t.Helper()
	dir := t.TempDir()
	file := filepath.Join(dir, "note.md")
	if err := os.WriteFile(file, []byte("external edit"), 0600); err != nil {
		t.Fatal(err)
	}
	host := ed25519.NewKeyFromSeed(bytes.Repeat([]byte{7}, 32))
	var hostPublic, secret, epoch [32]byte
	copy(hostPublic[:], host.Public().(ed25519.PublicKey))
	copy(secret[:], bytes.Repeat([]byte{3}, 32))
	copy(epoch[:], bytes.Repeat([]byte{5}, 32))
	const room = "AAECAwQFBgcICQoLDA0ODw"
	keys, err := protocol.DeriveKeptRoomKeys(protocol.KeptLinkSecrets{Access: protocol.AccessEdit, Secret: secret, HostKey: hostPublic}, room)
	if err != nil {
		t.Fatal(err)
	}
	link, err := protocol.ParseKeptFragment(keys.Fragments[protocol.AccessComment])
	if err != nil {
		t.Fatal(err)
	}
	commenter, err := protocol.DeriveKeptRoomKeys(link, room)
	if err != nil {
		t.Fatal(err)
	}
	ledger, err := protocol.NewKeptLedger(20)
	if err != nil {
		t.Fatal(err)
	}
	text := crdt.New()
	value := newTextContent(text, "base").text
	cp := recoveryCheckpoint{text: crdt.EncodeStateAsUpdateV1(text, nil), comments: crdt.EncodeStateAsUpdateV1(crdt.New(), nil), metaID: 7}
	var update []byte
	text.OnUpdate(func(u []byte, _ any) { update = bytes.Clone(u) })
	text.Transact(func(tx *crdt.Transaction) { value.Insert(tx, 4, " guest", nil) })
	comments := crdt.New()
	root := comments.GetMap(meta.CommentsKey)
	var commentUpdate []byte
	comments.OnUpdate(func(u []byte, _ any) { commentUpdate = bytes.Clone(u) })
	comments.Transact(func(tx *crdt.Transaction) {
		thread := crdt.NewMapPrelim()
		root.Set(tx, "c1", thread)
		thread.Set(tx, meta.QuoteKey, "hello")
	})
	return recoveryFixture{opts: Options{File: file, Project: dir, Server: "https://must-not-connect.invalid"}, checkpoint: cp, ledger: ledger, keys: keys, commenter: commenter, context: protocol.KeptRecordContext{RoomID: room, Epoch: epoch, Generation: 1}, sender: ed25519.NewKeyFromSeed(bytes.Repeat([]byte{11}, 32)), textUpdate: update, commentsUpdate: commentUpdate}
}
func (f recoveryFixture) frame(t *testing.T, keys *protocol.KeptRoomKeys, seq uint64, tag byte, update []byte) []byte {
	t.Helper()
	cert, err := protocol.CreateKeptSenderCertificate(keys, f.sender.Public().(ed25519.PublicKey))
	if err != nil {
		t.Fatal(err)
	}
	var message []byte
	switch tag {
	case 1:
		message = protocol.EncodeMessage(protocol.MessageSync, ysync.EncodeUpdate(update))
	case 2:
		payload, err := protocol.EncodeFileDoc(7, protocol.MessageSync, ysync.EncodeUpdate(update))
		if err != nil {
			t.Fatal(err)
		}
		message = protocol.EncodeMessage(protocol.MessageFiles, payload)
	default:
		message = protocol.EncodeMessage(protocol.MessageCanvas, update)
	}
	frame, err := protocol.SealKeptRecord(keys, f.context, f.sender, cert, seq, message)
	if err != nil {
		t.Fatal(err)
	}
	return frame
}

func TestKeptRecoverySharedBrowserWireFixture(t *testing.T) {
	f := newRecoveryFixture(t)
	data, err := os.ReadFile("../../packages/testdata/kept-recovery-wire.json")
	if err != nil {
		t.Fatal(err)
	}
	var v struct{ TextState, CommentsState, TextMessage, CommentsMessage string }
	if err := json.Unmarshal(data, &v); err != nil {
		t.Fatal(err)
	}
	decode := func(s string) []byte {
		b, err := base64.RawURLEncoding.DecodeString(s)
		if err != nil {
			t.Fatal(err)
		}
		return b
	}
	seal := func(keys *protocol.KeptRoomKeys, msg []byte) []byte {
		cert, err := protocol.CreateKeptSenderCertificate(keys, f.sender.Public().(ed25519.PublicKey))
		if err != nil {
			t.Fatal(err)
		}
		frame, err := protocol.SealKeptRecord(keys, f.context, f.sender, cert, 1, msg)
		if err != nil {
			t.Fatal(err)
		}
		return frame
	}
	cp := recoveryCheckpoint{text: decode(v.TextState), comments: decode(v.CommentsState), metaID: 7}
	frames := [][]byte{seal(f.keys, decode(v.TextMessage)), seal(f.commenter, decode(v.CommentsMessage))}
	s, err := startKeptRecovery(context.Background(), f.opts, cp, f.ledger, f.keys, f.context, frames)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Stop()
	if got := s.Text.ToString(); got != "Ahello world" {
		t.Fatalf("text = %q", got)
	}
	if s.meta.id != 7 {
		t.Fatalf("metadata ID = %d", s.meta.id)
	}
	thread, ok := s.meta.doc.GetMap(meta.CommentsKey).Get("c1")
	if !ok {
		t.Fatal("missing comment")
	}
	quote, ok := thread.(*crdt.YMap).Get(meta.QuoteKey)
	if !ok || quote != "changed" {
		t.Fatalf("quote %v", quote)
	}
}
func TestKeptRecoveryAppliesVerifiedTailInHeldSession(t *testing.T) {
	f := newRecoveryFixture(t)
	transport := &recoveryTransport{}
	f.opts.HTTPClient = &http.Client{Transport: transport}
	frames := [][]byte{f.frame(t, f.keys, 1, 1, f.textUpdate), f.frame(t, f.commenter, 1, 2, f.commentsUpdate)}
	s, err := startKeptRecovery(context.Background(), f.opts, f.checkpoint, f.ledger, f.keys, f.context, frames)
	if err != nil {
		t.Fatal(err)
	}
	if s.URL != "" {
		t.Fatal("recovery exposed a room")
	}
	if transport.calls.Load() != 0 {
		t.Fatal("recovery contacted relay")
	}
	if got := s.Text.ToString(); got != "base guest" {
		t.Fatalf("text %q", got)
	}
	if _, ok := s.meta.doc.GetMap(meta.CommentsKey).Get("c1"); !ok {
		t.Fatal("comment missing")
	}
	if len(s.recovery.ledger.Snapshot()) != 2 || len(f.ledger.Snapshot()) != 0 {
		t.Fatal("ledger not isolated")
	}
	if got := readFile(t, f.opts.File); got != "external edit" {
		t.Fatalf("disk changed: %q", got)
	}
	if err := s.Stop(); !errors.Is(err, filewriter.ErrRecoveryHeld) {
		t.Fatalf("stop: %v", err)
	}
	if transport.calls.Load() != 0 {
		t.Fatal("recovery stop contacted relay")
	}
	if got := readFile(t, f.opts.File); got != "external edit" {
		t.Fatalf("disk changed after stop: %q", got)
	}
}
func TestKeptRecoverySkipsRecordedDuplicates(t *testing.T) {
	f := newRecoveryFixture(t)
	frame := f.frame(t, f.keys, 1, 1, f.textUpdate)
	s, err := startKeptRecovery(context.Background(), f.opts, f.checkpoint, f.ledger, f.keys, f.context, [][]byte{frame, frame})
	if err != nil {
		t.Fatal(err)
	}
	if got := s.Text.ToString(); got != "base guest" {
		t.Fatalf("duplicate applied twice: %q", got)
	}
	if len(s.recovery.ledger.Snapshot()) != 1 {
		t.Fatal("duplicate receipt added")
	}
	_ = s.Stop()

	record, err := protocol.OpenKeptRecord(f.keys, f.context, frame)
	if err != nil {
		t.Fatal(err)
	}
	plan, err := f.ledger.Inspect(record)
	if err != nil {
		t.Fatal(err)
	}
	applied, err := f.ledger.Commit(plan, protocol.KeptApplied)
	if err != nil {
		t.Fatal(err)
	}
	checkpointDoc := crdt.New()
	if err := crdt.ApplyUpdateV1(checkpointDoc, f.checkpoint.text, nil); err != nil {
		t.Fatal(err)
	}
	if err := crdt.ApplyUpdateV1(checkpointDoc, f.textUpdate, nil); err != nil {
		t.Fatal(err)
	}
	alreadyApplied := f.checkpoint
	alreadyApplied.text = crdt.EncodeStateAsUpdateV1(checkpointDoc, nil)
	s, err = startKeptRecovery(context.Background(), f.opts, alreadyApplied, applied, f.keys, f.context, [][]byte{frame})
	if err != nil {
		t.Fatal(err)
	}
	if got := s.Text.ToString(); got != "base guest" {
		t.Fatalf("applied duplicate: %q", got)
	}
	if rows := s.recovery.ledger.Snapshot(); len(rows) != 1 || rows[0].Outcome != protocol.KeptApplied {
		t.Fatal("applied receipt changed")
	}
	_ = s.Stop()
	rejected, err := f.ledger.Commit(plan, protocol.KeptRejected)
	if err != nil {
		t.Fatal(err)
	}
	s, err = startKeptRecovery(context.Background(), f.opts, f.checkpoint, rejected, f.keys, f.context, [][]byte{frame})
	if err != nil {
		t.Fatal(err)
	}
	if got := s.Text.ToString(); got != "base" {
		t.Fatalf("rejected duplicate applied: %q", got)
	}
	if rows := s.recovery.ledger.Snapshot(); len(rows) != 1 || rows[0].Outcome != protocol.KeptRejected {
		t.Fatal("rejected receipt changed")
	}
	_ = s.Stop()
}

func TestKeptRecoveryRejectsTailWithoutMutatingCheckpointLedgerOrDisk(t *testing.T) {
	f := newRecoveryFixture(t)
	first := f.frame(t, f.keys, 1, 1, f.textUpdate)
	wrongFile, err := protocol.EncodeFileDoc(8, protocol.MessageSync, ysync.EncodeUpdate(f.commentsUpdate))
	if err != nil {
		t.Fatal(err)
	}
	cert, err := protocol.CreateKeptSenderCertificate(f.commenter, f.sender.Public().(ed25519.PublicKey))
	if err != nil {
		t.Fatal(err)
	}
	wrongFrame, err := protocol.SealKeptRecord(f.commenter, f.context, f.sender, cert, 1, protocol.EncodeMessage(protocol.MessageFiles, wrongFile))
	if err != nil {
		t.Fatal(err)
	}
	tampered := bytes.Clone(first)
	tampered[len(tampered)-1] ^= 1
	assetDoc := crdt.New()
	if err := crdt.ApplyUpdateV1(assetDoc, f.checkpoint.text, nil); err != nil {
		t.Fatal(err)
	}
	var assetUpdate []byte
	assetDoc.OnUpdate(func(u []byte, _ any) { assetUpdate = bytes.Clone(u) })
	assetText := assetDoc.GetText("content")
	assetDoc.Transact(func(tx *crdt.Transaction) {
		assetText.Insert(tx, 4, " assets/0123456789abcdef0123456789abcdef.png", nil)
	})
	assetCheckpoint := f.checkpoint
	assetCheckpoint.text = crdt.EncodeStateAsUpdateV1(assetDoc, nil)
	if _, err := startKeptRecovery(context.Background(), f.opts, assetCheckpoint, f.ledger, f.keys, f.context, nil); err == nil {
		t.Fatal("accepted checkpoint with attachment reference")
	}
	cases := map[string][][]byte{
		"same sequence different body": {first, f.frame(t, f.keys, 1, 1, []byte{0, 0})},
		"gap":                          {f.frame(t, f.keys, 2, 1, f.textUpdate)},
		"commenter text":               {f.frame(t, f.commenter, 1, 1, f.textUpdate)},
		"bad signature after valid":    {first, tampered},
		"trailing text update":         {f.frame(t, f.keys, 1, 1, append(bytes.Clone(f.textUpdate), 0xff, 0xff))},
		"trailing comments update":     {f.frame(t, f.commenter, 1, 2, append(bytes.Clone(f.commentsUpdate), 0xff, 0xff))},
		"unavailable attachment":       {f.frame(t, f.keys, 1, 1, assetUpdate)},
		"unsupported doc":              {f.frame(t, f.keys, 1, 3, f.textUpdate)},
		"wrong metadata ID":            {wrongFrame},
		"malformed update after valid": {first, f.frame(t, f.keys, 2, 1, []byte{255})},
	}
	if _, err := startKeptRecovery(context.Background(), f.opts, f.checkpoint, protocol.KeptLedger{}, f.keys, f.context, nil); err == nil {
		t.Fatal("accepted uninitialized ledger")
	}
	originalText, originalComments := bytes.Clone(f.checkpoint.text), bytes.Clone(f.checkpoint.comments)
	for name, frames := range cases {
		t.Run(name, func(t *testing.T) {
			s, err := startKeptRecovery(context.Background(), f.opts, f.checkpoint, f.ledger, f.keys, f.context, frames)
			if err == nil {
				_ = s.Stop()
				t.Fatal("accepted invalid tail")
			}
			if len(f.ledger.Snapshot()) != 0 || !bytes.Equal(f.checkpoint.text, originalText) || !bytes.Equal(f.checkpoint.comments, originalComments) {
				t.Fatal("mutated input")
			}
			if got := readFile(t, f.opts.File); got != "external edit" {
				t.Fatalf("disk changed: %q", got)
			}
		})
	}
}

func TestKeptRecoveryRetriesValidTailAfterInvalidTail(t *testing.T) {
	f := newRecoveryFixture(t)
	frame := f.frame(t, f.keys, 1, 1, f.textUpdate)
	tampered := bytes.Clone(frame)
	tampered[len(tampered)-1] ^= 1
	if _, err := startKeptRecovery(context.Background(), f.opts, f.checkpoint, f.ledger, f.keys, f.context, [][]byte{tampered}); err == nil {
		t.Fatal("accepted invalid tail")
	}
	s, err := startKeptRecovery(context.Background(), f.opts, f.checkpoint, f.ledger, f.keys, f.context, [][]byte{frame})
	if err != nil {
		t.Fatal(err)
	}
	defer s.Stop()
	if len(s.recovery.ledger.Snapshot()) != 1 || len(f.ledger.Snapshot()) != 0 {
		t.Fatal("retry did not preserve ledger isolation")
	}
	if got := readFile(t, f.opts.File); got != "external edit" {
		t.Fatalf("disk changed: %q", got)
	}
}
func TestKeptRecoveryAcceptsMaximumBaselineAndSignedTail(t *testing.T) {
	f := newRecoveryFixture(t)
	receipts := make([]protocol.KeptReceipt, protocol.MaxKeptCheckpointReceipts)
	for i := range receipts {
		receipts[i] = protocol.KeptReceipt{Access: protocol.AccessEdit, Sequence: uint64(i + 1), Outcome: protocol.KeptApplied}
	}
	ledger, err := protocol.RestoreKeptLedger(protocol.MaxKeptCheckpointReceipts, receipts)
	if err != nil {
		t.Fatal(err)
	}
	frame := f.frame(t, f.keys, 1, 1, f.textUpdate)
	s, err := startKeptRecovery(context.Background(), f.opts, f.checkpoint, ledger, f.keys, f.context, [][]byte{frame})
	if err != nil {
		t.Fatal(err)
	}
	defer s.Stop()
	if s.Text.ToString() != "base guest" {
		t.Fatalf("recovery text %q", s.Text.ToString())
	}
}

func TestKeptRecoverySeparatelyBoundsBaselineAndTail(t *testing.T) {
	f := newRecoveryFixture(t)
	receipts := make([]protocol.KeptReceipt, protocol.MaxKeptCheckpointReceipts+1)
	for i := range receipts {
		receipts[i] = protocol.KeptReceipt{Access: protocol.AccessEdit, Sequence: uint64(i + 1), Outcome: protocol.KeptApplied}
	}
	ledger, err := protocol.RestoreKeptLedger(len(receipts), receipts)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = startKeptRecovery(context.Background(), f.opts, f.checkpoint, ledger, f.keys, f.context, nil); err == nil {
		t.Fatal("accepted oversized baseline")
	}
	if _, err = startKeptRecovery(context.Background(), f.opts, f.checkpoint, f.ledger, f.keys, f.context, make([][]byte, protocol.MaxKeptReadRecords+1)); err == nil {
		t.Fatal("accepted oversized tail")
	}
	if got := readFile(t, f.opts.File); got != "external edit" {
		t.Fatalf("disk changed: %q", got)
	}
}
