package session

import (
	"testing"

	"github.com/piconic-ai/pedit/internal/protocol"
)

func TestEvidenceEntryBounds(t *testing.T) {
	valid := recoveryEvidence{Cutoff: 5, Tail: 9, Entries: []evidenceEntry{{Sequence: 7, Ciphertext: []byte{1}}, {Sequence: 9, Ciphertext: []byte{2}}}}
	if _, err := evidenceFrames(valid); err != nil {
		t.Fatal(err)
	}
	for _, bad := range []recoveryEvidence{
		{Cutoff: 5, Tail: 9, Entries: []evidenceEntry{{Sequence: 5, Ciphertext: []byte{1}}, {Sequence: 9, Ciphertext: []byte{2}}}},
		{Cutoff: 5, Tail: 9, Entries: []evidenceEntry{{Sequence: 7, Ciphertext: []byte{1}}}},
		{Cutoff: 5, Tail: 9, Entries: []evidenceEntry{{Sequence: 9, Ciphertext: nil}}},
		{Cutoff: 5, Tail: 9, Entries: []evidenceEntry{{Sequence: 9, Ciphertext: make([]byte, protocol.MaxFrameBytes+1)}}},
	} {
		if _, err := evidenceFrames(bad); err == nil {
			t.Fatal("accepted invalid evidence entries")
		}
	}
	block := make([]byte, protocol.MaxFrameBytes)
	read := protocol.KeptReadInspection{Frames: make([][]byte, 11), Sequences: make([]uint64, 11)}
	for i := range read.Frames {
		read.Frames[i] = block
		read.Sequences[i] = uint64(i + 1)
	}
	if _, err := makeEvidenceEntries(read, []byte{1}); err == nil {
		t.Fatal("accepted evidence beyond byte limit")
	}
	read.Sequences = nil
	if _, err := makeEvidenceEntries(read, nil); err == nil {
		t.Fatal("accepted missing sequences")
	}
}
