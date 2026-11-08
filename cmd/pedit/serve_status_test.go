package main

import (
	"encoding/json"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/piconic-ai/pedit/internal/protocol"
)

// fakeKeep is the relay's GET and POST /api/rooms/:id/keep, as far as serve's
// commands need: the Worker's own behaviour is tested in packages/worker.
type fakeKeep struct {
	mu sync.Mutex
	// forced is a status to answer with instead (404 for a relay too old, 410
	// for a room that ended, 409 for a refusal).
	forced int
	// away says the host is away; live that the room has no keep.
	away, live bool
	secs       int64
	// onKeep is told of a change that was accepted.
	onKeep func(int64)
	reqs   []fakeKeepRequest
}

type fakeKeepRequest struct{ method, auth, keep string }

func (f *fakeKeep) set(secs int64) { f.mu.Lock(); f.secs = secs; f.mu.Unlock() }
func (f *fakeKeep) force(code int) { f.mu.Lock(); f.forced = code; f.mu.Unlock() }
func (f *fakeKeep) setAway(v bool) { f.mu.Lock(); f.away = v; f.mu.Unlock() }
func (f *fakeKeep) setLive(v bool) { f.mu.Lock(); f.live = v; f.mu.Unlock() }

func (f *fakeKeep) requests() []fakeKeepRequest {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]fakeKeepRequest{}, f.reqs...)
}

func (f *fakeKeep) serve(w http.ResponseWriter, r *http.Request) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.reqs = append(f.reqs, fakeKeepRequest{r.Method, r.Header.Get("Authorization"), r.Header.Get(protocol.KeepHeader)})
	if f.forced != 0 {
		w.WriteHeader(f.forced)
		return
	}
	if r.Method == http.MethodPost {
		secs, err := strconv.ParseInt(r.Header.Get(protocol.KeepHeader), 10, 64)
		if f.away || f.live || err != nil || secs <= 0 {
			w.WriteHeader(http.StatusConflict)
			return
		}
		f.secs = secs
		if f.onKeep != nil {
			f.onKeep(secs)
		}
	}
	secs, host := f.secs, "here"
	if f.live {
		secs = 0
	}
	if f.away {
		host = "away"
	}
	now := time.Now()
	_ = json.NewEncoder(w).Encode(map[string]any{
		"keep": secs, "host": host,
		"ends":    now.Add(time.Duration(secs) * time.Second).UnixMilli(),
		"lifeEnd": now.Add(7 * 24 * time.Hour).UnixMilli(),
	})
}

// status sends a status command and waits for its n-th answer.
func (a *app) status(n int) map[string]any {
	a.t.Helper()
	a.command(fmt.Sprintf(`{"cmd":"status","id":"s%d"}`, n))
	e := a.event("status", n)
	if e["id"] != fmt.Sprintf("s%d", n) {
		a.t.Fatalf("status %v", e)
	}
	return e
}

func (a *app) errorOf(n int, cmd, contains string) {
	a.t.Helper()
	e := a.event("error", n)
	if msg, _ := e["message"].(string); e["cmd"] != cmd || !strings.Contains(msg, contains) {
		a.t.Fatalf("error %v, want %s containing %q", e, cmd, contains)
	}
}

func TestServeStatusWithNothingKept(t *testing.T) {
	env := keptEnv(t)
	a := startApp(t, writeFile(t, "hello\n"))
	if e := a.status(1); e["room"] != nil || e["id"] != "s1" {
		t.Fatalf("%v", e)
	}
	if got := env.keep.requests(); len(got) != 0 {
		t.Fatalf("asked the relay with no record: %v", got)
	}
}

func TestServeStatusWhileSharedAndKeptAway(t *testing.T) {
	env := keptEnv(t)
	env.keep.set(3600)
	file := writeFile(t, "hello\n")
	a := startApp(t, file)
	shared := a.shareKeptAt(env, cmsOrigin)
	room := shared["room"].(string)

	e := a.status(1)
	if e["room"] != room || e["host"] != "here" || e["keep"] != float64(3600) || fmt.Sprint(e["links"]) != fmt.Sprint(shared["links"]) {
		t.Fatalf("status %v, shared %v", e, shared)
	}
	if e["ends"].(float64) <= float64(time.Now().UnixMilli()) || e["lifeEnd"].(float64) <= e["ends"].(float64) {
		t.Fatalf("times in %v", e)
	}
	reqs := env.keep.requests()
	if len(reqs) != 1 || reqs[0].method != "GET" || !strings.HasPrefix(reqs[0].auth, "Bearer host-token-") {
		t.Fatalf("requests %v", reqs)
	}

	a.command(`{"cmd":"unshare"}`)
	waitLeft(t, room)
	env.keep.setAway(true)
	// Nothing is shared now: the record answers, and so does an app that restarted.
	away := a.status(2)
	if away["room"] != room || away["host"] != "away" || fmt.Sprint(away["links"]) != fmt.Sprint(shared["links"]) {
		t.Fatalf("away %v", away)
	}
	if code := a.stop(); code != 0 {
		t.Fatalf("code %d, stderr %s", code, a.stderr.String())
	}
	b := startApp(t, file)
	if again := b.status(1); again["room"] != room || again["host"] != "away" || fmt.Sprint(again["links"]) != fmt.Sprint(shared["links"]) {
		t.Fatalf("after a restart %v", again)
	}

	// The relay says the room ended: nothing is kept for the file.
	env.keep.force(http.StatusGone)
	if e := b.status(2); e["room"] != nil {
		t.Fatalf("%v", e)
	}
	// A relay without the endpoint: an error, and the record stays.
	env.keep.force(http.StatusNotFound)
	b.command(`{"cmd":"status","id":"x"}`)
	b.errorOf(1, "status", "too old")
	keptRecord(t, room)
}

func TestServeStatusAfterClose(t *testing.T) {
	env := keptEnv(t)
	file := writeFile(t, "hello\n")
	a := startApp(t, file)
	room := a.shareKeptAt(env, cmsOrigin)["room"].(string)
	a.command(`{"cmd":"unshare"}`)
	waitLeft(t, room)
	a.command(`{"cmd":"close"}`)
	a.event("room_ended", 1)
	if e := a.status(1); e["room"] != nil {
		t.Fatalf("%v", e)
	}
}

func TestServeStatusOfALiveRoom(t *testing.T) {
	env := keptEnv(t)
	env.keep.setLive(true)
	a := startApp(t, writeFile(t, "hello\n"))
	shared := a.share(fmt.Sprintf(`,"relay":%q`, env.server.URL))
	e := a.status(1)
	if e["room"] != shared["room"] || e["host"] != "here" || e["keep"] != float64(0) || fmt.Sprint(e["links"]) != fmt.Sprint(shared["links"]) {
		t.Fatalf("status %v, shared %v", e, shared)
	}
}

func TestServeKeepChangesTheKeep(t *testing.T) {
	env := keptEnv(t)
	env.keep.set(3600)
	file := writeFile(t, "hello\n")
	a := startApp(t, file)
	shared := a.shareKeptAt(env, cmsOrigin)
	room := shared["room"].(string)
	before := a.status(1)

	a.command(`{"cmd":"keep","keep":"3d","id":"k1"}`)
	e := a.event("status", 2)
	if e["id"] != "k1" || e["room"] != room || e["host"] != "here" || e["keep"] != float64(3*24*3600) || e["ends"].(float64) <= before["ends"].(float64) {
		t.Fatalf("keep answered %v, before %v", e, before)
	}
	reqs := env.keep.requests()
	if last := reqs[len(reqs)-1]; last.method != "POST" || last.keep != "259200" || !strings.HasPrefix(last.auth, "Bearer host-token-") {
		t.Fatalf("requests %v", reqs)
	}
	eventually(t, "the record holds the new keep", func() bool { return keptRecord(t, room)["Keep"] == float64(3*24*3600) })

	// Leaving and sharing again takes the room up with the keep it has now.
	a.command(`{"cmd":"unshare"}`)
	waitLeft(t, room)
	a.command(fmt.Sprintf(`{"cmd":"share","relay":%q,"origins":[%q]}`, env.server.URL, cmsOrigin))
	a.event("shared", 2)
	hs := env.relay.Headers()
	if got := hs[len(hs)-1].Get(protocol.KeepHeader); got != "259200" {
		t.Fatalf("resume sent %s = %q", protocol.KeepHeader, got)
	}
}

func TestServeShareThatResumesSendsTheNewKeep(t *testing.T) {
	env := keptEnv(t)
	a := startApp(t, writeFile(t, "hello\n"))
	room := a.shareKeptAt(env, cmsOrigin)["room"].(string)
	a.command(`{"cmd":"unshare"}`)
	waitLeft(t, room)

	a.command(fmt.Sprintf(`{"cmd":"share","keep":"2d","relay":%q,"origins":[%q]}`, env.server.URL, cmsOrigin))
	if e := a.event("shared", 2); e["resumed"] != true {
		t.Fatalf("%v", e)
	}
	hs := env.relay.Headers()
	if got := hs[len(hs)-1].Get(protocol.KeepHeader); got != "172800" {
		t.Fatalf("resume sent %s = %q", protocol.KeepHeader, got)
	}
	eventually(t, "the record holds the new keep", func() bool { return keptRecord(t, room)["Keep"] != float64(3600) })

	// With no keep named, the room's own stays.
	a.command(`{"cmd":"unshare"}`)
	waitLeft(t, room)
	a.command(fmt.Sprintf(`{"cmd":"share","relay":%q,"origins":[%q]}`, env.server.URL, cmsOrigin))
	a.event("shared", 3)
	hs = env.relay.Headers()
	if got := hs[len(hs)-1].Get(protocol.KeepHeader); got != "172800" {
		t.Fatalf("resume without a keep sent %s = %q", protocol.KeepHeader, got)
	}
}

func TestServeKeepErrors(t *testing.T) {
	env := keptEnv(t)
	a := startApp(t, writeFile(t, "hello\n"))

	// Not shared.
	a.command(`{"cmd":"keep","keep":"1d"}`)
	a.errorOf(1, "keep", "not shared")
	a.command(`{"cmd":"keep","keep":"0"}`)
	a.errorOf(2, "keep", "0 is not allowed")

	// A live room cannot become kept, and the relay is not asked.
	a.share(fmt.Sprintf(`,"relay":%q`, env.server.URL))
	a.command(`{"cmd":"keep","keep":"1d"}`)
	a.errorOf(3, "keep", "live")
	if got := env.keep.requests(); len(got) != 0 {
		t.Fatalf("asked the relay: %v", got)
	}
	a.command(`{"cmd":"unshare"}`)
	a.event("unshared", 1)

	// The relay refuses.
	room := a.shareKeptAt(env, cmsOrigin)["room"].(string)
	env.keep.force(http.StatusConflict)
	a.command(`{"cmd":"keep","keep":"1d"}`)
	a.errorOf(4, "keep", "refused")
	env.keep.force(http.StatusNotFound)
	a.command(`{"cmd":"keep","keep":"1d"}`)
	a.errorOf(5, "keep", "too old")
	if rec := keptRecord(t, room); rec["Keep"] != float64(3600) {
		t.Fatalf("the record changed: %v", rec["Keep"])
	}
}
