package sessiondir

import (
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"testing"
	"time"
)

func base(t *testing.T) string {
	return filepath.Join(t.TempDir(), "pedit", "sessions")
}

func TestARequestIsAnsweredByTheSession(t *testing.T) {
	b := base(t)
	d, err := Register(b, Info{PID: os.Getpid(), Room: "ROOM", Access: "edit", Name: "tate-pm", Files: []string{"notes.md"}})
	if err != nil {
		t.Fatal(err)
	}
	defer d.Close()
	if runtime.GOOS != "windows" {
		for _, p := range []string{b, filepath.Join(b, d.ID)} {
			if info, err := os.Stat(p); err != nil || info.Mode().Perm() != 0o700 {
				t.Fatalf("%s: %v %v", p, info.Mode(), err)
			}
		}
	}
	if err := d.Serve(func(r Request) Answer {
		return Answer{OK: true, Message: r.Op + " " + r.Thread + " " + r.Body}
	}); err != nil {
		t.Fatal(err)
	}
	live, err := List(b)
	if err != nil || len(live) != 1 || live[0].ID != d.ID || live[0].Info.Room != "ROOM" || live[0].Info.Name != "tate-pm" {
		t.Fatalf("%+v %v", live, err)
	}
	a, err := live[0].Call(Request{Op: OpReply, Thread: "t1", Message: "m1", Body: "hi"}, 5*time.Second)
	if err != nil || !a.OK || a.Message != "reply t1 hi" {
		t.Fatalf("%+v %v", a, err)
	}
	for _, sub := range []string{reqDir, workDir, resDir} {
		if entries, _ := os.ReadDir(filepath.Join(b, d.ID, sub)); len(entries) != 0 {
			t.Fatalf("%s left %v", sub, entries)
		}
	}
	d.Close()
	if _, err := os.Stat(filepath.Join(b, d.ID)); !os.IsNotExist(err) {
		t.Fatalf("the directory stays: %v", err)
	}
	if live, _ := List(b); len(live) != 0 {
		t.Fatalf("%+v", live)
	}
}

func TestADirectoryLeftBehindIsRemoved(t *testing.T) {
	b := base(t)
	d, err := Register(b, Info{Room: "ROOM"})
	if err != nil {
		t.Fatal(err)
	}
	// As a crash leaves it: the lock released, the directory there.
	_ = d.lock.Close()
	if live, err := List(b); err != nil || len(live) != 0 {
		t.Fatalf("%+v %v", live, err)
	}
	if _, err := os.Stat(filepath.Join(b, d.ID)); !os.IsNotExist(err) {
		t.Fatalf("not removed: %v", err)
	}
}

func TestARequestNobodyTakesIsWithdrawn(t *testing.T) {
	b := base(t)
	d, err := Register(b, Info{Room: "ROOM"})
	if err != nil {
		t.Fatal(err)
	}
	defer d.Close()
	live, _ := List(b)
	if _, err := live[0].Call(Request{Op: OpList}, 200*time.Millisecond); !errors.Is(err, ErrWithdrawn) {
		t.Fatal(err)
	}
	if entries, _ := os.ReadDir(filepath.Join(b, d.ID, reqDir)); len(entries) != 0 {
		t.Fatalf("left %v", entries)
	}
}

func TestARequestTakenButNotAnsweredIsUnknown(t *testing.T) {
	b := base(t)
	d, err := Register(b, Info{Room: "ROOM"})
	if err != nil {
		t.Fatal(err)
	}
	release := make(chan struct{})
	if err := d.Serve(func(Request) Answer { <-release; return Answer{OK: true} }); err != nil {
		t.Fatal(err)
	}
	live, _ := List(b)
	if _, err := live[0].Call(Request{Op: OpResolve, Thread: "t1"}, 300*time.Millisecond); !errors.Is(err, ErrUnknown) {
		t.Fatal(err)
	}
	close(release)
	d.Close()
}

func TestOnlyAWellFormedRequestIsTaken(t *testing.T) {
	for _, data := range []string{
		`{"version":1,"op":"reply","file":"","thread":"t","message":"m","body":"x","path":"/etc"}`,
		`{"version":1,"op":"reply","OP":"list","file":"","thread":"t","message":"m","body":"x"}`,
		`{"version":1,"op":"reply","op":"list","file":"","thread":"t","message":"m","body":"x"}`,
		`{"version":2,"op":"reply","file":"","thread":"t","message":"m","body":"x"}`,
		`{"version":1,"op":"delete","file":"","thread":"t","message":"m","body":"x"}`,
		`[]`,
		`{"version":1,"op":"list"} {}`,
	} {
		if r, err := parseRequest([]byte(data)); err == nil {
			t.Fatalf("%s was taken: %+v", data, r)
		}
	}
	if _, err := parseRequest([]byte(`{"version":1,"op":"list"}`)); err != nil {
		t.Fatal(err)
	}
	dir := t.TempDir()
	target := filepath.Join(dir, "target")
	if err := os.WriteFile(target, []byte(`{"version":1,"op":"list"}`), 0o600); err != nil {
		t.Fatal(err)
	}
	link := filepath.Join(dir, "link")
	if err := os.Symlink(target, link); err == nil {
		if _, err := readRequest(link); err == nil {
			t.Fatal("a request through a link was taken")
		}
	}
}

func TestABaseOthersCanReachIsRefused(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("modes are Unix")
	}
	b := base(t)
	if err := os.MkdirAll(b, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(b, 0o755); err != nil {
		t.Fatal(err)
	}
	if _, err := Register(b, Info{}); err == nil {
		t.Fatal("registered under a directory others can reach")
	}
	if _, err := List(b); err == nil {
		t.Fatal("listed a directory others can reach")
	}
}

func TestAnAnswerLostWithItsSessionIsUnknown(t *testing.T) {
	b := base(t)
	d, err := Register(b, Info{Room: "ROOM"})
	if err != nil {
		t.Fatal(err)
	}
	var acted bool
	// The session acts on the request, then its directory goes before it
	// answers, as when it dies and the next command cleans up after it.
	if err := d.Serve(func(Request) Answer {
		acted = true
		_ = os.RemoveAll(filepath.Join(b, d.ID))
		return Answer{OK: true}
	}); err != nil {
		t.Fatal(err)
	}
	live, _ := List(b)
	if _, err := live[0].Call(Request{Op: OpReply, Thread: "t1", Message: "m1", Body: "x"}, time.Second); !errors.Is(err, ErrUnknown) || !acted {
		t.Fatalf("%v (acted %v)", err, acted)
	}
	d.Close()
}
