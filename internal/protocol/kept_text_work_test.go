package protocol

import "testing"

func TestKeptTextWorkCountsDeleteBoundarySplits(t *testing.T) {
	// One delete range can split both ends of a preexisting struct.
	input := []byte{0, 1, 1, 1, 0, 1}
	work, err := KeptTextWork(input, true)
	if err != nil || work != 2 {
		t.Fatalf("delete work: %d %v", work, err)
	}
	if _, err = KeptTextWork(append(input, 0), true); err == nil {
		t.Fatal("accepted trailing bytes")
	}
}
