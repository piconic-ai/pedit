package session

import (
	"bytes"
	"context"
	"errors"

	"github.com/piconic-ai/pedit/internal/meta"
	"github.com/piconic-ai/pedit/internal/protocol"
	"github.com/reearth/ygo/crdt"
	ysync "github.com/reearth/ygo/sync"
)

// startKeptRecovery builds an isolated candidate before creating a held,
// disconnected session. The caller must authenticate the checkpoint, provide
// its matching ledger, and establish that the frames contain the complete tail.
// The metadata ID must come from the authenticated single-file manifest.
func startKeptRecovery(ctx context.Context, opts Options, checkpoint recoveryCheckpoint, ledger protocol.KeptLedger, keys *protocol.KeptRoomKeys, recordContext protocol.KeptRecordContext, frames [][]byte) (session *Session, err error) {
	if len(frames) > 1024 {
		return nil, errors.New("too many recovery records")
	}
	if keys == nil {
		return nil, errors.New("missing recovery keys")
	}
	if checkpoint.metaID == 0 || checkpoint.metaID > protocol.MaxFileID {
		return nil, errors.New("invalid recovery metadata id")
	}
	if _, err := protocol.EncodeKeptLedger(ledger); err != nil {
		return nil, err
	}
	defer func() {
		if recover() != nil {
			session, err = nil, errors.New("invalid recovery update")
		}
	}()
	text, comments := crdt.New(), crdt.New()
	defer text.Destroy()
	defer comments.Destroy()
	if err := protocol.CheckKeptTextState(checkpoint.text); err != nil {
		return nil, err
	}
	if err := crdt.ApplyUpdateV1(text, checkpoint.text, nil); err != nil {
		return nil, err
	}
	if err := meta.CheckUpdate(comments, checkpoint.comments); err != nil {
		return nil, err
	}
	if err := crdt.ApplyUpdateV1(comments, checkpoint.comments, nil); err != nil {
		return nil, err
	}
	if p := text.PendingStats(); p.Items != 0 || p.DeleteRanges != 0 {
		return nil, errors.New("incomplete checkpoint")
	}
	var total int
	for _, frame := range frames {
		if len(frame) > protocol.MaxFrameBytes {
			return nil, errors.New("recovery record too large")
		}
		total += len(frame)
		if total > 16*protocol.MaxFrameBytes {
			return nil, errors.New("recovery tail too large")
		}
		record, err := protocol.OpenKeptRecord(keys, recordContext, frame)
		if err != nil {
			return nil, err
		}
		plan, err := ledger.Inspect(record)
		if err != nil || plan.Decision != protocol.KeptNext {
			return nil, errors.New("invalid recovery sequence")
		}
		messageType, payload, err := protocol.DecodeMessage(record.Message)
		if err != nil {
			return nil, err
		}
		doc := text
		isComments := false
		switch messageType {
		case protocol.MessageSync:
			if record.Access != protocol.AccessEdit {
				return nil, errors.New("invalid recovery permission")
			}
		case protocol.MessageFiles:
			file, err := protocol.DecodeFiles(payload)
			if err != nil || file.Kind != protocol.FilesDoc || file.File != checkpoint.metaID || file.Type != protocol.MessageSync {
				return nil, errors.New("invalid recovery file")
			}
			canonical, err := protocol.EncodeFileDoc(file.File, file.Type, file.Payload)
			if err != nil || !bytes.Equal(canonical, payload) {
				return nil, errors.New("invalid recovery file encoding")
			}
			payload, doc, isComments = file.Payload, comments, true
		default:
			return nil, errors.New("unsupported recovery operation")
		}
		kind, update, err := ysync.ReadSyncMessage(payload)
		if err != nil || kind != ysync.MsgUpdate || len(update) == 0 || !bytes.Equal(payload, ysync.EncodeUpdate(update)) {
			return nil, errors.New("invalid recovery sync")
		}
		if isComments {
			doc = comments
			if err := meta.CheckUpdate(doc, update); err != nil {
				return nil, err
			}
		}
		next, err := ledger.Commit(plan, protocol.KeptApplied)
		if err != nil {
			return nil, err
		}
		if err := crdt.ApplyUpdateV1(doc, update, nil); err != nil {
			return nil, err
		}
		if p := doc.PendingStats(); p.Items != 0 || p.DeleteRanges != 0 {
			return nil, errors.New("incomplete recovery update")
		}
		if !isComments {
			state := crdt.EncodeStateAsUpdateV1(doc, nil)
			if err := protocol.CheckKeptTextState(state); err != nil {
				return nil, err
			}
		}
		ledger = next
	}
	checkpoint.text = crdt.EncodeStateAsUpdateV1(text, nil)
	checkpoint.comments = crdt.EncodeStateAsUpdateV1(comments, nil)
	checkpoint.ledger = ledger
	return start(ctx, opts, &checkpoint)
}
