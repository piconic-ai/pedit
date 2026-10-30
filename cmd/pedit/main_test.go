package main

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/piconic-ai/pedit/internal/access"
	"github.com/piconic-ai/pedit/internal/protocol"
	"github.com/piconic-ai/pedit/internal/session"
)

func TestRunArgs(t *testing.T) {
	t.Chdir(t.TempDir())
	tests := []struct {
		args   []string
		code   int
		stdout string
		stderr string
	}{
		{args: []string{"--help"}, code: 0, stdout: "Usage: pedit [file ...]"},
		{args: []string{"-h"}, code: 0, stdout: ".pedit/config.yaml"},
		{args: []string{"--version"}, code: 0, stdout: "dev"},
		{args: []string{"a.md", "b.md"}, code: 1, stderr: "a.md does not exist."},
		{args: []string{"a.md", "--", ""}, code: 2, stderr: "Usage: pedit [file ...]"},
		{args: []string{""}, code: 2, stderr: "Usage: pedit [file ...]"},
		{args: []string{"does-not-exist.md"}, code: 1, stderr: "does-not-exist.md does not exist."},
		{args: []string{"."}, code: 1, stderr: ". is a directory."},
		{args: []string{"https://edit.piconic.ai/r/ROOM#key", "-t", "minutes.md"}, code: 2, stderr: "a share link cannot be combined with a template"},
		{args: []string{"https://edit.piconic.ai/ROOM#key"}, code: 1, stderr: "https://edit.piconic.ai/ROOM#… is not a share link"},
		{args: []string{"https://edit.piconic.ai/r/ROOM"}, code: 1, stderr: "has no key after #"},
	}
	for _, tt := range tests {
		var stdout, stderr strings.Builder
		code := run(tt.args, &stdout, &stderr)
		if code != tt.code || !strings.Contains(stdout.String(), tt.stdout) || !strings.Contains(stderr.String(), tt.stderr) {
			t.Errorf("run(%q) = %d\nstdout: %s\nstderr: %s", tt.args, code, stdout.String(), stderr.String())
		}
	}
}

func TestCreateScratch(t *testing.T) {
	now := func() string { return "2026-09-26-143012" }

	t.Run("new", func(t *testing.T) {
		dir := t.TempDir()
		name, err := createScratch(dir, now)
		if err != nil || name != "pedit-2026-09-26-143012.md" {
			t.Fatalf("= %q, %v", name, err)
		}
		if b, err := os.ReadFile(filepath.Join(dir, name)); err != nil || len(b) != 0 {
			t.Fatalf("file = %q, %v", b, err)
		}
	})
	t.Run("collision", func(t *testing.T) {
		dir := t.TempDir()
		for _, name := range []string{"pedit-2026-09-26-143012.md", "pedit-2026-09-26-143012-2.md"} {
			if err := os.WriteFile(filepath.Join(dir, name), []byte("keep"), 0o644); err != nil {
				t.Fatal(err)
			}
		}
		name, err := createScratch(dir, now)
		if err != nil || name != "pedit-2026-09-26-143012-3.md" {
			t.Fatalf("= %q, %v", name, err)
		}
		if b, _ := os.ReadFile(filepath.Join(dir, "pedit-2026-09-26-143012.md")); string(b) != "keep" {
			t.Fatalf("existing file changed: %q", b)
		}
	})
	t.Run("read-only", func(t *testing.T) {
		dir := readOnlyDir(t)
		if _, err := createScratch(dir, now); err == nil {
			t.Fatal("created a file in a read-only directory")
		}
	})
}

func TestRunWithoutFileInReadOnlyDir(t *testing.T) {
	dir := readOnlyDir(t)
	t.Chdir(dir)
	var stdout, stderr strings.Builder
	code := run(nil, &stdout, &stderr)
	if code != 1 || !strings.Contains(stderr.String(), "could not create a scratch file in") || !strings.Contains(stderr.String(), "Run pedit <file>") {
		t.Fatalf("run() = %d\nstdout: %s\nstderr: %s", code, stdout.String(), stderr.String())
	}
	if entries, _ := os.ReadDir(dir); len(entries) != 0 {
		t.Fatalf("left files behind: %v", entries)
	}
}

func TestFinish(t *testing.T) {
	tests := []struct {
		name    string
		scratch bool
		stopErr error
		code    int
		stdout  []string
		not     []string
	}{
		{name: "file", code: 0, stdout: []string{"✓ Saved notes.md"}, not: []string{"Resume with"}},
		{name: "scratch", scratch: true, code: 0, stdout: []string{"✓ Saved notes.md", "Saved to notes.md", "Resume with: pedit notes.md"}},
		{name: "scratch not saved", scratch: true, stopErr: errors.New("disk full"), code: 1, not: []string{"Saved", "Resume with"}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			var stdout, stderr strings.Builder
			code := finish(newUI(&stdout, false, false), &stderr, "notes.md", tt.scratch, func() error { return tt.stopErr }, nil)
			if code != tt.code {
				t.Errorf("code = %d", code)
			}
			for _, want := range tt.stdout {
				if !strings.Contains(stdout.String(), want) {
					t.Errorf("missing %q in %q", want, stdout.String())
				}
			}
			for _, unwanted := range tt.not {
				if strings.Contains(stdout.String(), unwanted) {
					t.Errorf("unexpected %q in %q", unwanted, stdout.String())
				}
			}
			if tt.stopErr != nil && !strings.Contains(stderr.String(), "could not save notes.md: disk full") {
				t.Errorf("stderr = %q", stderr.String())
			}
		})
	}
}

func TestReadLines(t *testing.T) {
	resumed := 0
	var added []string
	in := "\n  \nnotes.md\n 'a b.md' \n\"c d.md\"\ne\\ f.md\nnot a full line"
	readLines(strings.NewReader(in), func() { resumed++ }, func(path string) { added = append(added, path) })
	if resumed != 2 {
		t.Fatalf("resumed %d times, want once per empty line", resumed)
	}
	if want := []string{"notes.md", "a b.md", "c d.md", "e f.md"}; !slices.Equal(added, want) {
		t.Fatalf("added %q, want %q", added, want)
	}
}

func TestFinishJoin(t *testing.T) {
	tests := []struct {
		name      string
		temporary bool
		ended     protocol.Status
		stopErr   error
		code      int
		kept      bool
		stdout    []string
		not       []string
		stderr    string
	}{
		{name: "left", code: 0, stdout: []string{"✓ Saved notes.md. It no longer syncs"}, not: []string{"host closed"}},
		{name: "host left", ended: protocol.StatusClosed, code: 0, stdout: []string{"The host closed the room.", "✓ Saved notes.md"}},
		{name: "not saved", stopErr: errors.New("disk full"), code: 1, not: []string{"Saved"}, stderr: "could not save notes.md: disk full"},
		{name: "temporary", temporary: true, code: 0, stdout: []string{"✓ Left the room. The temporary copies were removed."}, not: []string{"Saving", "Saved"}},
		{name: "temporary, host left", temporary: true, ended: protocol.StatusClosed, code: 0, stdout: []string{"The host closed the room.", "The temporary copies were removed."}},
		{name: "pedit outdated", ended: protocol.StatusClientOutdated, code: 1, stdout: []string{"✓ Saved notes.md", "This pedit is too old for the server", "To upgrade, run: brew upgrade piconic-ai/tap/pedit"}, not: []string{"host closed"}},
		{name: "temporary, pedit outdated", temporary: true, ended: protocol.StatusClientOutdated, code: 1, stdout: []string{"The temporary copies were removed.", "This pedit is too old"}},
		{name: "server outdated", ended: protocol.StatusServerOutdated, code: 1, stdout: []string{"✓ Saved notes.md", "The server is older than this pedit", "Ask whoever runs the server"}, not: []string{"To upgrade"}},
		{name: "maintenance", ended: protocol.StatusMaintenance, code: 1, stdout: []string{"✓ Saved notes.md", "The relay was closed for maintenance. Run pedit again once it is back."}, not: []string{"host closed", "To upgrade"}},
		{name: "too large", ended: protocol.StatusTooLarge, code: 1, stdout: []string{"✓ Saved notes.md", "pedit left the room: the shared file grew too large to share. pedit shares files up to about 1 MiB for now.", "Your latest changes may not have reached the others."}, not: []string{"host closed"}},
		{name: "temporary, too large", temporary: true, ended: protocol.StatusTooLarge, code: 1, kept: true, stdout: []string{"✓ Saved notes.md", "pedit left the room: the shared file grew too large to share.", "Your latest changes may not have reached the others."}, not: []string{"removed"}},
		{name: "expired", ended: protocol.StatusExpired, code: 0, stdout: []string{"✓ Saved notes.md", "The room reached its 24-hour limit on the relay and was closed.", "Ask the host to run pedit again for a new link."}, not: []string{"host closed"}},
		{name: "temporary, expired", temporary: true, ended: protocol.StatusExpired, code: 0, stdout: []string{"The temporary copies were removed.", "The room reached its 24-hour limit on the relay and was closed."}, not: []string{"host closed"}},
		{name: "temporary not removed", temporary: true, stopErr: errors.New("busy"), code: 1, not: []string{"removed"}, stderr: "could not remove the temporary copy notes.md: busy"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			var stdout, stderr strings.Builder
			var kept bool
			code := finishJoin(newUI(&stdout, false, false), &stderr, "notes.md", tt.temporary, tt.ended, 24*time.Hour, func() error { return tt.stopErr }, func() { kept = true }, func() string { return "brew upgrade piconic-ai/tap/pedit" })
			if code != tt.code {
				t.Errorf("code = %d", code)
			}
			if kept != tt.kept {
				t.Errorf("kept = %v, want %v", kept, tt.kept)
			}
			for _, want := range tt.stdout {
				if !strings.Contains(stdout.String(), want) {
					t.Errorf("missing %q in %q", want, stdout.String())
				}
			}
			for _, unwanted := range tt.not {
				if strings.Contains(stdout.String(), unwanted) {
					t.Errorf("unexpected %q in %q", unwanted, stdout.String())
				}
			}
			if !strings.Contains(stderr.String(), tt.stderr) {
				t.Errorf("stderr = %q", stderr.String())
			}
		})
	}
}

func TestHostEnded(t *testing.T) {
	tests := []struct {
		name   string
		ended  protocol.Status
		code   int
		stdout []string
		not    []string
		asked  bool
		limit  time.Duration
	}{
		{name: "stopped by the user", code: 0},
		{name: "maintenance", ended: protocol.StatusMaintenance, code: 1, stdout: []string{"The relay was closed for maintenance"}, not: []string{"To upgrade"}},
		{name: "pedit outdated", ended: protocol.StatusClientOutdated, code: 1, stdout: []string{"To upgrade, run: brew upgrade piconic-ai/tap/pedit"}, asked: true},
		{name: "server outdated", ended: protocol.StatusServerOutdated, code: 1, stdout: []string{"The server is older than this pedit"}, not: []string{"To upgrade"}, asked: true},
		{name: "expired", ended: protocol.StatusExpired, limit: 24 * time.Hour, code: 1, stdout: []string{"The room reached its 24-hour limit on the relay and was closed.", "Run pedit again to start a new room."}},
		{name: "expired, limit unknown", ended: protocol.StatusExpired, code: 1, stdout: []string{"The room reached its time limit on the relay and was closed."}},
		{name: "too large", ended: protocol.StatusTooLarge, code: 1, stdout: []string{"The room was closed: notes.md and its edits grew past what pedit can share", "Run pedit again to start a new room."}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			var stdout strings.Builder
			var asked bool
			code := hostEnded(newUI(&stdout, false, false), "notes.md", tt.ended, tt.limit, func() string {
				asked = true
				return "brew upgrade piconic-ai/tap/pedit"
			})
			if code != tt.code {
				t.Errorf("code = %d, want %d", code, tt.code)
			}
			if tt.stdout == nil && stdout.Len() != 0 {
				t.Errorf("stdout = %q, want none", stdout.String())
			}
			for _, want := range tt.stdout {
				if !strings.Contains(stdout.String(), want) {
					t.Errorf("missing %q in %q", want, stdout.String())
				}
			}
			for _, unwanted := range tt.not {
				if strings.Contains(stdout.String(), unwanted) {
					t.Errorf("unexpected %q in %q", unwanted, stdout.String())
				}
			}
			if asked != tt.asked {
				t.Errorf("asked how to upgrade = %v, want %v", asked, tt.asked)
			}
		})
	}
}

func TestDisplayPath(t *testing.T) {
	dir := t.TempDir()
	t.Chdir(dir)
	cwd, _ := os.Getwd() // resolves symlinks as the OS does
	if got := displayPath(filepath.Join(cwd, "notes.md")); got != "notes.md" {
		t.Errorf("= %q", got)
	}
	if got := displayPath(filepath.Join(cwd, "shared", "notes.md")); got != filepath.Join("shared", "notes.md") {
		t.Errorf("= %q", got)
	}
	outside := filepath.Join(filepath.Dir(cwd), "elsewhere.md")
	if got := displayPath(outside); got != outside {
		t.Errorf("= %q", got)
	}
}

func readOnlyDir(t *testing.T) string {
	t.Helper()
	if os.Geteuid() == 0 {
		t.Skip("root can write to read-only directories")
	}
	dir := t.TempDir()
	if err := os.Chmod(dir, 0o555); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.Chmod(dir, 0o755) })
	return dir
}

// accessServer stands in for a pedit server behind Cloudflare Access: without
// a valid token, Access sends requests to its login page.
func accessServer(t *testing.T, valid string) *httptest.Server {
	t.Helper()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case strings.HasPrefix(r.URL.Path, "/cdn-cgi/access/"):
			_, _ = w.Write([]byte("<html>Sign in</html>"))
		case r.Header.Get("Cf-Access-Token") != valid:
			http.Redirect(w, r, "/cdn-cgi/access/login/pedit", http.StatusFound)
		default:
			w.WriteHeader(http.StatusCreated)
			_, _ = w.Write([]byte(`{"id":"AAAAAAAAAAAAAAAAAAAAAA","hostToken":"host-token"}`))
		}
	}))
	t.Cleanup(server.Close)
	return server
}

func tempFile(t *testing.T) string {
	t.Helper()
	file := filepath.Join(t.TempDir(), "notes.md")
	if err := os.WriteFile(file, []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	return file
}

// A JWT whose payload is {"email":"k@example.com"}.
const userToken = "h.eyJlbWFpbCI6ImtAZXhhbXBsZS5jb20ifQ.s"

func TestStartSignsInToAccess(t *testing.T) {
	server := accessServer(t, userToken)
	var signedIn string
	signIn := func(_ context.Context, app string) (string, error) {
		signedIn = app
		return userToken, nil
	}
	s, err := start(context.Background(), signIn, session.Options{File: tempFile(t), Server: server.URL})
	if err != nil {
		t.Fatal(err)
	}
	defer s.Stop()
	if signedIn != server.URL {
		t.Fatalf("signed in to %q", signedIn)
	}
}

func TestStartDoesNotSignInWithoutAccess(t *testing.T) {
	server := accessServer(t, "")
	signIn := func(context.Context, string) (string, error) {
		t.Fatal("signed in without Access")
		return "", nil
	}
	s, err := start(context.Background(), signIn, session.Options{File: tempFile(t), Server: server.URL})
	if err != nil {
		t.Fatal(err)
	}
	defer s.Stop()
}

func TestStartExplainsRejectedSignIn(t *testing.T) {
	server := accessServer(t, "a token Access still accepts")
	signIn := func(context.Context, string) (string, error) { return userToken, nil }
	_, err := start(context.Background(), signIn, session.Options{File: tempFile(t), Server: server.URL})
	if err == nil || !strings.Contains(err.Error(), "did not accept your sign-in") || !strings.Contains(err.Error(), "rm ~/.cloudflared/*-token") {
		t.Fatalf("err = %v", err)
	}
}

func TestStartExplainsMissingCloudflared(t *testing.T) {
	server := accessServer(t, userToken)
	signIn := func(context.Context, string) (string, error) { return "", access.ErrNoCloudflared }
	_, err := start(context.Background(), signIn, session.Options{File: tempFile(t), Server: server.URL})
	if err == nil || !strings.Contains(err.Error(), "Install cloudflared") {
		t.Fatalf("err = %v", err)
	}
}

func TestGravatarURL(t *testing.T) {
	// Same hash as the web editor's test: sha256("test@example.com").
	want := "https://gravatar.com/avatar/973dfe463ec85785f5f95af5ba3906eedb2d931c24e69824a89ea65dba4e813b?s=64&d=404"
	if got := gravatarURL(" Test@Example.com "); got != want {
		t.Fatalf("gravatarURL = %q", got)
	}
}

func TestWithSignInLimit(t *testing.T) {
	// Waits like cloudflared does for someone who clicked Deny.
	waitForever := func(ctx context.Context, _ string) (string, error) {
		<-ctx.Done()
		return "", ctx.Err()
	}

	t.Run("signed in", func(t *testing.T) {
		got, err := withSignInLimit(context.Background(), time.Minute, "https://pedit.example.com", func(context.Context, string) (string, error) { return userToken, nil })
		if err != nil || got != userToken {
			t.Fatalf("= %q, %v", got, err)
		}
	})
	t.Run("cancelled with Ctrl+C", func(t *testing.T) {
		ctx, cancel := context.WithCancel(context.Background())
		time.AfterFunc(10*time.Millisecond, cancel)
		if _, err := withSignInLimit(ctx, time.Minute, "https://pedit.example.com", waitForever); !errors.Is(err, errSignInCancelled) {
			t.Fatalf("err = %v", err)
		}
	})
	t.Run("out of time", func(t *testing.T) {
		if _, err := withSignInLimit(context.Background(), 10*time.Millisecond, "https://pedit.example.com", waitForever); !errors.Is(err, errSignInTimedOut) {
			t.Fatalf("err = %v", err)
		}
	})
	t.Run("failed", func(t *testing.T) {
		failed := errors.New("could not sign in")
		fail := func(context.Context, string) (string, error) { return "", failed }
		if _, err := withSignInLimit(context.Background(), time.Minute, "https://pedit.example.com", fail); !errors.Is(err, failed) {
			t.Fatalf("err = %v", err)
		}
	})
}

func TestDebugLog(t *testing.T) {
	var out strings.Builder
	debugLog(&out, true)(errors.New("connection reset"))
	debugLog(&out, true)(nil)
	if want := "\npedit: connection reset\n"; out.String() != want {
		t.Fatalf("got %q, want %q", out.String(), want)
	}

	out.Reset()
	debugLog(&out, false)(errors.New("connection reset"))
	if out.Len() != 0 {
		t.Fatalf("printed without PEDIT_DEBUG: %q", out.String())
	}
}

func TestShownPath(t *testing.T) {
	cwd := filepath.Join(t.TempDir(), "project")
	file := filepath.Join(cwd, "notes.md")
	for _, tt := range []struct{ path, want string }{
		{file, "./notes.md"},
		{filepath.Join(cwd, "docs", "a.md"), filepath.Join("docs", "a.md")},
		{filepath.Join(filepath.Dir(cwd), "other.md"), filepath.Join(filepath.Dir(cwd), "other.md")},
	} {
		if got := shownPath(tt.path, file, "./notes.md", cwd); got != tt.want {
			t.Errorf("shownPath(%q) = %q, want %q", tt.path, got, tt.want)
		}
	}
}

func TestCheckFilesNamesTheFirstProblem(t *testing.T) {
	dir := t.TempDir()
	ok := filepath.Join(dir, "ok.md")
	if err := os.WriteFile(ok, []byte("# ok\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if msg := checkFiles([]string{ok, ok}); msg != "" {
		t.Fatalf("checkFiles on readable files = %q", msg)
	}
	gone := filepath.Join(dir, "gone", "a.md")
	if msg := checkFiles([]string{ok, gone, dir}); msg != checkFile(gone) || msg == "" {
		t.Fatalf("checkFiles = %q, want the message for %s", msg, gone)
	}
}
