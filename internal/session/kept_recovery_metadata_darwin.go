//go:build darwin

package session

import (
	"bytes"
	"errors"
	"path/filepath"
	"reflect"

	"github.com/piconic-ai/pedit/internal/hoststate"
	"github.com/piconic-ai/pedit/internal/meta"
	"github.com/reearth/ygo/crdt"
)

// recoveryMetadata returns a proposal, never permission to write or cut.
// Paths remain available on conflict after the intent signature is verified.
func recoveryMetadata(store *hoststate.Store, room, intentPath string) (view recoveryIntentView, output []byte, err error) {
	view, err = openRecoveryIntent(store, room, intentPath)
	if err != nil {
		return view, nil, err
	}
	verified, err := verifyRecoveryBundle(store, room, view.Paths.BundlePath)
	if err != nil || !bytes.Equal(verified.view.Text, view.NewText) || !bytes.Equal(verified.evidence.Comments, view.CommentsYjs) {
		return view, nil, errors.New("recovery candidate changed")
	}
	baseline, err := loadKeptInitial(verified.credentials)
	if err != nil {
		return view, nil, err
	}
	rel, err := filepath.Rel(baseline.Project, baseline.File)
	if err != nil || !filepath.IsLocal(rel) {
		return view, nil, errors.New("invalid metadata path")
	}
	old := &meta.File{Path: filepath.ToSlash(rel)}
	if baseline.CommentsExists {
		old, err = meta.Parse([]byte(baseline.Comments))
		if err != nil || old.Path != filepath.ToSlash(rel) {
			return view, nil, errors.New("invalid baseline metadata")
		}
	}
	textDoc, commentDoc := crdt.New(), crdt.New()
	defer textDoc.Destroy()
	defer commentDoc.Destroy()
	if crdt.ApplyUpdateV1(textDoc, verified.evidence.Text, nil) != nil || crdt.ApplyUpdateV1(commentDoc, verified.evidence.Comments, nil) != nil || textDoc.GetText(meta.ContentText).ToString() != string(view.NewText) {
		return view, nil, errors.New("invalid recovery state")
	}
	tracker := meta.NewTracker(textDoc)
	defer tracker.Close()
	output, err = meta.RenderRecovery(commentDoc, old, tracker)
	if err != nil {
		return view, nil, err
	}
	current, err := store.Load(room)
	if err != nil || !reflect.DeepEqual(current, verified.credentials) {
		return view, nil, errors.New("recovery credentials changed")
	}
	if _, err = openRecoveryIntent(store, room, intentPath); err != nil {
		return view, nil, err
	}
	view.MetadataStatus = "proposal-only"
	return view, output, nil
}
