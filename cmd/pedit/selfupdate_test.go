package main

import (
	"archive/tar"
	"archive/zip"
	"bytes"
	"compress/gzip"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

const (
	testSHA  = "0123456789abcdef0123456789abcdef01234567"
	oldBytes = "old pedit"
	newBytes = "new pedit"
)

// tarGz builds a release archive from name → content pairs, in order.
func tarGz(t *testing.T, files ...string) []byte {
	t.Helper()
	var buf bytes.Buffer
	gz := gzip.NewWriter(&buf)
	tw := tar.NewWriter(gz)
	for i := 0; i+1 < len(files); i += 2 {
		tw.WriteHeader(&tar.Header{Name: files[i], Mode: 0o755, Size: int64(len(files[i+1])), Typeflag: tar.TypeReg})
		tw.Write([]byte(files[i+1]))
	}
	tw.Close()
	gz.Close()
	return buf.Bytes()
}

func zipOf(t *testing.T, files ...string) []byte {
	t.Helper()
	var buf bytes.Buffer
	zw := zip.NewWriter(&buf)
	for i := 0; i+1 < len(files); i += 2 {
		w, _ := zw.Create(files[i])
		w.Write([]byte(files[i+1]))
	}
	zw.Close()
	return buf.Bytes()
}

// fakeGitHub serves v0.9.0 of pedit for linux (or windows with a .zip).
type fakeGitHub struct {
	archive    []byte
	sumOf      []byte // what checksums.txt is computed from; archive when nil
	commit     string // body of the commit lookup; status 404 when empty
	latestTag  string
	requests   []string
	archiveExt string
}

func newFakeGitHub(t *testing.T) (*fakeGitHub, *httptest.Server) {
	f := &fakeGitHub{archive: tarGz(t, "pedit", newBytes, "README.md", "docs"), commit: testSHA, latestTag: "v0.9.0", archiveExt: ".tar.gz"}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		f.requests = append(f.requests, r.URL.Path+" "+r.Header.Get("Accept"))
		name := r.URL.Path[strings.LastIndex(r.URL.Path, "/")+1:]
		switch {
		case r.URL.Path == "/latest":
			fmt.Fprintf(w, `{"tag_name": %q}`, f.latestTag)
		case strings.HasPrefix(r.URL.Path, "/api/repos/piconic-ai/pedit/commits/"):
			if f.commit == "" {
				http.NotFound(w, r)
				return
			}
			fmt.Fprint(w, f.commit)
		case name == "checksums.txt":
			sum := f.sumOf
			if sum == nil {
				sum = f.archive
			}
			h := sha256.Sum256(sum)
			goos := "linux"
			if f.archiveExt == ".zip" {
				goos = "windows"
			}
			fmt.Fprintf(w, "%s  pedit_v0.9.0_%s_%s%s\n", hex.EncodeToString(h[:]), goos, runtime.GOARCH, f.archiveExt)
		case strings.HasSuffix(name, f.archiveExt):
			w.Write(f.archive)
		case strings.HasSuffix(name, ".sigstore.json"):
			fmt.Fprint(w, `{"bundle":true}`)
		default:
			http.NotFound(w, r)
		}
	}))
	t.Cleanup(srv.Close)
	return f, srv
}

type ghCall struct {
	calls [][]string
	err   error
	has   bool
}

func testUpdater(t *testing.T, srv *httptest.Server, gh *ghCall) (updater, string) {
	t.Helper()
	dir := t.TempDir()
	exe := filepath.Join(dir, "pedit")
	if err := os.WriteFile(exe, []byte(oldBytes), 0o750); err != nil {
		t.Fatal(err)
	}
	return updater{
		// The platform is the fixture's (linux, a tar.gz), not the host's, so
		// these tests run the same on Windows; the Windows tests set goos.
		exe: exe, goos: "linux", goarch: runtime.GOARCH, home: dir, current: "v0.5.1",
		releasesAPI: srv.URL + "/latest", downloadURL: srv.URL + "/dl", apiURL: srv.URL + "/api",
		client: srv.Client(),
		hasGh:  func() bool { return gh.has },
		gh: func(args []string) (string, error) {
			gh.calls = append(gh.calls, args)
			if gh.err != nil {
				return "gh: no matching attestation", gh.err
			}
			return "", nil
		},
	}, exe
}

func read(t *testing.T, path string) string {
	t.Helper()
	b, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}

func TestSelfUpdateSuccess(t *testing.T) {
	_, srv := newFakeGitHub(t)
	gh := &ghCall{has: true}
	u, exe := testUpdater(t, srv, gh)
	var out, errb bytes.Buffer
	if code := u.run(nil, &out, &errb); code != 0 {
		t.Fatalf("code %d: %s %s", code, out.String(), errb.String())
	}
	if got := read(t, exe); got != newBytes {
		t.Errorf("binary = %q", got)
	}
	if runtime.GOOS != "windows" {
		if fi, _ := os.Stat(exe); fi.Mode().Perm() != 0o750 {
			t.Errorf("mode = %v, want the old 0750", fi.Mode().Perm())
		}
	}
	if !strings.Contains(out.String(), "Updated pedit v0.5.1 → v0.9.0") || !strings.Contains(out.String(), "pedit serve") {
		t.Errorf("output: %s", out.String())
	}
	if len(gh.calls) != 1 {
		t.Fatalf("gh calls: %v", gh.calls)
	}
	args := gh.calls[0]
	tail := strings.Join(args[3:], " ")
	want := "--bundle " + args[4] + " --repo piconic-ai/pedit --signer-workflow piconic-ai/pedit/.github/workflows/release-build.yml --deny-self-hosted-runners --source-digest " + testSHA + " --signer-digest " + testSHA
	if args[0] != "attestation" || args[1] != "verify" || !strings.Contains(args[2], "pedit_v0.9.0_") || tail != want {
		t.Errorf("gh args: %v", args)
	}
	entries, _ := os.ReadDir(filepath.Dir(exe))
	if len(entries) != 1 {
		t.Errorf("stray files beside the binary: %v", entries)
	}
}

func TestSelfUpdateRefusals(t *testing.T) {
	_, srv := newFakeGitHub(t)
	tests := []struct {
		name    string
		mutate  func(u *updater)
		args    []string
		code    int
		message string
	}{
		{"brew", func(u *updater) { u.exe = "/opt/homebrew/Cellar/pedit/0.5.1/bin/pedit" }, nil, 2, "brew upgrade"},
		{"mise", func(u *updater) { u.exe = "/x/mise/installs/github-piconic-ai-pedit/0.5.1/pedit" }, nil, 2, "mise upgrade"},
		{"go install", func(u *updater) { u.goInstalled = true }, nil, 2, "go install github.com/piconic-ai/pedit/cmd/pedit@latest"},
		{"dev", func(u *updater) { u.current = "dev" }, nil, 2, "development build"},
		{"downgrade", nil, []string{"--version", "v0.4.0"}, 2, "does not downgrade"},
		{"no bundle", func(u *updater) { u.current = "v0.1.0" }, []string{"--version", "v0.1.5"}, 2, "v0.1.6 or later"},
		{"bad version", nil, []string{"--version", "latest"}, 2, "--version must look like"},
		{"stray argument", nil, []string{"now"}, 2, "unexpected argument"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			u, exe := testUpdater(t, srv, &ghCall{})
			if tt.mutate != nil {
				tt.mutate(&u)
			}
			if tt.name == "brew" || tt.name == "mise" {
				u.goos = "linux"
			}
			var out, errb bytes.Buffer
			if code := u.run(tt.args, &out, &errb); code != tt.code {
				t.Fatalf("code %d, want %d: %s", code, tt.code, errb.String())
			}
			if !strings.Contains(errb.String(), tt.message) {
				t.Errorf("stderr %q lacks %q", errb.String(), tt.message)
			}
			if got := read(t, filepath.Join(filepath.Dir(exe), "pedit")); got != oldBytes {
				t.Errorf("binary changed: %q", got)
			}
		})
	}
}

func TestSelfUpdateNotNewer(t *testing.T) {
	f, srv := newFakeGitHub(t)
	for _, tag := range []string{"v0.5.1", "v0.4.0"} {
		f.latestTag = tag
		u, exe := testUpdater(t, srv, &ghCall{})
		var out bytes.Buffer
		if code := u.run(nil, &out, &out); code != 0 || !strings.Contains(out.String(), "up to date") {
			t.Errorf("%s: code %d: %s", tag, code, out.String())
		}
		if read(t, exe) != oldBytes {
			t.Error("binary changed")
		}
	}
	u, _ := testUpdater(t, srv, &ghCall{})
	var out bytes.Buffer
	if code := u.run([]string{"--version", "v0.5.1"}, &out, &out); code != 0 || !strings.Contains(out.String(), "up to date") {
		t.Errorf("same version: code %d: %s", code, out.String())
	}
}

func TestSelfUpdateCheck(t *testing.T) {
	f, srv := newFakeGitHub(t)
	u, exe := testUpdater(t, srv, &ghCall{has: true})
	var out bytes.Buffer
	if code := u.run([]string{"--check"}, &out, &out); code != 0 || !strings.Contains(out.String(), "from v0.5.1 to v0.9.0") {
		t.Errorf("code %d: %s", code, out.String())
	}
	if read(t, exe) != oldBytes {
		t.Error("binary changed")
	}
	for _, r := range f.requests {
		if !strings.HasPrefix(r, "/latest") {
			t.Errorf("--check downloaded: %s", r)
		}
	}
}

func TestSelfUpdateFailuresReplaceNothing(t *testing.T) {
	tests := []struct {
		name   string
		setup  func(f *fakeGitHub, gh *ghCall)
		expect string
	}{
		{"checksum mismatch", func(f *fakeGitHub, _ *ghCall) { f.sumOf = []byte("other") }, "checksum mismatch"},
		{"gh fails", func(_ *fakeGitHub, gh *ghCall) { gh.err = errors.New("exit status 1") }, "no matching attestation"},
		{"no root pedit", func(f *fakeGitHub, _ *ghCall) { f.archive = tarGz(t, "../pedit", "evil", "dir/pedit", "evil") }, "no pedit at its root"},
		{"oversize", func(f *fakeGitHub, _ *ghCall) {
			f.archive = bytes.Repeat([]byte{1}, maxArchiveSize+1)
		}, "is larger than"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			f, srv := newFakeGitHub(t)
			gh := &ghCall{has: true}
			tt.setup(f, gh)
			u, exe := testUpdater(t, srv, gh)
			var out, errb bytes.Buffer
			if code := u.run(nil, &out, &errb); code != 1 {
				t.Fatalf("code %d: %s", code, errb.String())
			}
			if !strings.Contains(errb.String(), tt.expect) || !strings.Contains(errb.String(), "Nothing was replaced") {
				t.Errorf("stderr: %s", errb.String())
			}
			if read(t, exe) != oldBytes {
				t.Error("binary changed")
			}
			if entries, _ := os.ReadDir(filepath.Dir(exe)); len(entries) != 1 {
				t.Errorf("stray files: %v", entries)
			}
		})
	}
}

func TestSelfUpdateWithoutGh(t *testing.T) {
	_, srv := newFakeGitHub(t)
	gh := &ghCall{}
	u, exe := testUpdater(t, srv, gh)
	var out bytes.Buffer
	if code := u.run(nil, &out, &out); code != 0 {
		t.Fatalf("code %d: %s", code, out.String())
	}
	if !strings.Contains(out.String(), "Only the checksum was checked") || len(gh.calls) != 0 {
		t.Errorf("output %q, gh calls %v", out.String(), gh.calls)
	}
	if read(t, exe) != newBytes {
		t.Error("not replaced")
	}
}

func TestSelfUpdateCommitLookup(t *testing.T) {
	for name, commit := range map[string]string{
		"fails":   "",
		"garbage": "not a commit",
		"upper":   strings.ToUpper(testSHA),
		"short":   testSHA[:39],
		"long":    testSHA + "0",
	} {
		t.Run(name, func(t *testing.T) {
			f, srv := newFakeGitHub(t)
			f.commit = commit
			gh := &ghCall{has: true}
			u, exe := testUpdater(t, srv, gh)
			var out bytes.Buffer
			if code := u.run(nil, &out, &out); code != 0 {
				t.Fatalf("code %d: %s", code, out.String())
			}
			if !strings.Contains(out.String(), "not pinned") {
				t.Errorf("no note: %s", out.String())
			}
			if joined := strings.Join(gh.calls[0], " "); strings.Contains(joined, "digest") {
				t.Errorf("digest flags passed: %s", joined)
			}
			if read(t, exe) != newBytes {
				t.Error("not replaced")
			}
			sawAccept := false
			for _, r := range f.requests {
				if strings.HasPrefix(r, "/api/repos/piconic-ai/pedit/commits/v0.9.0 application/vnd.github.sha") {
					sawAccept = true
				}
			}
			if !sawAccept {
				t.Errorf("requests: %v", f.requests)
			}
		})
	}
}

func TestSelfUpdateZipOnWindows(t *testing.T) {
	f, srv := newFakeGitHub(t)
	f.archive, f.archiveExt = zipOf(t, "docs/pedit.exe", "evil", "pedit.exe", newBytes), ".zip"
	u, exe := testUpdater(t, srv, &ghCall{})
	u.goos = "windows"
	u.exe = exe + ".exe"
	if err := os.Rename(exe, u.exe); err != nil {
		t.Fatal(err)
	}
	// upgradeCommand on a non-Windows host path: the default dir differs, so
	// the command still names an install script.
	f.archive = zipOf(t, "docs/pedit.exe", "evil", "pedit.exe", newBytes)
	var out, errb bytes.Buffer
	if code := u.run(nil, &out, &errb); code != 0 {
		t.Fatalf("code %d: %s", code, errb.String())
	}
	if read(t, u.exe) != newBytes {
		t.Error("not replaced")
	}
	if _, err := os.Stat(u.exe + ".old"); err == nil {
		t.Error("old copy left behind")
	}
}

func TestReplaceFileWindows(t *testing.T) {
	dir := t.TempDir()
	dest := filepath.Join(dir, "pedit.exe")
	write := func(path, s string) {
		if err := os.WriteFile(path, []byte(s), 0o755); err != nil {
			t.Fatal(err)
		}
	}

	t.Run("moves the old one aside and cleans up", func(t *testing.T) {
		write(dest, "old")
		write(dest+".old", "older")
		write(dest+".old.deadbeef", "oldest")
		write(filepath.Join(dir, "staged"), "new")
		if err := replaceFile(filepath.Join(dir, "staged"), dest, "windows"); err != nil {
			t.Fatal(err)
		}
		if read(t, dest) != "new" {
			t.Error("not replaced")
		}
		if entries, _ := os.ReadDir(dir); len(entries) != 1 {
			t.Errorf("left over: %v", entries)
		}
	})

	t.Run("puts the old one back when the new one cannot move in", func(t *testing.T) {
		write(dest, "old")
		if err := replaceFile(filepath.Join(dir, "missing"), dest, "windows"); err == nil {
			t.Fatal("expected an error")
		}
		if read(t, dest) != "old" {
			t.Error("old copy not restored")
		}
		if entries, _ := os.ReadDir(dir); len(entries) != 1 {
			t.Errorf("left over: %v", entries)
		}
	})

	t.Run("works with nothing installed yet", func(t *testing.T) {
		os.Remove(dest)
		write(filepath.Join(dir, "staged"), "new")
		if err := replaceFile(filepath.Join(dir, "staged"), dest, "windows"); err != nil || read(t, dest) != "new" {
			t.Fatalf("err %v", err)
		}
	})
}

func TestSelfUpgradeCommandSuggestsSelfUpdate(t *testing.T) {
	if viaInstallScript("brew upgrade piconic-ai/tap/pedit") || viaInstallScript("go install github.com/piconic-ai/pedit/cmd/pedit@latest") {
		t.Error("package manager commands are not install scripts")
	}
	for _, goos := range []string{"linux", "windows"} {
		cmd := upgradeCommand(`/home/me/.local/bin/pedit`, goos, "/home/me", false)
		if !viaInstallScript(cmd) {
			t.Errorf("%s: %q should be an install script command", goos, cmd)
		}
	}
}
