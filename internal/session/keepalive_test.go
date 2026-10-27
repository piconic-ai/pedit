package session

import (
	"sync/atomic"
	"testing"
	"time"

	"github.com/reearth/ygo/awareness"
)

// Chrome wakes the timers of a tab hidden for 5 minutes at most this often.
const throttledRenewal = time.Minute

// The real timings scaled down 60 times, so a minute takes a second.
const scale = 60

// A guest in a background tab renews its state once a minute and must stay in
// the room; once it goes silent it is dropped after the timeout (#193).
func TestKeepAliveToleratesThrottledRenewal(t *testing.T) {
	timeout, renew, peerRenew := outdatedTimeout/scale, renewInterval/scale, throttledRenewal/scale

	host := awareness.New(1)
	host.SetLocalState(map[string]any{"user": "host"})
	var removedAt atomic.Int64
	host.OnChange(func(e awareness.ChangeEvent) {
		for _, id := range e.Removed {
			if id == 2 {
				removedAt.CompareAndSwap(0, time.Now().UnixNano())
			}
		}
	})
	stop := keepAliveFor(host, timeout, renew)
	defer stop()

	guest := awareness.New(2)
	guest.SetLocalState(map[string]any{"user": "guest"})
	renewGuest := func() {
		guest.Heartbeat()
		if err := host.ApplyUpdate(guest.EncodeUpdate([]uint64{2}), "relay"); err != nil {
			t.Fatal(err)
		}
	}
	renewGuest()
	for range 3 {
		time.Sleep(peerRenew)
		renewGuest()
	}
	if at := removedAt.Load(); at != 0 {
		t.Fatalf("dropped a guest renewing every %v", throttledRenewal)
	}
	lastRenewal := time.Now()

	deadline := lastRenewal.Add(2 * timeout)
	for removedAt.Load() == 0 && time.Now().Before(deadline) {
		time.Sleep(timeout / 20)
	}
	at := removedAt.Load()
	if at == 0 {
		t.Fatalf("a silent guest is still present after %v", 2*timeout)
	}
	if silent := time.Unix(0, at).Sub(lastRenewal); silent < timeout {
		t.Fatalf("dropped a silent guest after %v, before the timeout of %v", silent, timeout)
	}
	if _, ok := host.GetStates()[1]; !ok {
		t.Fatal("the host dropped its own state")
	}
}

// The host renews its own state at least as often as y-protocols expects, so
// peers that still drop after 30 s keep it.
func TestKeepAliveRenewsWithinThirtySeconds(t *testing.T) {
	if renewInterval > 15*time.Second {
		t.Fatalf("renewInterval = %v; older peers drop a state silent for 30 s", renewInterval)
	}
	host := awareness.New(1)
	host.SetLocalState(map[string]any{})
	before, _ := host.Meta(1)
	stop := keepAliveFor(host, outdatedTimeout/scale, renewInterval/scale)
	time.Sleep(renewInterval/scale + renewInterval/scale/2)
	stop()
	after, _ := host.Meta(1)
	if after.Clock <= before.Clock {
		t.Fatalf("clock %d did not advance from %d", after.Clock, before.Clock)
	}
}
