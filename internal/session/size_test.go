package session

import "testing"

func TestMibRoundsUp(t *testing.T) {
	for n, want := range map[int]string{
		2_500_000: "2.4 MiB",
		1_100_000: "1.1 MiB",
		1_048_577: "1.1 MiB",
		661_245:   "0.7 MiB",
		1 << 20:   "1.0 MiB",
	} {
		if got := mib(n); got != want {
			t.Errorf("mib(%d) = %q, want %q", n, got, want)
		}
	}
}

func TestTooLargeErrorMessages(t *testing.T) {
	text := &TooLargeError{File: "/home/me/data.csv", Size: 2_500_000}
	if got, want := text.Error(), "/home/me/data.csv is 2.4 MiB; pedit shares files up to about 1 MiB for now"; got != want {
		t.Errorf("text: got %q, want %q", got, want)
	}
	board := &TooLargeError{File: "/home/me/x.canvas", Size: 661_245, Shared: 1_200_000}
	if got, want := board.Error(), "/home/me/x.canvas is 0.7 MiB, 1.2 MiB once shared as a board; pedit shares up to about 1 MiB for now"; got != want {
		t.Errorf("canvas: got %q, want %q", got, want)
	}
}
