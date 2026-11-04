#!/usr/bin/env bash
# Run packages/web/public/install.sh against archives built by GoReleaser
# (.goreleaser.yaml), served from a local directory instead of GitHub Releases.
#
# Each case installs into its own $work/<name>/bin and keeps install.sh's
# output in $work/<name>/{out,err}, plus what the gh and tar mocks saw in
# $work/<name>/{gh,tar}.log.
set -euo pipefail

version=${1:?Usage: test-install.sh VERSION RELEASE_DIRECTORY}
release=${2:?Usage: test-install.sh VERSION RELEASE_DIRECTORY}
release=$(cd "$release" && pwd)
script="$(cd "$(dirname "$0")/.." && pwd)/packages/web/public/install.sh"
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

# --- Helpers ---------------------------------------------------------------

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

# CI archives have no published attestation, so gh is mocked at the process
# boundary: INSTALL_TEST_GH_AUTH_EXIT is the active account's `gh auth status`
# result, INSTALL_TEST_GH_INACTIVE_EXPIRED adds another stored account whose
# token expired, and INSTALL_TEST_GH_EXIT is the `gh attestation verify` result,
# which arrives after INSTALL_TEST_GH_DELAY seconds. Like the real gh, the
# mock rejects any identity but the release's signer: the repository
# INSTALL_TEST_GH_SIGNER and its workflow INSTALL_TEST_GH_WORKFLOW. It wants
# --bundle with an existing file only if INSTALL_TEST_GH_WANT_BUNDLE is set, and
# --source-digest and --signer-digest both equal to INSTALL_TEST_GH_DIGEST, or
# neither if that is unset. tar is wrapped only to record whether install.sh
# extracted anything.
setup_mocks() {
  mkdir "$work/mocks"
  cat >"$work/mocks/gh" <<'SH'
#!/bin/sh
set -eu
printf '%s\n' "$*" >>"$INSTALL_TEST_GH_LOG"
if [ "$1" = auth ]; then
  case "$*" in
    "auth status --active --hostname github.com") ;;
    "auth status --hostname github.com") [ -z "${INSTALL_TEST_GH_INACTIVE_EXPIRED:-}" ] || exit 1 ;;
    *) exit 99 ;;
  esac
  exit "${INSTALL_TEST_GH_AUTH_EXIT:-0}"
fi
[ "$1" = attestation ] && [ "$2" = verify ] && [ -f "$3" ] || exit 99
shift 3
bundle='' repo='' workflow='' deny='' source='' signer_digest=''
while [ "$#" -gt 0 ]; do
  case $1 in
    --bundle) bundle=$2; shift ;;
    --repo) repo=$2; shift ;;
    --signer-workflow) workflow=$2; shift ;;
    --source-digest) source=$2; shift ;;
    --signer-digest) signer_digest=$2; shift ;;
    --deny-self-hosted-runners) deny=1 ;;
    *) exit 99 ;;
  esac
  shift
done
signer=${INSTALL_TEST_GH_SIGNER:-piconic-ai/pedit}
[ "$repo" = "$signer" ] || exit 99
[ "$workflow" = "$signer/.github/workflows/${INSTALL_TEST_GH_WORKFLOW:-release-build.yml}" ] || exit 99
[ -n "$deny" ] || exit 99
if [ -n "${INSTALL_TEST_GH_WANT_BUNDLE:-}" ]; then [ -f "$bundle" ] || exit 99; else [ -z "$bundle" ] || exit 99; fi
[ "$source" = "${INSTALL_TEST_GH_DIGEST:-}" ] && [ "$signer_digest" = "${INSTALL_TEST_GH_DIGEST:-}" ] || exit 99
sleep "${INSTALL_TEST_GH_DELAY:-0}"
exit "${INSTALL_TEST_GH_EXIT:-0}"
SH
  cat >"$work/mocks/tar" <<SH
#!/bin/sh
echo invoked >>"\$INSTALL_TEST_TAR_LOG"
exec "$(command -v tar)" "\$@"
SH
  chmod +x "$work/mocks/gh" "$work/mocks/tar"
  export PATH="$work/mocks:$PATH"
}

# try_install NAME [LAUNCHER...]: run install.sh (through LAUNCHER, default sh).
# Assignments before the call, such as PEDIT_DOWNLOAD_URL or INSTALL_TEST_GH_*,
# reach install.sh.
try_install() {
  local name=$1
  shift
  mkdir -p "$work/$name"
  INSTALL_TEST_GH_LOG="$work/$name/gh.log" INSTALL_TEST_TAR_LOG="$work/$name/tar.log" \
    PEDIT_VERSION="${PEDIT_VERSION:-$version}" PEDIT_DOWNLOAD_URL="${PEDIT_DOWNLOAD_URL:-file://$release}" \
    PEDIT_API_URL="${PEDIT_API_URL:-file://$work/api}" \
    PEDIT_INSTALL_DIR="$work/$name/bin" \
    "${@:-/bin/sh}" "$script" >"$work/$name/out" 2>"$work/$name/err"
}

run_install() {
  try_install "$@" || fail "$1: install.sh failed: $(cat "$work/$1/err")"
}

expect_failure() {
  if try_install "$@"; then fail "$1: install.sh succeeded"; fi
}

assert_installed() {
  [ "$("$work/$1/bin/pedit" --version)" = "$version" ] || fail "$1: pedit $version is not installed"
}

# assert_contains NAME FILE PATTERN / refute_contains NAME FILE PATTERN, where
# FILE is out, err, gh.log or tar.log.
assert_contains() {
  grep -q "$3" "$work/$1/$2" || fail "$1: $2 does not contain '$3'"
}

refute_contains() {
  if grep -q "$3" "$work/$1/$2" 2>/dev/null; then fail "$1: $2 contains '$3'"; fi
}

# on_terminal CMD...: run CMD with a pseudo-terminal as its output.
on_terminal() {
  if script --version >/dev/null 2>&1; then
    script -qec "$(printf '%q ' "$@")" /dev/null </dev/null # util-linux
  else
    script -q /dev/null "$@" </dev/null # BSD, macOS
  fi
}

assert_no_staging_left() {
  [ -z "$(find "$work/$1/bin" -name '.pedit.*')" ] || fail "$1: a staging directory was left behind"
}

# bundle_release NAME TAG: the release directory re-labelled as TAG (a version
# with a Sigstore bundle), plus a stand-in bundle. The mock gh does not read it.
# tag_commit TAG SHA: what the fake GitHub API answers for that tag.
bundle_release() {
  local dir="$work/$1" f
  mkdir "$dir"
  for f in "$release"/pedit_*; do
    f=${f##*/}
    cp "$release/$f" "$dir/${f/"$version"/$2}"
  done
  sed "s/$version/$2/" "$release/checksums.txt" >"$dir/checksums.txt"
  echo '{}' >"$dir/pedit_$2.sigstore.json"
}

tag_commit() {
  mkdir -p "$work/api/repos/piconic-ai/pedit/commits"
  printf '%s\n' "$2" >"$work/api/repos/piconic-ai/pedit/commits/$1"
}

sha=0123456789abcdef0123456789abcdef01234567

# --- Cases -----------------------------------------------------------------

verifies_provenance_when_gh_is_signed_in() {
  run_install signed-in
  assert_installed signed-in
  assert_contains signed-in out 'Downloading pedit .*\.\.\. DONE'
  assert_contains signed-in out 'Verifying build provenance\.\.\. DONE'
  assert_contains signed-in gh.log '^attestation verify '
  assert_contains signed-in gh.log ' --signer-workflow piconic-ai/pedit/\.github/workflows/release-build\.yml '
  # A release without a bundle needs the sign-in and is not pinned to a commit.
  refute_contains signed-in gh.log 'bundle\|digest'
}

verifies_provenance_despite_an_expired_inactive_account() {
  INSTALL_TEST_GH_INACTIVE_EXPIRED=1 run_install inactive-expired
  assert_installed inactive-expired
  assert_contains inactive-expired out 'Verifying build provenance\.\.\. DONE'
  assert_contains inactive-expired gh.log '^attestation verify '
}

verifies_a_release_signed_before_the_rename() {
  # The same archives, published as v0.0.12: signed as piconic-ai/edit.
  local old="$work/old-release" f
  mkdir "$old"
  for f in "$release"/pedit_*; do
    f=${f##*/}
    cp "$release/$f" "$old/${f/"$version"/v0.0.12}"
  done
  sed "s/$version/v0.0.12/" "$release/checksums.txt" >"$old/checksums.txt"
  PEDIT_VERSION=v0.0.12 PEDIT_DOWNLOAD_URL="file://$old" INSTALL_TEST_GH_SIGNER=piconic-ai/edit \
    INSTALL_TEST_GH_WORKFLOW=tagpr.yml run_install renamed
  assert_contains renamed out 'Verifying build provenance\.\.\. DONE'
  assert_contains renamed out 'Installed pedit v0\.0\.12'
  assert_contains renamed gh.log ' --repo piconic-ai/edit --signer-workflow piconic-ai/edit/'
}

verifies_a_release_signed_by_tagpr_yml() {
  # The same archives, published as v0.1.2: built in tagpr.yml before
  # release-build.yml took the build over.
  local old="$work/tagpr-release" f
  mkdir "$old"
  for f in "$release"/pedit_*; do
    f=${f##*/}
    cp "$release/$f" "$old/${f/"$version"/v0.1.2}"
  done
  sed "s/$version/v0.1.2/" "$release/checksums.txt" >"$old/checksums.txt"
  PEDIT_VERSION=v0.1.2 PEDIT_DOWNLOAD_URL="file://$old" INSTALL_TEST_GH_WORKFLOW=tagpr.yml \
    run_install tagpr-signed
  assert_contains tagpr-signed out 'Verifying build provenance\.\.\. DONE'
  assert_contains tagpr-signed gh.log ' --signer-workflow piconic-ai/pedit/\.github/workflows/tagpr\.yml '
}

verifies_the_bundle_when_gh_is_signed_out() {
  bundle_release bundle-release v0.5.1
  tag_commit v0.5.1 "$sha"
  PEDIT_VERSION=v0.5.1 PEDIT_DOWNLOAD_URL="file://$work/bundle-release" INSTALL_TEST_GH_AUTH_EXIT=1 \
    INSTALL_TEST_GH_WANT_BUNDLE=1 INSTALL_TEST_GH_DIGEST=$sha run_install bundle
  assert_contains bundle out 'Verifying build provenance\.\.\. DONE'
  assert_contains bundle out 'Installed pedit v0\.5\.1'
  refute_contains bundle out 'not pinned'
  refute_contains bundle gh.log '^auth'
  assert_contains bundle gh.log " --source-digest $sha --signer-digest $sha "
  assert_contains bundle gh.log ' --bundle .*bundle\.json'
}

refuses_a_bundle_release_without_its_bundle() {
  bundle_release unbundled-release v0.5.1
  rm "$work/unbundled-release/pedit_v0.5.1.sigstore.json"
  tag_commit v0.5.1 "$sha"
  PEDIT_VERSION=v0.5.1 PEDIT_DOWNLOAD_URL="file://$work/unbundled-release" expect_failure unbundled
  assert_contains unbundled err 'could not download .*sigstore\.json'
  refute_contains unbundled out Installed
  refute_contains unbundled tar.log invoked
  [ ! -e "$work/unbundled/bin/pedit" ] || fail "unbundled: pedit was installed"
}

refuses_a_failed_bundle_verification() {
  PEDIT_VERSION=v0.5.1 PEDIT_DOWNLOAD_URL="file://$work/bundle-release" INSTALL_TEST_GH_EXIT=1 \
    INSTALL_TEST_GH_WANT_BUNDLE=1 INSTALL_TEST_GH_DIGEST=$sha expect_failure bundle-rejected
  assert_contains bundle-rejected err 'release provenance verification failed'
  refute_contains bundle-rejected tar.log invoked
  [ ! -e "$work/bundle-rejected/bin/pedit" ] || fail "bundle-rejected: pedit was installed"
}

verifies_without_a_pin_when_the_commit_lookup_fails() {
  # No answer for v0.5.2 (a 404 or a rate limit), then answers that are not a SHA.
  local answer name=unpinned
  bundle_release unpinned-release v0.5.2
  for answer in MISSING not-a-sha "${sha}0" "${sha%?}F" ''; do
    [ "$answer" = MISSING ] || tag_commit v0.5.2 "$answer"
    PEDIT_VERSION=v0.5.2 PEDIT_DOWNLOAD_URL="file://$work/unpinned-release" INSTALL_TEST_GH_WANT_BUNDLE=1 \
      run_install "$name"
    assert_contains "$name" out 'Could not look up the commit of v0\.5\.2, so the build is not pinned'
    assert_contains "$name" out 'Verifying build provenance\.\.\. DONE'
    refute_contains "$name" gh.log 'digest'
    name=$name-again
  done
}

skips_provenance_when_gh_is_signed_out() {
  INSTALL_TEST_GH_AUTH_EXIT=1 run_install signed-out
  assert_installed signed-out
  assert_contains signed-out out 'Skipped the build provenance check (needs the GitHub CLI, signed in)'
  refute_contains signed-out gh.log '^attestation'
}

skips_provenance_without_gh() {
  # A PATH holding only what install.sh needs, so a real gh cannot be found.
  local path="$work/path-without-gh" cmd
  mkdir "$path"
  for cmd in uname curl mktemp grep sha256sum shasum tar gzip cp chmod mkdir mv rm cat; do
    if command -v "$cmd" >/dev/null; then ln -s "$(command -v "$cmd")" "$path/$cmd"; fi
  done
  PATH="$path" run_install no-gh
  assert_installed no-gh
  assert_contains no-gh out 'Skipped the build provenance check (needs the GitHub CLI)'
  refute_contains no-gh out 'signed in'
}

refuses_failed_provenance() {
  local code name
  for code in 1 2 127; do
    name=rejected-$code
    mkdir -p "$work/$name/bin"
    echo untouched >"$work/$name/bin/pedit"
    INSTALL_TEST_GH_EXIT=$code expect_failure "$name"
    assert_contains "$name" out 'Verifying build provenance\.\.\. FAILED'
    assert_contains "$name" err 'release provenance verification failed'
    refute_contains "$name" out Installed
    refute_contains "$name" tar.log invoked
    [ "$(cat "$work/$name/bin/pedit")" = untouched ] || fail "$name: pedit was replaced"
    assert_no_staging_left "$name"
  done
}

cycles_dots_on_a_terminal() {
  # A slow check gives the dots time to cycle; "... DONE" alone has neither
  # the one-dot nor the two-dot frame, which are padded with spaces.
  INSTALL_TEST_GH_DELAY=1 run_install terminal on_terminal /bin/sh
  assert_installed terminal
  assert_contains terminal out 'Verifying build provenance\.  '
  assert_contains terminal out 'Verifying build provenance\.\. '
  assert_contains terminal out 'Verifying build provenance\.\.\. DONE'
}

replaces_a_running_pedit() {
  mkdir -p "$work/running/bin"
  cp "$(command -v sleep)" "$work/running/bin/pedit"
  "$work/running/bin/pedit" 60 &
  local pid=$!
  run_install running
  kill "$pid"
  assert_installed running
  assert_no_staging_left running
}

leaves_a_planted_staging_link_alone() {
  local victim="$work/victim"
  echo untouched >"$victim"
  chmod 600 "$victim"
  mkdir -p "$work/planted/bin"
  # exec keeps the PID, so .pedit.$$ is the name install.sh would see as $$.
  # shellcheck disable=SC2016 # expanded by the inner sh
  run_install planted sh -c 'ln -s "$1" "$2/.pedit.$$" && exec sh "$3"' sh "$victim" "$work/planted/bin"
  assert_installed planted
  [ "$(cat "$victim")" = untouched ] || fail "planted: the link target was overwritten"
  [ -n "$(find "$victim" -perm 600)" ] || fail "planted: the link target's mode changed"
}

refuses_a_directory_destination() {
  mkdir -p "$work/directory/bin/pedit"
  expect_failure directory
  assert_contains directory err 'is a directory'
  refute_contains directory out Installed
  [ -d "$work/directory/bin/pedit" ] && [ -z "$(ls -A "$work/directory/bin/pedit")" ] ||
    fail "directory: the existing directory was changed"
}

refuses_a_checksum_mismatch() {
  local bad="$work/bad-release"
  mkdir "$bad"
  cp "$release"/* "$bad/"
  sed -E 's/^[0-9a-f]{64}/0000000000000000000000000000000000000000000000000000000000000000/' \
    "$release/checksums.txt" >"$bad/checksums.txt"
  PEDIT_DOWNLOAD_URL="file://$bad" expect_failure mismatch
  assert_contains mismatch err 'checksum mismatch'
  [ ! -e "$work/mismatch/bin/pedit" ] || fail "mismatch: pedit was installed"
  refute_contains mismatch gh.log .
  refute_contains mismatch tar.log invoked
}

# --- Run -------------------------------------------------------------------

setup_mocks
for case in \
  verifies_provenance_when_gh_is_signed_in \
  verifies_provenance_despite_an_expired_inactive_account \
  verifies_a_release_signed_before_the_rename \
  verifies_a_release_signed_by_tagpr_yml \
  verifies_the_bundle_when_gh_is_signed_out \
  refuses_a_bundle_release_without_its_bundle \
  refuses_a_failed_bundle_verification \
  verifies_without_a_pin_when_the_commit_lookup_fails \
  skips_provenance_when_gh_is_signed_out \
  skips_provenance_without_gh \
  refuses_failed_provenance \
  cycles_dots_on_a_terminal \
  replaces_a_running_pedit \
  leaves_a_planted_staging_link_alone \
  refuses_a_directory_destination \
  refuses_a_checksum_mismatch; do
  echo "--- ${case//_/ }"
  "$case"
done
echo "ok"
