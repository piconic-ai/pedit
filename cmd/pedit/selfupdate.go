package main

import (
	"archive/tar"
	"archive/zip"
	"compress/gzip"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"math/rand/v2"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"strings"
	"time"
)

const selfUpdateUsage = `Usage: pedit self-update [--check] [--version vX.Y.Z]

Replace this pedit with the latest release (or the given one, if newer). The
archive is checked against checksums.txt and, when the GitHub CLI (gh) is
installed, against its build provenance, as install.sh does; if a check fails,
nothing is replaced. Only a pedit installed by install.sh or install.ps1, or
unpacked from a release archive, updates itself. For Homebrew, mise or go
install, pedit prints the command that does.

A pedit serve that is running keeps its version until it is restarted.

Options:
  --check            Say what would be updated, and change nothing
  --version vX.Y.Z   Update to that release instead of the latest (v0.1.6 or later)`

// Where self-update downloads from. Tests point these at a local server.
var (
	releaseDownloadURL = "https://github.com/piconic-ai/pedit/releases/download"
	githubAPIURL       = "https://api.github.com"
)

const (
	maxArchiveSize = 64 << 20
	maxSmallSize   = 1 << 20
	maxBinarySize  = 256 << 20
	// lastWithoutBundle is the last release that publishes no Sigstore bundle.
	lastWithoutBundle = "v0.1.5"
	signerRepo        = "piconic-ai/pedit"
)

var versionArg = regexp.MustCompile(`^v\d+\.\d+\.\d+$`)

// updater holds what self-update depends on, so tests can replace it.
type updater struct {
	exe, goos, goarch, home, current string
	goInstalled                      bool
	releasesAPI, downloadURL, apiURL string
	client                           *http.Client
	// hasGh says whether the GitHub CLI is installed; gh runs it with args and
	// returns what it wrote to stderr.
	hasGh func() bool
	gh    func(args []string) (stderr string, err error)
}

func runSelfUpdate(args []string, stdout, stderr io.Writer) int {
	exe, err := os.Executable()
	if err == nil {
		exe, err = filepath.EvalSymlinks(exe)
	}
	if err != nil {
		fmt.Fprintln(stderr, "pedit:", err)
		return 1
	}
	home, _ := os.UserHomeDir()
	u := updater{
		exe: exe, goos: runtime.GOOS, goarch: runtime.GOARCH, home: home,
		current: getVersion(), goInstalled: version == "",
		releasesAPI: releasesAPI, downloadURL: releaseDownloadURL, apiURL: githubAPIURL,
		client: &http.Client{Timeout: 2 * time.Minute},
		hasGh:  func() bool { _, err := exec.LookPath("gh"); return err == nil },
		gh: func(args []string) (string, error) {
			var buf strings.Builder
			cmd := exec.Command("gh", args...)
			cmd.Stderr = &buf
			err := cmd.Run()
			return buf.String(), err
		},
	}
	return u.run(args, stdout, stderr)
}

func (u updater) run(args []string, stdout, stderr io.Writer) int {
	fs := flag.NewFlagSet("self-update", flag.ContinueOnError)
	fs.SetOutput(io.Discard)
	check := fs.Bool("check", false, "")
	want := fs.String("version", "", "")
	if err := fs.Parse(args); err != nil || fs.NArg() > 0 {
		if err == nil {
			err = errors.New("unexpected argument " + fs.Arg(0))
		}
		return usageError(stderr, selfUpdateUsage, err)
	}
	if *want != "" && !versionArg.MatchString(*want) {
		return usageError(stderr, selfUpdateUsage, fmt.Errorf("--version must look like v1.2.3, not %q", *want))
	}
	refuse := func(format string, a ...any) int {
		fmt.Fprintf(stderr, "pedit: "+format+"\n", a...)
		return 2
	}

	if _, ok := parseVersion(u.current); !ok {
		return refuse("cannot update a development build (%s)", u.current)
	}
	if cmd := upgradeCommand(u.exe, u.goos, u.home, u.goInstalled); !viaInstallScript(cmd) {
		return refuse("this pedit was not installed by the install script, so it cannot update itself.\nUpdate it with: %s", cmd)
	}

	target := *want
	if target == "" {
		var err error
		if target, err = u.latestTag(); err != nil {
			fmt.Fprintln(stderr, "pedit: could not look up the latest release:", err)
			return 1
		}
	}
	switch {
	case target == u.current || (*want == "" && !newerVersion(u.current, target)):
		fmt.Fprintf(stdout, "pedit %s is up to date\n", u.current)
		return 0
	case !newerVersion(u.current, target):
		return refuse("%s is older than the running %s; self-update does not downgrade", target, u.current)
	case !newerVersion(lastWithoutBundle, target):
		return refuse("%s has no build provenance bundle; self-update needs v0.1.6 or later", target)
	}
	if *check {
		fmt.Fprintf(stdout, "Would update %s from %s to %s\n", u.exe, u.current, target)
		return 0
	}

	if err := u.update(target, stdout); err != nil {
		fmt.Fprintln(stderr, "pedit: self-update failed:", err)
		fmt.Fprintln(stderr, "Nothing was replaced.")
		return 1
	}
	fmt.Fprintf(stdout, "Updated pedit %s → %s\n", u.current, target)
	fmt.Fprintln(stdout, "A running pedit serve keeps the old version until it is restarted.")
	return 0
}

// viaInstallScript is whether cmd, from upgradeCommand, is one of the install
// scripts: the copies those install, or unpack from a release archive, can
// update themselves.
func viaInstallScript(cmd string) bool {
	return strings.Contains(cmd, "/install.sh") || strings.Contains(cmd, "/install.ps1")
}

// latestTag asks the releases API, never the update cache.
func (u updater) latestTag() (string, error) {
	req, err := http.NewRequest(http.MethodGet, u.releasesAPI, nil)
	if err != nil {
		return "", err
	}
	req.Header.Set("Accept", "application/vnd.github+json")
	res, err := u.client.Do(req)
	if err != nil {
		return "", err
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		return "", fmt.Errorf("%d %s", res.StatusCode, http.StatusText(res.StatusCode))
	}
	var r release
	if err := json.NewDecoder(io.LimitReader(res.Body, maxSmallSize)).Decode(&r); err != nil {
		return "", err
	}
	if !versionArg.MatchString(r.Version) {
		return "", fmt.Errorf("unexpected release tag %q", r.Version)
	}
	return r.Version, nil
}

// update downloads, verifies and installs the release tag.
func (u updater) update(tag string, out io.Writer) error {
	ext := ".tar.gz"
	if u.goos == "windows" {
		ext = ".zip"
	}
	archiveName := fmt.Sprintf("pedit_%s_%s_%s%s", tag, u.goos, u.goarch, ext)
	tmp, err := os.MkdirTemp("", "pedit-update-") // 0700
	if err != nil {
		return err
	}
	defer os.RemoveAll(tmp)
	archive, sums, bundle := filepath.Join(tmp, archiveName), filepath.Join(tmp, "checksums.txt"), filepath.Join(tmp, "bundle.json")

	fmt.Fprintf(out, "Downloading pedit %s (%s/%s)...\n", tag, u.goos, u.goarch)
	base := u.downloadURL + "/" + tag + "/"
	for _, f := range []struct {
		url, path string
		max       int64
	}{
		{base + archiveName, archive, maxArchiveSize},
		{base + "checksums.txt", sums, maxSmallSize},
		{base + "pedit_" + tag + ".sigstore.json", bundle, maxSmallSize},
	} {
		if err := u.download(f.url, f.path, f.max); err != nil {
			return err
		}
	}
	if err := verifyChecksum(archive, sums, archiveName); err != nil {
		return err
	}
	fmt.Fprintln(out, "Checksum matches")
	if err := u.verifyProvenance(tag, archive, bundle, out); err != nil {
		return err
	}

	mode := os.FileMode(0o755)
	if fi, err := os.Stat(u.exe); err == nil {
		mode = fi.Mode().Perm()
	}
	stage, err := os.CreateTemp(filepath.Dir(u.exe), ".pedit-update-*")
	if err != nil {
		return err
	}
	defer os.Remove(stage.Name()) // gone already once renamed
	if err := extractBinary(archive, u.goos, stage); err != nil {
		stage.Close()
		return err
	}
	if err := stage.Close(); err != nil {
		return err
	}
	if err := os.Chmod(stage.Name(), mode); err != nil {
		return err
	}
	return replaceFile(stage.Name(), u.exe, u.goos)
}

func (u updater) download(url, path string, max int64) error {
	res, err := u.client.Get(url)
	if err != nil {
		return fmt.Errorf("could not download %s: %w", url, err)
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		return fmt.Errorf("could not download %s: %d %s", url, res.StatusCode, http.StatusText(res.StatusCode))
	}
	f, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if err != nil {
		return err
	}
	n, err := io.Copy(f, io.LimitReader(res.Body, max+1))
	if cerr := f.Close(); err == nil {
		err = cerr
	}
	if err == nil && n > max {
		err = fmt.Errorf("%s is larger than %d bytes", url, max)
	}
	return err
}

// verifyChecksum compares the SHA-256 of archive with its line in sums.
func verifyChecksum(archive, sums, name string) error {
	data, err := os.ReadFile(sums)
	if err != nil {
		return err
	}
	want := ""
	for _, line := range strings.Split(string(data), "\n") {
		if f := strings.Fields(line); len(f) == 2 && strings.TrimPrefix(f[1], "*") == name {
			want = strings.ToLower(f[0])
		}
	}
	if want == "" {
		return fmt.Errorf("%s is not listed in checksums.txt", name)
	}
	f, err := os.Open(archive)
	if err != nil {
		return err
	}
	defer f.Close()
	h := sha256.New()
	if _, err := io.Copy(h, f); err != nil {
		return err
	}
	if hex.EncodeToString(h.Sum(nil)) != want {
		return fmt.Errorf("checksum mismatch for %s", name)
	}
	return nil
}

var commitSHA = regexp.MustCompile(`^[0-9a-f]{40}$`)

// tagCommit asks GitHub which commit the tag points to. Only the tag is sent.
func (u updater) tagCommit(tag string) (string, bool) {
	req, err := http.NewRequest(http.MethodGet, u.apiURL+"/repos/"+signerRepo+"/commits/"+tag, nil)
	if err != nil {
		return "", false
	}
	req.Header.Set("Accept", "application/vnd.github.sha")
	res, err := u.client.Do(req)
	if err != nil {
		return "", false
	}
	defer res.Body.Close()
	body, err := io.ReadAll(io.LimitReader(res.Body, 256))
	sha := strings.TrimSpace(string(body))
	return sha, err == nil && res.StatusCode == http.StatusOK && commitSHA.MatchString(sha)
}

// verifyProvenance runs gh attestation verify on the archive against the
// release's bundle, as install.sh does.
func (u updater) verifyProvenance(tag, archive, bundle string, out io.Writer) error {
	if !u.hasGh() {
		fmt.Fprintln(out, "Only the checksum was checked: the build provenance check needs the GitHub CLI")
		return nil
	}
	args := []string{"attestation", "verify", archive, "--bundle", bundle, "--repo", signerRepo,
		"--signer-workflow", signerRepo + "/.github/workflows/release-build.yml", "--deny-self-hosted-runners"}
	if sha, ok := u.tagCommit(tag); ok {
		args = append(args, "--source-digest", sha, "--signer-digest", sha)
	} else {
		fmt.Fprintf(out, "Could not look up the commit of %s, so the build is not pinned to it\n", tag)
	}
	if stderr, err := u.gh(args); err != nil {
		return fmt.Errorf("release provenance verification failed: %w\n%s", err, strings.TrimSpace(stderr))
	}
	fmt.Fprintln(out, "Build provenance verified")
	return nil
}

// extractBinary copies the pedit (pedit.exe) at the root of the archive to w.
// No other entry is read, and none is written anywhere.
func extractBinary(archive, goos string, w io.Writer) error {
	name := "pedit"
	if goos == "windows" {
		name += ".exe"
	}
	var r io.Reader
	if goos == "windows" {
		zr, err := zip.OpenReader(archive)
		if err != nil {
			return err
		}
		defer zr.Close()
		for _, f := range zr.File {
			if f.Name != name || !f.Mode().IsRegular() {
				continue
			}
			rc, err := f.Open()
			if err != nil {
				return err
			}
			defer rc.Close()
			r = rc
			break
		}
	} else {
		f, err := os.Open(archive)
		if err != nil {
			return err
		}
		defer f.Close()
		gz, err := gzip.NewReader(f)
		if err != nil {
			return err
		}
		tr := tar.NewReader(gz)
		for r == nil {
			h, err := tr.Next()
			if err == io.EOF {
				break
			}
			if err != nil {
				return err
			}
			if h.Name == name && h.Typeflag == tar.TypeReg {
				r = tr
			}
		}
	}
	if r == nil {
		return fmt.Errorf("the archive has no %s at its root", name)
	}
	n, err := io.Copy(w, io.LimitReader(r, maxBinarySize+1))
	if err == nil && n > maxBinarySize {
		err = fmt.Errorf("%s is larger than %d bytes", name, maxBinarySize)
	}
	return err
}

// replaceFile moves staged over dest. On Windows a running .exe cannot be
// overwritten but can be renamed, so the old one moves aside first, and goes
// back if the new one cannot take its place; install.ps1 does the same.
func replaceFile(staged, dest, goos string) error {
	if goos != "windows" {
		return os.Rename(staged, dest)
	}
	if _, err := os.Lstat(dest); err != nil {
		return os.Rename(staged, dest)
	}
	removeOldCopies(dest)
	old := dest + ".old"
	if _, err := os.Lstat(old); err == nil {
		// Still running from an earlier upgrade? Then pick another name.
		old = fmt.Sprintf("%s.old.%08x", dest, rand.Uint32())
	}
	if err := os.Rename(dest, old); err != nil {
		return err
	}
	if err := os.Rename(staged, dest); err != nil {
		if rerr := os.Rename(old, dest); rerr != nil {
			return errors.Join(err, rerr)
		}
		return err
	}
	removeOldCopies(dest)
	return nil
}

// removeOldCopies deletes what earlier upgrades left beside dest. One that is
// still running cannot be deleted and stays for the next update.
func removeOldCopies(dest string) {
	dir := filepath.Dir(dest)
	entries, _ := os.ReadDir(dir)
	for _, e := range entries {
		if strings.HasPrefix(e.Name(), filepath.Base(dest)+".old") {
			_ = os.Remove(filepath.Join(dir, e.Name()))
		}
	}
}
