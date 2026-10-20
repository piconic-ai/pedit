package protocol

import (
	"encoding/json"
	"os"
	"testing"
)

// vectors are shared with packages/protocol, which tests the same file.
type closeVectors struct {
	Codes          map[string]int    `json:"codes"`
	Signals        map[string]string `json:"signals"`
	ExpiredReasons []struct {
		Seconds int    `json:"seconds"`
		Reason  string `json:"reason"`
	} `json:"expiredReasons"`
	Unparsed []string `json:"unparsed"`
}

func loadCloseVectors(t *testing.T) closeVectors {
	t.Helper()
	data, err := os.ReadFile("../../packages/testdata/close-codes.json")
	if err != nil {
		t.Fatal(err)
	}
	var v closeVectors
	if err := json.Unmarshal(data, &v); err != nil {
		t.Fatal(err)
	}
	return v
}

func TestCloseCodesMatchTheSharedVectors(t *testing.T) {
	v := loadCloseVectors(t)
	// Every name in the vectors, with the constant this package has for it.
	have := map[string]int{
		"ROOM_CLOSED":       RoomClosed,
		"CLIENT_OUTDATED":   ClientOutdated,
		"SERVER_OUTDATED":   ServerOutdated,
		"ROOM_FULL":         RoomFull,
		"RELAY_BUSY":        RelayBusy,
		"RELAY_MAINTENANCE": RelayMaintenance,
		"ROOM_EXPIRED":      RoomExpired,
		"HOST_LEFT":         HostLeft,
		"MESSAGE_TOO_BIG":   MessageTooBig,
	}
	for name, code := range v.Codes {
		got, ok := have[name]
		if !ok {
			t.Errorf("vectors name %s, which has no Go constant in this test", name)
		} else if got != code {
			t.Errorf("%s = %d, vectors say %d", name, got, code)
		}
	}
	for name := range have {
		if _, ok := v.Codes[name]; !ok {
			t.Errorf("%s is missing from the vectors", name)
		}
	}
}

func TestRelaySignalsMatchTheSharedVectors(t *testing.T) {
	v := loadCloseVectors(t)
	have := map[string]string{"HOST_AWAY": HostAway, "HOST_BACK": HostBack}
	if len(v.Signals) != len(have) {
		t.Errorf("vectors name %d signals, this test %d", len(v.Signals), len(have))
	}
	for name, text := range have {
		if v.Signals[name] != text {
			t.Errorf("%s = %q, vectors say %q", name, text, v.Signals[name])
		}
	}
}

func TestExpiredReasonMatchesTheSharedVectors(t *testing.T) {
	v := loadCloseVectors(t)
	for _, c := range v.ExpiredReasons {
		if got := ExpiredReason(c.Seconds); got != c.Reason {
			t.Errorf("ExpiredReason(%d) = %q, want %q", c.Seconds, got, c.Reason)
		}
		if got, ok := ParseExpiredReason(c.Reason); !ok || got != c.Seconds {
			t.Errorf("ParseExpiredReason(%q) = %d, %v", c.Reason, got, ok)
		}
	}
	for _, reason := range v.Unparsed {
		if got, ok := ParseExpiredReason(reason); ok {
			t.Errorf("ParseExpiredReason(%q) = %d, want none", reason, got)
		}
	}
}
