package session

import (
	"bytes"
	"context"
	"errors"
	"regexp"

	"github.com/piconic-ai/pedit/internal/meta"
	"github.com/piconic-ai/pedit/internal/protocol"
	"github.com/reearth/ygo/crdt"
	ysync "github.com/reearth/ygo/sync"
)

var keptAttachment = regexp.MustCompile(`assets/[0-9a-f]{32}\.(png|jpg|gif|webp)`)

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
	if err := meta.CheckRecoveryUpdate(comments, checkpoint.comments); err != nil {
		return nil, err
	}
	if err := crdt.ApplyUpdateV1(comments, checkpoint.comments, nil); err != nil {
		return nil, err
	}
	if p := text.PendingStats(); p.Items != 0 || p.DeleteRanges != 0 {
		return nil, errors.New("incomplete checkpoint")
	}
	if keptAttachment.MatchString(text.GetText("content").ToString()) {
		return nil, errors.New("recovery attachments unavailable")
	}
	r := keptReplayer{text: text, comments: comments, ledger: ledger, keys: keys, context: recordContext, metaID: checkpoint.metaID}
	for _, frame := range frames {
		if err := r.apply(frame); err != nil {
			return nil, err
		}
	}
	ledger = r.ledger
	checkpoint.text = crdt.EncodeStateAsUpdateV1(text, nil)
	checkpoint.comments = crdt.EncodeStateAsUpdateV1(comments, nil)
	checkpoint.ledger = ledger
	return start(ctx, opts, &checkpoint)
}

type keptReplayer struct {
	text, comments *crdt.Doc
	ledger         protocol.KeptLedger
	keys           *protocol.KeptRoomKeys
	context        protocol.KeptRecordContext
	metaID         uint64
	total          int
}

func (r *keptReplayer) apply(frame []byte) error {
	if len(frame) > protocol.MaxFrameBytes {
		return errors.New("recovery record too large")
	}
	r.total += len(frame)
	if r.total > 16*protocol.MaxFrameBytes {
		return errors.New("recovery tail too large")
	}
	record, err := protocol.OpenKeptRecord(r.keys, r.context, frame)
	if err != nil {
		return err
	}
	plan, err := r.ledger.Inspect(record)
	if err != nil {
		return errors.New("invalid recovery sequence")
	}
	if plan.Decision == protocol.KeptDuplicate {
		if plan.Outcome != protocol.KeptApplied && plan.Outcome != protocol.KeptRejected {
			return errors.New("invalid recovery receipt")
		}
		return nil
	}
	if plan.Decision != protocol.KeptNext {
		return errors.New("invalid recovery sequence")
	}
	doc, update, isComments, err := r.decode(record)
	if err != nil {
		return err
	}
	if err = checkRecoveryUpdate(doc, update, isComments); err != nil {
		return err
	}
	next, err := r.ledger.Commit(plan, protocol.KeptApplied)
	if err != nil {
		return err
	}
	if err = crdt.ApplyUpdateV1(doc, update, nil); err != nil {
		return err
	}
	if p := doc.PendingStats(); p.Items != 0 || p.DeleteRanges != 0 {
		return errors.New("incomplete recovery update")
	}
	if err = checkRecoveryState(doc, isComments); err != nil {
		return err
	}
	r.ledger = next
	return nil
}

func (r *keptReplayer) decode(record protocol.KeptRecord) (*crdt.Doc, []byte, bool, error) {
	kind, payload, err := protocol.DecodeMessage(record.Message)
	if err != nil {
		return nil, nil, false, err
	}
	doc := r.text
	comments := false
	switch kind {
	case protocol.MessageSync:
		if record.Access != protocol.AccessEdit {
			return nil, nil, false, errors.New("invalid recovery permission")
		}
	case protocol.MessageFiles:
		file, e := protocol.DecodeFiles(payload)
		if e != nil || file.Kind != protocol.FilesDoc || file.File != r.metaID || file.Type != protocol.MessageSync {
			return nil, nil, false, errors.New("invalid recovery file")
		}
		canonical, e := protocol.EncodeFileDoc(file.File, file.Type, file.Payload)
		if e != nil || !bytes.Equal(canonical, payload) {
			return nil, nil, false, errors.New("invalid recovery file encoding")
		}
		payload, doc, comments = file.Payload, r.comments, true
	default:
		return nil, nil, false, errors.New("unsupported recovery operation")
	}
	syncKind, update, err := ysync.ReadSyncMessage(payload)
	if err != nil || syncKind != ysync.MsgUpdate || len(update) == 0 || !bytes.Equal(payload, ysync.EncodeUpdate(update)) {
		return nil, nil, false, errors.New("invalid recovery sync")
	}
	return doc, update, comments, nil
}

func checkRecoveryUpdate(doc *crdt.Doc, update []byte, comments bool) error {
	if !comments {
		return protocol.CheckKeptTextUpdate(update)
	}
	return meta.CheckRecoveryUpdate(doc, update)
}

func checkRecoveryState(doc *crdt.Doc, comments bool) error {
	if comments {
		return nil
	}
	state := crdt.EncodeStateAsUpdateV1(doc, nil)
	if err := protocol.CheckKeptTextState(state); err != nil {
		return err
	}
	if keptAttachment.MatchString(doc.GetText("content").ToString()) {
		return errors.New("recovery attachments unavailable")
	}
	return nil
}
