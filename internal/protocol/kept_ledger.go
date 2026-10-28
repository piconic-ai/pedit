package protocol

import (
	"crypto/sha256"
	"encoding/binary"
	"errors"
)

const operationDomain = "pedit/v6/operation\x00"

type KeptOutcome string

const (
	KeptApplied  KeptOutcome = "applied"
	KeptRejected KeptOutcome = "rejected"
)

type KeptDecision string

const (
	KeptNext      KeptDecision = "next"
	KeptDuplicate KeptDecision = "duplicate"
	KeptConflict  KeptDecision = "conflict"
	KeptGap       KeptDecision = "gap"
	KeptFull      KeptDecision = "full"
)

type KeptReceipt struct {
	Access   Access
	Sender   [32]byte
	Sequence uint64
	Digest   [32]byte
	Outcome  KeptOutcome
}

type keptReceipt struct {
	access   Access
	sender   [32]byte
	sequence uint64
	digest   [32]byte
	outcome  KeptOutcome
}

// KeptLedger classifies records after signature and epoch verification. Callers
// enforce permissions and persist the ledger atomically with document changes.
type KeptLedger struct {
	limit    int
	receipts []keptReceipt
}

type KeptInspection struct {
	Decision     KeptDecision
	Floor        uint64
	Digest       [32]byte
	Outcome      KeptOutcome
	receipt      keptReceipt
	initialFloor uint64
	committable  bool
}

func NewKeptLedger(limit int) (KeptLedger, error) {
	if limit < 1 {
		return KeptLedger{}, errors.New("invalid ledger limit")
	}
	return KeptLedger{limit: limit}, nil
}

// RestoreKeptLedger validates a snapshot from an authenticated checkpoint.
func RestoreKeptLedger(limit int, snapshot []KeptReceipt) (KeptLedger, error) {
	ledger, err := NewKeptLedger(limit)
	if err != nil || len(snapshot) > limit {
		return KeptLedger{}, errors.New("invalid ledger snapshot")
	}
	type identity struct {
		access Access
		sender [32]byte
	}
	floors := make(map[identity]uint64)
	for _, item := range snapshot {
		if item.Access != AccessEdit && item.Access != AccessComment || item.Outcome != KeptApplied && item.Outcome != KeptRejected || item.Sequence < 1 || item.Sequence > maxKeptCounter {
			return KeptLedger{}, errors.New("invalid ledger snapshot")
		}
		id := identity{access: item.Access, sender: item.Sender}
		if item.Sequence != floors[id]+1 {
			return KeptLedger{}, errors.New("invalid ledger snapshot")
		}
		floors[id] = item.Sequence
		ledger.receipts = append(ledger.receipts, keptReceipt{access: item.Access, sender: item.Sender, sequence: item.Sequence, digest: item.Digest, outcome: item.Outcome})
	}
	return ledger, nil
}

func (l KeptLedger) Snapshot() []KeptReceipt {
	result := make([]KeptReceipt, 0, len(l.receipts))
	for _, r := range l.receipts {
		result = append(result, KeptReceipt{Access: r.access, Sender: r.sender, Sequence: r.sequence, Digest: r.digest, Outcome: r.outcome})
	}
	return result
}

func keptOperationDigest(record KeptRecord) ([32]byte, error) {
	var out [32]byte
	var tier byte
	switch record.Access {
	case AccessEdit:
		tier = 0
	case AccessComment:
		tier = 1
	default:
		return out, errors.New("invalid operation")
	}
	if record.Sequence < 1 || record.Sequence > maxKeptCounter || len(record.Message) < 1 || len(record.Message) > maxRecordPayload {
		return out, errors.New("invalid operation")
	}
	h := sha256.New()
	h.Write([]byte(operationDomain))
	h.Write([]byte{tier})
	h.Write(record.Sender[:])
	var fields [12]byte
	binary.BigEndian.PutUint64(fields[:8], record.Sequence)
	binary.BigEndian.PutUint32(fields[8:], uint32(len(record.Message)))
	h.Write(fields[:])
	h.Write(record.Message)
	copy(out[:], h.Sum(nil))
	return out, nil
}

func (l KeptLedger) Inspect(record KeptRecord) (KeptInspection, error) {
	var result KeptInspection
	if l.limit < 1 {
		return result, errors.New("invalid ledger")
	}
	digest, err := keptOperationDigest(record)
	if err != nil {
		return result, err
	}
	result.Digest = digest
	result.receipt = keptReceipt{access: record.Access, sender: record.Sender, sequence: record.Sequence, digest: digest}
	for _, r := range l.receipts {
		if r.access != record.Access || r.sender != record.Sender {
			continue
		}
		if r.sequence > result.Floor {
			result.Floor = r.sequence
		}
		if r.sequence == record.Sequence {
			result.Outcome = r.outcome
			if r.digest == digest {
				result.Decision = KeptDuplicate
			} else {
				result.Decision = KeptConflict
			}
		}
	}
	if result.Decision != "" {
		return result, nil
	}
	if record.Sequence != result.Floor+1 {
		result.Decision = KeptGap
	} else if len(l.receipts) >= l.limit {
		result.Decision = KeptFull
	} else {
		result.Decision = KeptNext
	}
	result.initialFloor = result.Floor
	result.committable = result.Decision == KeptNext
	return result, nil
}

// Commit returns a new ledger only if the inspected sender floor has not
// changed. The caller commits this together with the matching document update.
func (l KeptLedger) Commit(plan KeptInspection, outcome KeptOutcome) (KeptLedger, error) {
	if l.limit < 1 || !plan.committable || plan.Decision != KeptNext || plan.Floor != plan.initialFloor || (outcome != KeptApplied && outcome != KeptRejected) {
		return l, errors.New("invalid ledger commit")
	}
	var floor uint64
	for _, r := range l.receipts {
		if r.access == plan.receipt.access && r.sender == plan.receipt.sender && r.sequence > floor {
			floor = r.sequence
		}
	}
	if floor != plan.Floor || plan.receipt.sequence != floor+1 || len(l.receipts) >= l.limit || plan.Digest != plan.receipt.digest {
		return l, errors.New("stale ledger commit")
	}
	receipt := plan.receipt
	receipt.outcome = outcome
	next := KeptLedger{limit: l.limit, receipts: make([]keptReceipt, len(l.receipts), len(l.receipts)+1)}
	copy(next.receipts, l.receipts)
	next.receipts = append(next.receipts, receipt)
	return next, nil
}
