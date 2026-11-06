package main

import (
	"fmt"
	"testing"
)

// Every event that answers a command carries its id; the ones nobody asked
// for carry none.
func TestServeAnswersCarryTheCommandID(t *testing.T) {
	env := newShareEnv(t)
	file := writeFile(t, "hi\n")
	a := startApp(t, file)

	a.command(fmt.Sprintf(`{"cmd":"share","keep":"0","relay":%q,"id":"s1"}`, env.server.URL))
	if e := a.event("shared", 1); e["id"] != "s1" {
		t.Fatalf("%v", e)
	}
	a.command(`{"cmd":"unshare","id":"u1"}`)
	if e := a.event("unshared", 1); e["id"] != "u1" {
		t.Fatalf("%v", e)
	}
	a.command(`{"cmd":"unshare","id":"u2"}`)
	if e := a.event("error", 1); e["id"] != "u2" || e["cmd"] != "unshare" {
		t.Fatalf("%v", e)
	}
	// A live room closed is an unshare, and answered with the id too.
	a.command(fmt.Sprintf(`{"cmd":"share","keep":"0","relay":%q}`, env.server.URL))
	if e := a.event("shared", 2); e["id"] != nil {
		t.Fatalf("a command without an id was answered with one: %v", e)
	}
	a.command(`{"cmd":"close","id":"c1"}`)
	if e := a.event("unshared", 2); e["id"] != "c1" {
		t.Fatalf("%v", e)
	}
	// A command that does not parse is still answered with its id when it has one.
	a.command(`{"cmd":"share","keep":"soon","id":"bad"}`)
	if e := a.event("error", 2); e["id"] != "bad" {
		t.Fatalf("%v", e)
	}
	if code := a.stop(); code != 0 {
		t.Fatalf("code %d, stderr %s", code, a.stderr.String())
	}
}
