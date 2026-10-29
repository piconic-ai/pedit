package session

import (
	"strings"
	"testing"
)

func TestFrozenObservationBoundsAndMatching(t *testing.T) {
	var epoch [32]byte
	epoch[0] = 1
	cut := observedFrozenCut{Epoch: "01" + strings.Repeat("00", 31), Generation: 1, Cutoff: 2, Token: "00000000-0000-4000-8000-000000000000"}
	evidence := recoveryEvidence{Epoch: epoch, Generation: 1, Tail: 2, TailStatus: "unverified"}
	if !validObservedCut(cut) || !frozenMatches(cut, evidence) {
		t.Fatal("valid historical observation rejected")
	}
	for _, bad := range []observedFrozenCut{
		{Epoch: strings.Repeat("00", 32), Generation: 1, Cutoff: 2, Token: cut.Token},
		{Epoch: cut.Epoch, Generation: 0, Cutoff: 2, Token: cut.Token},
		{Epoch: cut.Epoch, Generation: 1, Cutoff: 1 << 53, Token: cut.Token},
		{Epoch: cut.Epoch, Generation: 1, Cutoff: 2, Token: "not-a-token"},
	} {
		if validObservedCut(bad) {
			t.Fatal("accepted invalid observed cut")
		}
	}
	cut.Cutoff++
	if frozenMatches(cut, evidence) {
		t.Fatal("accepted mismatched cutoff")
	}
}
