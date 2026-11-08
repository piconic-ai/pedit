package main

import (
	"net/http"
	"testing"

	"github.com/piconic-ai/pedit/internal/protocol"
)

// redialKeep drops the host's connection and returns the keep header of the
// redial that follows.
func redialKeep(t *testing.T, env *shareEnv) string {
	t.Helper()
	before := len(env.relay.Headers())
	env.relay.DropAll()
	var got string
	eventually(t, "the host's redial", func() bool {
		hs := env.relay.Headers()
		if len(hs) <= before {
			return false
		}
		got = hs[len(hs)-1].Get(protocol.KeepHeader)
		return true
	})
	return got
}

func TestServeKeepIsSentOnAReconnectOfTheSameSession(t *testing.T) {
	env := keptEnv(t)
	env.keep.set(3600)
	a := startApp(t, writeFile(t, "hello\n"))
	room := a.shareKeptAt(env, cmsOrigin)["room"].(string)

	a.command(`{"cmd":"keep","keep":"3d"}`)
	a.event("status", 1)
	if got := redialKeep(t, env); got != "259200" {
		t.Fatalf("redial sent %q", got)
	}
	// The relay's word on the reconnect leaves the record as it is.
	eventually(t, "the record", func() bool { return keptRecord(t, room)["Keep"] == float64(259200) })

	// A definite refusal takes the new keep back.
	env.keep.force(http.StatusConflict)
	a.command(`{"cmd":"keep","keep":"5d"}`)
	a.errorOf(1, "keep", "refused")
	env.keep.force(0)
	if got := redialKeep(t, env); got != "259200" {
		t.Fatalf("redial after a refusal sent %q", got)
	}

	// No answer at all: the relay may have applied it, so the new keep stays.
	env.keep.setDrop(true)
	a.command(`{"cmd":"keep","keep":"2d"}`)
	a.errorOf(2, "keep", "could not reach")
	env.keep.setDrop(false)
	if got := redialKeep(t, env); got != "172800" {
		t.Fatalf("redial after a network failure sent %q", got)
	}
}

func TestServeStatusWhileSharedAndTheRoomEnded(t *testing.T) {
	env := keptEnv(t)
	a := startApp(t, writeFile(t, "hello\n"))
	a.shareKeptAt(env, cmsOrigin)
	env.keep.force(http.StatusGone)
	if e := a.status(1); e["room"] != nil {
		t.Fatalf("%v", e)
	}
	env.keep.force(http.StatusNotFound)
	a.command(`{"cmd":"status"}`)
	a.errorOf(1, "status", "too old")
}
