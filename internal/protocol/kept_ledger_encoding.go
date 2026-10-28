package protocol

import (
	"bytes"
	"encoding/binary"
	"errors"
	"sort"
)

const (
	ledgerDomain      = "pedit/v6/ledger\x00"
	ledgerHeaderSize  = len(ledgerDomain) + 4
	ledgerReceiptSize = 1 + 32 + 8 + 32 + 1
	maxLedgerReceipts = (maxKeptCheckpointPayload - ledgerHeaderSize) / ledgerReceiptSize
)

func receiptTier(access Access) byte {
	if access == AccessEdit {
		return 0
	}
	return 1
}

// EncodeKeptLedger returns a canonical snapshot for inclusion in a checkpoint.
// The caller must budget space for all other checkpoint data and persist the
// resulting ledger atomically with the document; it must not truncate receipts.
func EncodeKeptLedger(ledger KeptLedger) ([]byte, error) {
	if ledger.identity == nil || len(ledger.receipts) > maxLedgerReceipts {
		return nil, errors.New("ledger exceeds checkpoint capacity")
	}
	items := ledger.Snapshot()
	sort.Slice(items, func(i, j int) bool {
		a, b := items[i], items[j]
		if a.Access != b.Access {
			return receiptTier(a.Access) < receiptTier(b.Access)
		}
		if cmp := bytes.Compare(a.Sender[:], b.Sender[:]); cmp != 0 {
			return cmp < 0
		}
		return a.Sequence < b.Sequence
	})
	out := make([]byte, ledgerHeaderSize+len(items)*ledgerReceiptSize)
	at := copy(out, ledgerDomain)
	binary.BigEndian.PutUint32(out[at:], uint32(len(items)))
	at += 4
	for _, item := range items {
		out[at] = receiptTier(item.Access)
		at++
		at += copy(out[at:], item.Sender[:])
		binary.BigEndian.PutUint64(out[at:], item.Sequence)
		at += 8
		at += copy(out[at:], item.Digest[:])
		if item.Outcome == KeptRejected {
			out[at] = 1
		}
		at++
	}
	return out, nil
}

// DecodeKeptLedger validates a snapshot after its checkpoint was authenticated.
func DecodeKeptLedger(limit int, data []byte) (KeptLedger, error) {
	bad := errors.New("invalid ledger encoding")
	if len(data) < ledgerHeaderSize || len(data) > maxKeptCheckpointPayload || !bytes.Equal(data[:len(ledgerDomain)], []byte(ledgerDomain)) {
		return KeptLedger{}, bad
	}
	count := int(binary.BigEndian.Uint32(data[len(ledgerDomain):ledgerHeaderSize]))
	if limit < 1 || count > limit || count > maxLedgerReceipts || len(data) != ledgerHeaderSize+count*ledgerReceiptSize {
		return KeptLedger{}, bad
	}
	items := make([]KeptReceipt, 0, count)
	var previous []byte
	for at := ledgerHeaderSize; at < len(data); at += ledgerReceiptSize {
		raw := data[at : at+ledgerReceiptSize]
		identity := raw[:1+32+8]
		if previous != nil && bytes.Compare(previous, identity) >= 0 {
			return KeptLedger{}, bad
		}
		var item KeptReceipt
		switch raw[0] {
		case 0:
			item.Access = AccessEdit
		case 1:
			item.Access = AccessComment
		default:
			return KeptLedger{}, bad
		}
		copy(item.Sender[:], raw[1:33])
		item.Sequence = binary.BigEndian.Uint64(raw[33:41])
		copy(item.Digest[:], raw[41:73])
		switch raw[73] {
		case 0:
			item.Outcome = KeptApplied
		case 1:
			item.Outcome = KeptRejected
		default:
			return KeptLedger{}, bad
		}
		items = append(items, item)
		previous = identity
	}
	ledger, err := RestoreKeptLedger(limit, items)
	if err != nil {
		return KeptLedger{}, bad
	}
	return ledger, nil
}
