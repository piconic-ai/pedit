package main

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"time"
)

// releasesAPI answers with the newest published release of pedit.
const releasesAPI = "https://api.github.com/repos/piconic-ai/pedit/releases/latest"

// updateInterval is how long a checked release is trusted before asking again.
const updateInterval = 24 * time.Hour

type release struct {
	Version string `json:"tag_name"`
	URL     string `json:"html_url"`
}

type updateState struct {
	CheckedAt time.Time `json:"checked_at"`
	Latest    release   `json:"latest"`
}

// updateChecker finds out whether a newer pedit is out. It asks GitHub at
// most once per updateInterval and keeps the answer in statePath.
type updateChecker struct {
	api       string
	statePath string
	client    *http.Client
	now       func() time.Time
}

func newUpdateChecker() (updateChecker, error) {
	dir, err := os.UserCacheDir()
	if err != nil {
		return updateChecker{}, err
	}
	return updateChecker{
		api:       releasesAPI,
		statePath: filepath.Join(dir, "pedit", "update.json"),
		client:    &http.Client{Timeout: 5 * time.Second},
		now:       time.Now,
	}, nil
}

// check returns the latest release when it is newer than current, or nil.
func (c updateChecker) check(ctx context.Context, current string) (*release, error) {
	latest, err := c.latest(ctx)
	if err != nil {
		return nil, err
	}
	if !newerVersion(current, latest.Version) {
		return nil, nil
	}
	return &latest, nil
}

func (c updateChecker) latest(ctx context.Context) (release, error) {
	if data, err := os.ReadFile(c.statePath); err == nil {
		var s updateState
		if json.Unmarshal(data, &s) == nil && s.Latest.Version != "" && c.now().Sub(s.CheckedAt) < updateInterval {
			return s.Latest, nil
		}
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, c.api, nil)
	if err != nil {
		return release{}, err
	}
	req.Header.Set("Accept", "application/vnd.github+json")
	res, err := c.client.Do(req)
	if err != nil {
		return release{}, err
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		return release{}, fmt.Errorf("%s: %d %s", c.api, res.StatusCode, http.StatusText(res.StatusCode))
	}
	var r release
	if err := json.NewDecoder(res.Body).Decode(&r); err != nil {
		return release{}, err
	}
	if r.Version == "" {
		return release{}, fmt.Errorf("%s: no tag_name", c.api)
	}
	// A failed save only means asking again next time.
	if data, err := json.Marshal(updateState{CheckedAt: c.now(), Latest: r}); err == nil {
		if os.MkdirAll(filepath.Dir(c.statePath), 0o755) == nil {
			_ = os.WriteFile(c.statePath, data, 0o644)
		}
	}
	return r, nil
}

// startUpdateCheck checks for a newer release in the background, so sharing
// never waits on it. The returned function gives the result if it is in by
// then, and nil otherwise. Development builds, CI and output that is not a
// terminal are never checked.
func startUpdateCheck(current string, tty bool) func() *release {
	if !tty || current == "dev" || os.Getenv("CI") != "" {
		return func() *release { return nil }
	}
	c, err := newUpdateChecker()
	if err != nil {
		return func() *release { return nil }
	}
	done := make(chan *release, 1)
	go func() {
		// Not the session's context: Ctrl+C ends the session, and the
		// result is read only after that.
		r, _ := c.check(context.Background(), current)
		done <- r
	}()
	return func() *release {
		select {
		case r := <-done:
			return r
		default:
			return nil
		}
	}
}

// newerVersion reports whether latest is a later version than current.
// Versions look like v1.2.3 or v1.2.3-rc.1; anything else is never newer.
func newerVersion(current, latest string) bool {
	c, ok := parseVersion(current)
	if !ok {
		return false
	}
	l, ok := parseVersion(latest)
	if !ok {
		return false
	}
	for i := range 3 {
		if l.nums[i] != c.nums[i] {
			return l.nums[i] > c.nums[i]
		}
	}
	switch {
	case c.pre == "" || l.pre == c.pre:
		return false
	case l.pre == "":
		return true
	default:
		return l.pre > c.pre
	}
}

type semver struct {
	nums [3]int
	pre  string
}

func parseVersion(v string) (semver, bool) {
	var s semver
	v, ok := strings.CutPrefix(v, "v")
	if !ok {
		return s, false
	}
	v, s.pre, _ = strings.Cut(v, "-")
	parts := strings.Split(v, ".")
	if len(parts) != 3 {
		return s, false
	}
	for i, p := range parts {
		n, err := strconv.Atoi(p)
		if err != nil || n < 0 {
			return s, false
		}
		s.nums[i] = n
	}
	return s, true
}

// upgradeCommand guesses how pedit was installed from where its binary is,
// and returns the command that upgrades it in place, or "" when there is
// none to give. home is the user's home directory.
func upgradeCommand(exe, goos, home string, goInstalled bool) string {
	slashed := filepath.ToSlash(exe)
	switch {
	case goInstalled:
		return "go install github.com/piconic-ai/pedit/cmd/pedit@latest"
	case strings.Contains(slashed, "/Cellar/"):
		return "brew upgrade piconic-ai/tap/pedit"
	case strings.Contains(slashed, "/installs/github-piconic-ai-pedit/"):
		// --bump also moves a version pinned in mise.toml, wherever it is.
		return "mise upgrade --bump github:piconic-ai/pedit"
	case strings.Contains(slashed, "/installs/github-piconic-ai-edit/"):
		// Installed under the repository's old name, which mise.toml still
		// names; GitHub redirects it to piconic-ai/pedit.
		return "mise upgrade --bump github:piconic-ai/edit"
	case goos == "windows":
		return ""
	}
	// install.sh puts pedit in ~/.local/bin unless told otherwise. Anywhere
	// else, it has to be told, or the new pedit lands beside the old one.
	const install = "curl -fsSL https://edit.piconic.ai/install.sh | "
	dir := filepath.Dir(exe)
	if home != "" && dir == filepath.Join(home, ".local", "bin") {
		return install + "sh"
	}
	return install + "PEDIT_INSTALL_DIR=" + shellQuote(dir) + " sh"
}

// notifyUpdate tells the user about a newer release, if one was found.
func notifyUpdate(out *ui, latest func() *release) {
	r := latest()
	if r == nil {
		return
	}
	out.updateAvailable(getVersion(), *r, selfUpgradeCommand())
}

// selfUpgradeCommand is upgradeCommand for the running pedit.
func selfUpgradeCommand() string {
	exe, err := os.Executable()
	if err == nil {
		if resolved, err := filepath.EvalSymlinks(exe); err == nil {
			exe = resolved
		}
	}
	home, _ := os.UserHomeDir()
	// version is set on release builds; go install leaves it empty.
	return upgradeCommand(exe, runtime.GOOS, home, version == "")
}
