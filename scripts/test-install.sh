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
# INSTALL_TEST_GH_SIGNER and its workflow INSTALL_TEST_GH_WORKFLOW. tar is
# wrapped only to record whether install.sh extracted anything.
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
[ "$#" -eq 8 ]
[ "$1" = attestation ] && [ "$2" = verify ] && [ -f "$3" ] || exit 99
signer=${INSTALL_TEST_GH_SIGNER:-piconic-ai/pedit}
[ "$4" = --repo ] && [ "$5" = "$signer" ] || exit 99
workflow=${INSTALL_TEST_GH_WORKFLOW:-release-build.yml}
[ "$6" = --signer-workflow ] && [ "$7" = "$signer/.github/workflows/$workflow" ] || exit 99
[ "$8" = --deny-self-hosted-runners ]
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

# --- Cases -----------------------------------------------------------------

verifies_provenance_when_gh_is_signed_in() {
  run_install signed-in
  assert_installed signed-in
  assert_contains signed-in out 'Downloading pedit .*\.\.\. DONE'
  assert_contains signed-in out 'Verifying build provenance\.\.\. DONE'
  assert_contains signed-in gh.log '^attestation verify '
  assert_contains signed-in gh.log ' --signer-workflow piconic-ai/pedit/\.github/workflows/release-build\.yml '
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

skips_provenance_when_gh_is_signed_out() {
  INSTALL_TEST_GH_AUTH_EXIT=1 run_install signed-out
  assert_installed signed-out
  assert_contains signed-out out 'Skipped the build provenance check'
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
  assert_contains no-gh out 'Skipped the build provenance check'
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
