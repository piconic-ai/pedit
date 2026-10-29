package protocol

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestReadKeptHostSeparatesBaselineAndTailLimits(t *testing.T) {
	v, snapshot, _, keys := loadReadFixture(t)
	original, err := base64.StdEncoding.DecodeString(snapshot.Ciphertext)
	if err != nil {
		t.Fatal(err)
	}
	rawEpoch, err := hex.DecodeString(v.Epoch)
	if err != nil {
		t.Fatal(err)
	}
	var epoch [32]byte
	copy(epoch[:], rawEpoch)
	cpContext := KeptCheckpointContext{RoomID: v.RoomID, Epoch: epoch, Generation: 1}
	plain, err := OpenKeptCheckpoint(keys, cpContext, original)
	if err != nil {
		t.Fatal(err)
	}
	base, err := DecodeKeptTextPayload(plain, 4)
	if err != nil {
		t.Fatal(err)
	}
	host := ed25519.NewKeyFromSeed(bytes.Repeat([]byte{7}, 32))
	sender := ed25519.NewKeyFromSeed(bytes.Repeat([]byte{11}, 32))
	cert, err := CreateKeptSenderCertificate(keys, sender.Public().(ed25519.PublicKey))
	if err != nil {
		t.Fatal(err)
	}
	for _, tc := range []struct {
		name           string
		baseline, tail int
		accepted       bool
	}{
		{"1025 baseline and signed tail", 1025, 1, true},
		{"maximum baseline and signed tail", MaxKeptCheckpointReceipts, 1, true},
		{"baseline over maximum", MaxKeptCheckpointReceipts + 1, 1, false},
		{"maximum tail", 0, maxKeptReadRecords, true},
		{"tail over maximum", 0, maxKeptReadRecords + 1, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			receipts := make([]KeptReceipt, tc.baseline)
			var senderID [32]byte
			copy(senderID[:], sender.Public().(ed25519.PublicKey))
			for i := range receipts {
				receipts[i] = KeptReceipt{Access: AccessEdit, Sender: senderID, Sequence: uint64(i + 1), Digest: [32]byte{byte(i)}, Outcome: KeptApplied}
			}
			ledger, err := RestoreKeptLedger(tc.baseline+1, receipts)
			if err != nil {
				t.Fatal(err)
			}
			payload := base
			payload.Ledger = ledger
			encoded, err := EncodeKeptTextPayload(payload)
			if err != nil {
				t.Fatal(err)
			}
			checkpoint, err := SealKeptCheckpoint(keys, host, cpContext, encoded)
			if err != nil {
				t.Fatal(err)
			}
			current := snapshot
			current.Ciphertext = base64.StdEncoding.EncodeToString(checkpoint)
			current.Tail = uint64(tc.tail)
			entries := make([]KeptReadEntry, tc.tail)
			for i := range entries {
				record, err := SealKeptRecord(keys, KeptRecordContext{RoomID: v.RoomID, Epoch: epoch, Generation: 1}, sender, cert, uint64(tc.baseline+i+1), []byte("operation"))
				if err != nil {
					t.Fatal(err)
				}
				entries[i] = KeptReadEntry{Sequence: uint64(i + 1), Ciphertext: base64.StdEncoding.EncodeToString(record)}
			}
			cursors := map[string]int{current.Cursor: 0}
			canceled, finished := 0, 0
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				switch r.Method {
				case http.MethodPost:
					body, _ := json.Marshal(current)
					_, _ = w.Write(body)
				case http.MethodDelete:
					if r.Header.Get("X-Pedit-Read-Cursor") == "" {
						canceled++
					} else {
						finished++
					}
					w.WriteHeader(http.StatusNoContent)
				case http.MethodGet:
					at, ok := cursors[r.Header.Get("X-Pedit-Read-Cursor")]
					if !ok {
						w.WriteHeader(400)
						return
					}
					end := min(at+16, len(entries))
					var next *string
					if end < len(entries) {
						cursor := fmt.Sprintf("00000000-0000-4000-8000-%012x", end)
						cursors[cursor] = end
						next = &cursor
					}
					page := KeptReadPage{Entries: entries[at:end], Next: next}
					body, _ := json.Marshal(page)
					_, _ = w.Write(body)
				default:
					w.WriteHeader(405)
				}
			}))
			defer server.Close()
			got, err := ReadKeptHost(context.Background(), server.Client(), server.URL, v.RoomID, v.HostToken, keys, 0, nil)
			if tc.accepted {
				if err != nil || len(got.Checkpoint.Ledger.Snapshot()) != tc.baseline || len(got.Records) != tc.tail || finished != 1 || canceled != 0 {
					t.Fatalf("read baseline=%d tail=%d finish=%d cancel=%d err=%v", len(got.Checkpoint.Ledger.Snapshot()), len(got.Records), finished, canceled, err)
				}
			} else if err == nil || finished != 0 || canceled != 1 {
				t.Fatalf("expected bounded rejection and cancel, finish=%d cancel=%d err=%v", finished, canceled, err)
			}
		})
	}
}

func TestReadKeptEntryRejectsTailLimitsBeforeProcessing(t *testing.T) {
	entry := KeptReadEntry{Sequence: 1, Ciphertext: base64.StdEncoding.EncodeToString([]byte{1})}
	for _, bounds := range []struct{ count, total int }{{maxKeptReadRecords, 0}, {0, maxKeptReadBytes}} {
		_, _, _, err := readKeptEntry(entry, nil, "", [32]byte{}, 1, KeptLedger{}, bounds.count, bounds.total)
		if err == nil || err.Error() != "read capacity exceeded" {
			t.Fatalf("bounds %+v: %v", bounds, err)
		}
	}
}
