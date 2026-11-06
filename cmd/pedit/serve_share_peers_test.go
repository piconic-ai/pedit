package main

import (
	"fmt"
	"strings"
	"testing"
	"unicode/utf8"

	"github.com/piconic-ai/pedit/internal/protocol"
	"github.com/piconic-ai/pedit/internal/session"
)

func TestPeersEventCapsPeopleAndNames(t *testing.T) {
	var people []session.Person
	for i := 0; i < 70; i++ {
		people = append(people, session.Person{Name: fmt.Sprintf("p%d", i), Access: protocol.AccessEdit})
	}
	ev := peersEvent(people)
	if got := len(ev["peers"].([]map[string]string)); got != maxPeers {
		t.Fatalf("%d peers", got)
	}
	if ev["more"] != 6 {
		t.Fatalf("more = %v", ev["more"])
	}
	if _, ok := peersEvent(people[:3])["more"]; ok {
		t.Fatal("more with nobody left out")
	}
}

func TestPeersEventCutsNamesOnACharacter(t *testing.T) {
	// 3-byte characters: 64 is not a multiple of 3, so the cut must step back.
	name := strings.Repeat("あ", 40)
	ev := peersEvent([]session.Person{{Name: name, Access: protocol.AccessRead}})
	got := ev["peers"].([]map[string]string)[0]["name"]
	if len(got) != 63 || !utf8.ValidString(got) {
		t.Fatalf("%d bytes, valid %v", len(got), utf8.ValidString(got))
	}
}
