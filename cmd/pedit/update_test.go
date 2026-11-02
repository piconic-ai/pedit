package main

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/piconic-ai/pedit/internal/protocol"
)

func TestNewerVersion(t *testing.T) {
	tests := []struct {
		current, latest string
		want            bool
	}{
		{"v0.0.11", "v0.0.12", true},
		{"v0.0.11", "v0.1.0", true},
		{"v0.9.9", "v1.0.0", true},
		{"v0.0.9", "v0.0.10", true},
		{"v0.0.12", "v0.0.12", false},
		{"v0.0.12", "v0.0.11", false},
		{"v1.0.0", "v0.9.9", false},
		{"v1.0.0-rc.1", "v1.0.0", true},
		{"v1.0.0-rc.1", "v1.0.0-rc.2", true},
		{"v1.0.0", "v1.0.0-rc.1", false},
		{"v1.0.0-rc.1", "v1.0.0-rc.1", false},
		{"dev", "v0.0.12", false},
		{"v0.0.11", "", false},
		{"v0.0.11", "0.0.12", false},
		{"v0.0.11", "v0.0", false},
		{"v0.0.11", "v0.0.x", false},
	}
	for _, tt := range tests {
		if got := newerVersion(tt.current, tt.latest); got != tt.want {
			t.Errorf("newerVersion(%q, %q) = %v, want %v", tt.current, tt.latest, got, tt.want)
		}
	}
}

func TestUpgradeCommand(t *testing.T) {
	const home = "/Users/me"
	const install = "curl -fsSL https://edit.piconic.ai/install.sh | "
	tests := []struct {
		exe, goos   string
		goInstalled bool
		want        string
	}{
		{"/opt/homebrew/Cellar/pedit/0.0.11/bin/pedit", "darwin", false, "brew upgrade piconic-ai/tap/pedit"},
		{"/home/linuxbrew/.linuxbrew/Cellar/pedit/0.0.11/bin/pedit", "linux", false, "brew upgrade piconic-ai/tap/pedit"},
		{"/Users/me/.local/share/mise/installs/github-piconic-ai-pedit/0.0.13/pedit", "darwin", false, "mise upgrade --bump github:piconic-ai/pedit"},
		// MISE_DATA_DIR moves the installs elsewhere.
		{"/data/mise/installs/github-piconic-ai-pedit/0.0.13/pedit", "linux", false, "mise upgrade --bump github:piconic-ai/pedit"},
		// Installed before the repository was renamed from piconic-ai/edit.
		{"/Users/me/.local/share/mise/installs/github-piconic-ai-edit/0.0.11/pedit", "darwin", false, "mise upgrade --bump github:piconic-ai/edit"},
		{"/Users/me/go/bin/pedit", "darwin", true, "go install github.com/piconic-ai/pedit/cmd/pedit@latest"},
		{"/Users/me/.local/bin/pedit", "darwin", false, install + "sh"},
		// Installed with PEDIT_INSTALL_DIR, or put there by hand.
		{"/usr/local/bin/pedit", "darwin", false, install + "PEDIT_INSTALL_DIR=/usr/local/bin sh"},
		{"/Users/me/my tools/pedit", "darwin", false, install + "PEDIT_INSTALL_DIR='/Users/me/my tools' sh"},
		{`C:\Users\me\bin\pedit.exe`, "windows", false, `$env:PEDIT_INSTALL_DIR = 'C:\Users\me\bin'; irm https://edit.piconic.ai/install.ps1 | iex`},
		{`D:\pedit.exe`, "windows", false, `$env:PEDIT_INSTALL_DIR = 'D:\'; irm https://edit.piconic.ai/install.ps1 | iex`},
		{`C:\Users\o'brien\bin\pedit.exe`, "windows", false, `$env:PEDIT_INSTALL_DIR = 'C:\Users\o''brien\bin'; irm https://edit.piconic.ai/install.ps1 | iex`},
	}
	for _, tt := range tests {
		if got := upgradeCommand(tt.exe, tt.goos, home, tt.goInstalled); got != tt.want {
			t.Errorf("upgradeCommand(%q, %q, %v) = %q, want %q", tt.exe, tt.goos, tt.goInstalled, got, tt.want)
		}
	}
}

func TestUpgradeCommandWindowsDefaultDirectory(t *testing.T) {
	// install.ps1 without PEDIT_INSTALL_DIR needs no override to upgrade in place.
	exe := `C:\Users\me\AppData\Local\Programs\pedit\pedit.exe`
	want := "irm https://edit.piconic.ai/install.ps1 | iex"
	if got := upgradeCommand(exe, "windows", `C:\Users\me`, false); got != want {
		t.Errorf("upgradeCommand(%q) = %q, want %q", exe, got, want)
	}
}

// releaseServer answers like GitHub with tag and counts the requests.
func releaseServer(t *testing.T, status int, tag string) (*httptest.Server, *int) {
	t.Helper()
	var requests int
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests++
		w.WriteHeader(status)
		_ = json.NewEncoder(w).Encode(release{Version: tag, URL: "https://github.com/piconic-ai/pedit/releases/tag/" + tag})
	}))
	t.Cleanup(srv.Close)
	return srv, &requests
}

func testChecker(t *testing.T, api string, now time.Time) updateChecker {
	t.Helper()
	return updateChecker{
		api:       api,
		statePath: filepath.Join(t.TempDir(), "pedit", "update.json"),
		client:    http.DefaultClient,
		now:       func() time.Time { return now },
	}
}

func TestUpdateCheckFindsNewerRelease(t *testing.T) {
	srv, requests := releaseServer(t, http.StatusOK, "v0.0.12")
	c := testChecker(t, srv.URL, time.Now())
	r, err := c.check(context.Background(), "v0.0.11")
	if err != nil {
		t.Fatal(err)
	}
	if r == nil || r.Version != "v0.0.12" || r.URL != "https://github.com/piconic-ai/pedit/releases/tag/v0.0.12" {
		t.Fatalf("check = %+v", r)
	}
	if *requests != 1 {
		t.Fatalf("requests = %d", *requests)
	}
	if _, err := os.Stat(c.statePath); err != nil {
		t.Fatalf("state not saved: %v", err)
	}
}

func TestUpdateCheckUpToDate(t *testing.T) {
	srv, _ := releaseServer(t, http.StatusOK, "v0.0.12")
	c := testChecker(t, srv.URL, time.Now())
	r, err := c.check(context.Background(), "v0.0.12")
	if err != nil || r != nil {
		t.Fatalf("check = %+v, %v", r, err)
	}
}

func TestUpdateCheckAsksOncePerInterval(t *testing.T) {
	srv, requests := releaseServer(t, http.StatusOK, "v0.0.12")
	now := time.Date(2026, 10, 6, 9, 0, 0, 0, time.UTC)
	c := testChecker(t, srv.URL, now)
	for range 2 {
		if r, err := c.check(context.Background(), "v0.0.11"); err != nil || r == nil {
			t.Fatalf("check = %+v, %v", r, err)
		}
	}
	if *requests != 1 {
		t.Fatalf("requests within the interval = %d, want 1", *requests)
	}

	c.now = func() time.Time { return now.Add(updateInterval) }
	if _, err := c.check(context.Background(), "v0.0.11"); err != nil {
		t.Fatal(err)
	}
	if *requests != 2 {
		t.Fatalf("requests after the interval = %d, want 2", *requests)
	}
}

func TestUpdateCheckFailure(t *testing.T) {
	srv, requests := releaseServer(t, http.StatusForbidden, "")
	c := testChecker(t, srv.URL, time.Now())
	for range 2 {
		if r, err := c.check(context.Background(), "v0.0.11"); err == nil || r != nil {
			t.Fatalf("check = %+v, %v", r, err)
		}
	}
	// A failure is not saved, so the next run asks again.
	if *requests != 2 {
		t.Fatalf("requests = %d, want 2", *requests)
	}
}

func TestStartUpdateCheckSkipped(t *testing.T) {
	t.Setenv("CI", "")
	if r := startUpdateCheck("v0.0.11", false)(); r != nil {
		t.Errorf("not a terminal: got %+v", r)
	}
	if r := startUpdateCheck("dev", true)(); r != nil {
		t.Errorf("dev build: got %+v", r)
	}
	t.Setenv("CI", "true")
	if r := startUpdateCheck("v0.0.11", true)(); r != nil {
		t.Errorf("CI: got %+v", r)
	}
}

func TestUpdateAvailable(t *testing.T) {
	r := release{Version: "v0.0.12", URL: "https://github.com/piconic-ai/pedit/releases/tag/v0.0.12"}
	var out bytes.Buffer
	newUI(&out, false, false).updateAvailable("v0.0.11", r, "brew upgrade piconic-ai/tap/pedit")
	want := `  A new release of pedit is available: v0.0.11 → v0.0.12
  To upgrade, run: brew upgrade piconic-ai/tap/pedit
  https://github.com/piconic-ai/pedit/releases/tag/v0.0.12

`
	if out.String() != want {
		t.Fatalf("got:\n%q\nwant:\n%q", out.String(), want)
	}

	out.Reset()
	newUI(&out, false, false).updateAvailable("v0.0.11", r, "")
	want = `  A new release of pedit is available: v0.0.11 → v0.0.12
  https://github.com/piconic-ai/pedit/releases/tag/v0.0.12

`
	if out.String() != want {
		t.Fatalf("without a command, got:\n%q\nwant:\n%q", out.String(), want)
	}
}

func TestOutdated(t *testing.T) {
	var out bytes.Buffer
	newUI(&out, false, false).outdated(protocol.StatusClientOutdated, "brew upgrade piconic-ai/tap/pedit")
	want := `  This pedit is too old for the server. Update it and run pedit again.
  To upgrade, run: brew upgrade piconic-ai/tap/pedit

`
	if out.String() != want {
		t.Fatalf("got:\n%q\nwant:\n%q", out.String(), want)
	}

	out.Reset()
	newUI(&out, false, false).outdated(protocol.StatusClientOutdated, "")
	want = `  This pedit is too old for the server. Update it and run pedit again.
  https://github.com/piconic-ai/pedit#install

`
	if out.String() != want {
		t.Fatalf("without a command, got:\n%q\nwant:\n%q", out.String(), want)
	}

	out.Reset()
	newUI(&out, false, false).outdated(protocol.StatusServerOutdated, "brew upgrade piconic-ai/tap/pedit")
	want = `  The server is older than this pedit and cannot be used with it.
  Ask whoever runs the server to update it, or use an older pedit.

`
	if out.String() != want {
		t.Fatalf("server outdated, got:\n%q\nwant:\n%q", out.String(), want)
	}
}
