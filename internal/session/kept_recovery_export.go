package session

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"path/filepath"
	"unicode/utf8"

	"github.com/piconic-ai/pedit/internal/hoststate"
	"github.com/piconic-ai/pedit/internal/meta"
	"github.com/piconic-ai/pedit/internal/protocol"
	"github.com/reearth/ygo/crdt"
)

type recoveryExport struct {
	Version             int             `json:"version"`
	RoomID              string          `json:"roomId"`
	Path                string          `json:"path"`
	MetadataID          uint64          `json:"metadataId"`
	TextComparison      string          `json:"textComparison"`
	ObservedLocalSHA256 string          `json:"observedLocalSha256,omitempty"`
	Text                string          `json:"text"`
	TextYjs             []byte          `json:"textYjs"`
	CommentsYjs         []byte          `json:"commentsYjs"`
	CommentsView        json.RawMessage `json:"commentsView,omitempty"`
	Tail                string          `json:"tail"`
	Attachments         string          `json:"attachments"`
}

// exportVerifiedRecovery retains the authenticated replay without reading or
// opening the local file. The result remains an unverified-tail inspection.
func exportVerifiedRecovery(store *hoststate.Store, room, path string, cp recoveryCheckpoint) (string, error) {
	if _, _, err := recoveryCheckpointWork(cp.text, cp.comments); err != nil {
		return "", err
	}
	text := crdt.New()
	defer text.Destroy()
	if err := crdt.ApplyUpdateV1(text, cp.text, nil); err != nil {
		return "", err
	}
	comments := crdt.New()
	defer comments.Destroy()
	if err := crdt.ApplyUpdateV1(comments, cp.comments, nil); err != nil {
		return "", err
	}
	out := recoveryExport{Version: 1, RoomID: room, Path: path, MetadataID: cp.metaID, TextComparison: "unavailable", Text: text.GetText("content").ToString(), TextYjs: cp.text, CommentsYjs: cp.comments, Tail: "unverified", Attachments: "unverified"}
	if view, err := comments.GetMap(meta.CommentsKey).ToJSON(); err == nil {
		out.CommentsView = view
	}
	data, err := json.MarshalIndent(out, "", "  ")
	if err != nil {
		return "", err
	}
	return store.PublishCandidate(room, append(data, '\n'))
}

// exportRecoveryCandidate writes only a separate, private candidate; the
// comparison is an observation, not permission to overwrite the local file.
func (c *keptRecoveryCandidate) exportRecoveryCandidate(store *hoststate.Store, room string) (string, error) {
	if c == nil || c.session == nil || c.session.recovery == nil || c.session.meta == nil || store == nil || c.room != room {
		return "", errors.New("recovery candidate unavailable")
	}
	s := c.session
	out := recoveryExport{Version: 1, RoomID: room, TextComparison: "unavailable", Tail: "unverified", Attachments: "unverified"}
	err := func() error {
		s.filesMu.Lock()
		defer s.filesMu.Unlock()
		if s.closed {
			return errors.New("recovery session is closed")
		}
		out.Path = s.sharedFile.path
		out.MetadataID = s.meta.id
		var snapshotErr error
		s.Client.Do(func() {
			out.TextYjs = crdt.EncodeStateAsUpdateV1(s.Doc, nil)
			out.CommentsYjs = crdt.EncodeStateAsUpdateV1(s.meta.doc, nil)
			if _, _, snapshotErr = recoveryCheckpointWork(out.TextYjs, out.CommentsYjs); snapshotErr != nil {
				return
			}
			if p := s.Doc.PendingStats(); p.Items != 0 || p.DeleteRanges != 0 {
				snapshotErr = errors.New("incomplete recovered text")
				return
			}
			check := crdt.New()
			defer check.Destroy()
			if snapshotErr = meta.CheckRecoveryUpdate(check, out.CommentsYjs); snapshotErr != nil {
				return
			}
			if snapshotErr = crdt.ApplyUpdateV1(check, out.CommentsYjs, nil); snapshotErr != nil {
				return
			}
			if view, err := check.GetMap(meta.CommentsKey).ToJSON(); err == nil {
				out.CommentsView = view
			}
			out.Text = s.content.render()
		})
		if snapshotErr != nil {
			return snapshotErr
		}
		local, ok := s.bound.ReadLimited(protocol.MaxFrameBytes)
		if ok && utf8.ValidString(local) {
			digest := sha256.Sum256([]byte(local))
			out.ObservedLocalSHA256 = hex.EncodeToString(digest[:])
			if local == out.Text {
				out.TextComparison = "equal"
			} else {
				out.TextComparison = "conflict"
			}
		}
		return nil
	}()
	if err != nil {
		return "", err
	}
	b, err := json.MarshalIndent(out, "", "  ")
	if err != nil {
		return "", errors.New("cannot encode recovery candidate")
	}
	b = append(b, '\n')
	return store.PublishCandidate(room, b)
}

// openRecoveryExport reopens a local candidate only as a held inspection. It
// does not authenticate the file as a checkpoint or restore an accepted ledger.
func openRecoveryExport(ctx context.Context, opts Options, store *hoststate.Store, room, path string) (*keptRecoveryCandidate, error) {
	if store == nil {
		return nil, errors.New("recovery candidate unavailable")
	}
	data, err := store.ReadCandidate(room, path)
	if err != nil {
		return nil, err
	}
	var candidate recoveryExport
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	if decoder.Decode(&candidate) != nil || decoder.Decode(&struct{}{}) != io.EOF {
		return nil, errors.New("invalid recovery candidate")
	}
	canonical, err := json.MarshalIndent(candidate, "", "  ")
	if err != nil || !bytes.Equal(append(canonical, '\n'), data) {
		return nil, errors.New("invalid recovery candidate")
	}
	if candidate.Version != 1 || candidate.RoomID != room || candidate.MetadataID == 0 || candidate.MetadataID > protocol.MaxFileID || candidate.Tail != "unverified" || candidate.Attachments != "unverified" || !utf8.ValidString(candidate.Text) {
		return nil, errors.New("invalid recovery candidate")
	}
	if !validComparison(candidate) {
		return nil, errors.New("invalid recovery comparison")
	}
	root := opts.Root
	if root == "" {
		root = filepath.Dir(opts.File)
	}
	root, err = filepath.Abs(root)
	if err != nil || candidate.Path != sharedPath(root, opts.File) {
		return nil, errors.New("recovery file mismatch")
	}
	if _, _, err = recoveryCheckpointWork(candidate.TextYjs, candidate.CommentsYjs); err != nil {
		return nil, err
	}
	text := crdt.New()
	defer text.Destroy()
	if err = crdt.ApplyUpdateV1(text, candidate.TextYjs, nil); err != nil {
		return nil, err
	}
	if p := text.PendingStats(); p.Items != 0 || p.DeleteRanges != 0 {
		return nil, errors.New("incomplete recovery text")
	}
	if text.GetText("content").ToString() != candidate.Text {
		return nil, errors.New("invalid recovery text")
	}
	if err = validateRecoveryComments(candidate); err != nil {
		return nil, err
	}
	s, err := start(ctx, opts, &recoveryCheckpoint{text: candidate.TextYjs, comments: candidate.CommentsYjs, metaID: candidate.MetadataID})
	if err != nil {
		return nil, err
	}
	return &keptRecoveryCandidate{session: s, room: room, tailStatus: "tail-unverified", attachmentStatus: "attachments-unverified"}, nil
}

// The comparison and hash are an untrusted historical observation, not an
// authorization to write. Their internal consistency can still be checked.
func validComparison(candidate recoveryExport) bool {
	if candidate.TextComparison == "unavailable" {
		return candidate.ObservedLocalSHA256 == ""
	}
	if candidate.TextComparison != "equal" && candidate.TextComparison != "conflict" {
		return false
	}
	hash, err := hex.DecodeString(candidate.ObservedLocalSHA256)
	if err != nil || len(hash) != sha256.Size || hex.EncodeToString(hash) != candidate.ObservedLocalSHA256 {
		return false
	}
	guest := sha256.Sum256([]byte(candidate.Text))
	equal := bytes.Equal(hash, guest[:])
	return equal == (candidate.TextComparison == "equal")
}

func validateRecoveryComments(candidate recoveryExport) error {
	if err := protocol.CheckKeptCommentsState(candidate.CommentsYjs); err != nil {
		return err
	}
	comments := crdt.New()
	defer comments.Destroy()
	if err := meta.CheckRecoveryUpdate(comments, candidate.CommentsYjs); err != nil {
		return err
	}
	if err := crdt.ApplyUpdateV1(comments, candidate.CommentsYjs, nil); err != nil {
		return err
	}
	view, viewErr := comments.GetMap(meta.CommentsKey).ToJSON()
	if viewErr != nil {
		if len(candidate.CommentsView) != 0 {
			return errors.New("invalid recovery comments view")
		}
	} else {
		var compact bytes.Buffer
		if json.Compact(&compact, candidate.CommentsView) != nil || !bytes.Equal(compact.Bytes(), view) {
			return errors.New("invalid recovery comments view")
		}
	}
	return nil
}
