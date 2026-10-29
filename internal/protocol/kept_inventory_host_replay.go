package protocol

import (
	"bytes"
	"errors"
	"sort"

	"github.com/reearth/ygo/crdt"
)

// KeptInventoryObservation is an isolated result, not proof of complete relay
// history, blob availability, source-file durability, or permission to cut.
type KeptInventoryObservation struct {
	Text       []byte
	Comments   []byte
	MetadataID uint64
	Inventory  []string
	Ledger     KeptLedger
}

type inventoryHostReplay struct {
	keys      *KeptRoomKeys
	context   KeptRecordContext
	doc       *crdt.Doc
	inventory []string
	ledger    KeptLedger
	work      uint64
	total     int
}

var errInventoryObservation = errors.New("invalid inventory observation")

// ReplaySignedKeptInventory validates the host-signed inventory-mode checkpoint
// and each signed record. It never mutates input state, writes files or cuts.
// Only edit inventory records are supported; every other record fails closed.
func ReplaySignedKeptInventory(keys *KeptRoomKeys, context KeptCheckpointContext, checkpoint []byte, frames [][]byte) (result KeptInventoryObservation, err error) {
	if len(frames) > MaxKeptReadRecords {
		return result, errInventoryObservation
	}
	plaintext, err := OpenKeptCheckpoint(keys, context, checkpoint)
	if err != nil {
		return result, errInventoryObservation
	}
	payload, err := decodeKeptInventoryCheckpoint(plaintext)
	if err != nil {
		return result, errInventoryObservation
	}
	defer func() {
		if recover() != nil {
			result = KeptInventoryObservation{}
			err = errInventoryObservation
		}
	}()
	replay, metadataID, err := newInventoryHostReplay(keys, context, payload)
	if err != nil {
		return result, err
	}
	defer replay.doc.Destroy()
	for _, frame := range frames {
		if err = replay.apply(frame); err != nil {
			return KeptInventoryObservation{}, err
		}
	}
	return KeptInventoryObservation{Text: crdt.EncodeStateAsUpdateV1(replay.doc, nil), Comments: bytes.Clone(payload.Documents[metadataID]), MetadataID: metadataID, Inventory: replay.inventory, Ledger: replay.ledger}, nil
}
func newInventoryHostReplay(keys *KeptRoomKeys, context KeptCheckpointContext, payload KeptMultiPayload) (*inventoryHostReplay, uint64, error) {
	var metadataID uint64
	for _, file := range payload.Manifest {
		if file.Format == FormatMeta {
			metadataID = file.ID
		}
	}
	if metadataID == 0 || len(payload.Documents[metadataID]) == 0 {
		return nil, 0, errInventoryObservation
	}
	text := payload.Documents[0]
	work, err := KeptTextWork(text, false)
	if err != nil || work > MaxKeptYjsWork {
		return nil, 0, errInventoryObservation
	}
	ledger, err := RestoreKeptLedger(MaxKeptCheckpointReceipts+MaxKeptReadRecords, payload.Ledger.Snapshot())
	if err != nil {
		return nil, 0, errInventoryObservation
	}
	doc := crdt.New()
	ok := false
	defer func() {
		if !ok {
			doc.Destroy()
		}
	}()
	if crdt.ApplyUpdateV1(doc, text, nil) != nil {
		return nil, 0, errInventoryObservation
	}
	if p := doc.PendingStats(); p.Items != 0 || p.DeleteRanges != 0 {
		return nil, 0, errInventoryObservation
	}
	ok = true
	return &inventoryHostReplay{keys: keys, context: KeptRecordContext{RoomID: context.RoomID, Epoch: context.Epoch, Generation: context.Generation}, doc: doc, inventory: append([]string{}, payload.Attachments...), ledger: ledger, work: work}, metadataID, nil
}
func (r *inventoryHostReplay) apply(frame []byte) error {
	r.total += len(frame)
	if len(frame) > MaxFrameBytes || r.total > 16*MaxFrameBytes {
		return errInventoryObservation
	}
	record, err := OpenKeptRecord(r.keys, r.context, frame)
	if err != nil || record.Access != AccessEdit {
		return errInventoryObservation
	}
	// Validate even duplicate records so legacy or unknown formats cannot hide behind a receipt.
	op, err := DecodeKeptInventoryUpdate(record.Message)
	if err != nil {
		return errInventoryObservation
	}
	plan, err := r.ledger.Inspect(record)
	if err != nil {
		return errInventoryObservation
	}
	if plan.Decision == KeptDuplicate {
		return nil
	}
	if plan.Decision != KeptNext {
		return errInventoryObservation
	}
	amount, err := KeptTextWork(op.Update, true)
	if err != nil || amount > MaxKeptYjsWork-r.work {
		return errInventoryObservation
	}
	r.work += amount
	r.inventory = mergeInventoryPaths(r.inventory, op.Additions)
	if len(r.inventory) > MaxKeptInventoryPaths || crdt.ApplyUpdateV1(r.doc, op.Update, nil) != nil {
		return errInventoryObservation
	}
	if p := r.doc.PendingStats(); p.Items != 0 || p.DeleteRanges != 0 {
		return errInventoryObservation
	}
	if CheckKeptTextState(crdt.EncodeStateAsUpdateV1(r.doc, nil)) != nil || !inventoryCoversText(r.doc, r.inventory) {
		return errInventoryObservation
	}
	r.ledger, err = r.ledger.Commit(plan, KeptApplied)
	if err != nil {
		return errInventoryObservation
	}
	return nil
}
func mergeInventoryPaths(current, additions []string) []string {
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
func inventoryCoversText(doc *crdt.Doc, inventory []string) bool {
	for _, p := range keptAssetReference.FindAllString(doc.GetText("content").ToString(), -1) {
		if _, ok := sort.Find(len(inventory), func(i int) int { return bytes.Compare([]byte(p), []byte(inventory[i])) }); !ok {
			return false
		}
	}
	return true
}
