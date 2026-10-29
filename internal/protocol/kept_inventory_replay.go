package protocol

import (
	"bytes"
	"errors"
	"sort"

	"github.com/reearth/ygo/crdt"
)

// Small cumulative byte bound for this isolated prototype, before ygo applies any updates.
const maxInventoryReplayBytes = 1024
const maxInventoryReplayRecords = 64

type KeptInventoryReplay struct {
	Text      []byte
	Inventory []string
	Ledger    KeptLedger
}

// ReplayKeptInventory requires authenticated records and baseline. It checks
// declared known paths, not inventory completeness or relay freshness.
func ReplayKeptInventory(base []byte, paths []string, ledger KeptLedger, records []KeptRecord) (out KeptInventoryReplay, err error) {
	bad := errors.New("invalid inventory replay")
	if len(records) > maxInventoryReplayRecords || len(base) > maxInventoryReplayBytes || CheckKeptTextState(base) != nil || !validInventoryPaths(paths) {
		return out, bad
	}
	defer func() {
		if recover() != nil {
			out = KeptInventoryReplay{}
			err = bad
		}
	}()
	doc := crdt.New()
	defer doc.Destroy()
	apply := func(update []byte) error {
		if crdt.ApplyUpdateV1(doc, update, nil) != nil {
			return bad
		}
		if p := doc.PendingStats(); p.Items != 0 || p.DeleteRanges != 0 {
			return bad
		}
		if CheckKeptTextState(crdt.EncodeStateAsUpdateV1(doc, nil)) != nil {
			return bad
		}
		return nil
	}
	inventory := append([]string{}, paths...)
	checkRefs := func() error {
		for _, p := range keptAssetReference.FindAllString(doc.GetText("content").ToString(), -1) {
			if _, ok := sort.Find(len(inventory), func(i int) int { return bytes.Compare([]byte(p), []byte(inventory[i])) }); !ok {
				return bad
			}
		}
		return nil
	}
	if apply(base) != nil || checkRefs() != nil {
		return out, bad
	}
	total := len(base)
	for _, record := range records {
		operation, plan, e := inspectInventoryRecord(ledger, record)
		if e != nil {
			return KeptInventoryReplay{}, bad
		}
		if plan.Decision == KeptDuplicate {
			continue
		}
		if plan.Decision != KeptNext {
			return KeptInventoryReplay{}, bad
		}
		total += len(operation.Update)
		if total > maxInventoryReplayBytes {
			return KeptInventoryReplay{}, bad
		}
		inventory = mergeKeptInventory(inventory, operation.Additions)
		if len(inventory) > MaxKeptInventoryPaths || apply(operation.Update) != nil || checkRefs() != nil {
			return KeptInventoryReplay{}, bad
		}
		ledger, e = ledger.Commit(plan, KeptApplied)
		if e != nil {
			return KeptInventoryReplay{}, bad
		}
	}
	return KeptInventoryReplay{Text: crdt.EncodeStateAsUpdateV1(doc, nil), Inventory: inventory, Ledger: ledger}, nil
}

func mergeKeptInventory(current, additions []string) []string {
	current = append(current, additions...)
	sort.Strings(current)
	n := 0
	for _, path := range current {
		if n == 0 || current[n-1] != path {
			current[n] = path
			n++
		}
	}
	return current[:n]
}

func inspectInventoryRecord(ledger KeptLedger, record KeptRecord) (KeptInventoryUpdate, KeptInspection, error) {
	if record.Access != AccessEdit {
		return KeptInventoryUpdate{}, KeptInspection{}, errors.New("invalid inventory replay tier")
	}
	operation, err := DecodeKeptInventoryUpdate(record.Message)
	if err != nil {
		return operation, KeptInspection{}, err
	}
	plan, err := ledger.Inspect(record)
	return operation, plan, err
}
