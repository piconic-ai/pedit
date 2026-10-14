#!/bin/sh
# Install pedit from GitHub Releases:
#
#   curl -fsSL https://edit.piconic.ai/install.sh | sh
#
# PEDIT_VERSION     release tag to install (default: the latest release)
# PEDIT_INSTALL_DIR where to put the binary (default: ~/.local/bin)
#
# The archive is checked against checksums.txt, and against its build
# provenance too when the GitHub CLI is installed and signed in.
# It never uses sudo and never edits shell profiles. Everything runs from
# main(), called on the last line, so a truncated download does nothing.
set -eu

repo=piconic-ai/pedit

fail() {
  [ -z "${step_label:-}" ] || step_end FAILED
  echo "pedit install: $*" >&2
  exit 1
}

# Steps print "<label>... DONE". On a terminal the dots after the label cycle
# while the step runs, so a slow download or check does not look stuck.
step_start() {
  step_label=$1
  if [ -t 1 ]; then
    while :; do
      for dots in '.  ' '.. ' '...'; do
        printf '\r%s%s' "$step_label" "$dots"
        sleep 0.3 2>/dev/null || sleep 1
      done
    done &
    dots_pid=$!
  else
    printf '%s... ' "$step_label"
  fi
}

# step_end DONE|FAILED
step_end() {
  if [ -n "${dots_pid:-}" ]; then
    kill "$dots_pid" 2>/dev/null || true
    wait "$dots_pid" 2>/dev/null || true
    dots_pid=
    printf '\r%s... ' "$step_label"
  fi
  echo "$1"
  step_label=
}

detect_target() {
  case $(uname -s) in
    Darwin) os=darwin ;;
    Linux) os=linux ;;
    *) fail "unsupported OS $(uname -s); download a binary from https://github.com/$repo/releases" ;;
  esac
  case $(uname -m) in
    x86_64 | amd64) arch=amd64 ;;
    arm64 | aarch64) arch=arm64 ;;
    *) fail "unsupported architecture $(uname -m); download a binary from https://github.com/$repo/releases" ;;
  esac
}

latest_version() {
  # /releases/latest redirects to /releases/tag/<tag>; this avoids the API rate limit.
  url=$(curl -fsSLI -o /dev/null -w '%{url_effective}' "https://github.com/$repo/releases/latest") ||
    fail "could not look up the latest release"
  case ${url##*/} in
    v*) echo "${url##*/}" ;;
    *) fail "could not find the latest release at $url" ;;
  esac
}

# Background jobs ignore SIGINT in a script, so stop the dots on any exit.
cleanup() {
  [ -z "${dots_pid:-}" ] || kill "$dots_pid" 2>/dev/null || true
  rm -rf "$tmp"
  [ -z "$stage" ] || rm -rf "$stage"
}

download() {
  curl -fsSL -o "$2" "$1" 2>"$tmp/curl.err" || fail "could not download $1: $(cat "$tmp/curl.err")"
}

verify_checksum() {
  # $1: directory holding the archive and checksums.txt, $2: archive name
  grep "  $2\$" "$1/checksums.txt" >"$1/expected.txt" || fail "$2 is not listed in checksums.txt"
  if command -v sha256sum >/dev/null 2>&1; then
    sum="sha256sum"
  elif command -v shasum >/dev/null 2>&1; then
    sum="shasum -a 256"
  else
    fail "neither sha256sum nor shasum is available to verify the download"
  fi
  (cd "$1" && $sum -c expected.txt >/dev/null 2>&1) || fail "checksum mismatch for $2"
}

# signer VERSION: the repository whose workflow signed that release. Releases
# up to v0.0.12 were built before the repository was renamed from
# piconic-ai/edit, and the signature keeps the name it was made under.
signer() {
  case $1 in
    v0.0.[0-9] | v0.0.1[0-2]) echo piconic-ai/edit ;;
    *) echo "$repo" ;;
  esac
}

# signer_workflow VERSION: the workflow file that signed that release. Up to
# v0.1.2 the archives were built in tagpr.yml itself; later releases are built
# by the reusable release-build.yml, which then is the signer.
signer_workflow() {
  case $1 in
    v0.0.[0-9] | v0.0.1[0-3] | v0.1.[0-2]) echo tagpr.yml ;;
    *) echo release-build.yml ;;
  esac
}

verify_provenance() {
  # Optional: gh fetches attestations from the GitHub API, which needs a sign-in.
  # --active: without it, any other stored account with an expired token fails.
  if ! command -v gh >/dev/null 2>&1 || ! gh auth status --active --hostname github.com >/dev/null 2>&1; then
    echo "Skipped the build provenance check (needs the GitHub CLI, signed in)"
    return
  fi
  step_start "Verifying build provenance"
  signed_by=$(signer "$version")
  if ! gh attestation verify "$1" \
    --repo "$signed_by" \
    --signer-workflow "$signed_by/.github/workflows/$(signer_workflow "$version")" \
    --deny-self-hosted-runners >/dev/null 2>"$tmp/gh.err"; then
    step_end FAILED
    cat "$tmp/gh.err" >&2
    fail "release provenance verification failed; no files were installed"
  fi
  step_end DONE
}

main() {
  command -v curl >/dev/null 2>&1 || fail "curl is required"
  detect_target
  version=${PEDIT_VERSION:-}
  [ -n "$version" ] || version=$(latest_version)
  install_dir=${PEDIT_INSTALL_DIR:-$HOME/.local/bin}
  # PEDIT_DOWNLOAD_URL replaces GitHub in tests (scripts/test-install.sh).
  base=${PEDIT_DOWNLOAD_URL:-https://github.com/$repo/releases/download/$version}
  archive="pedit_${version}_${os}_${arch}.tar.gz"

  tmp=$(mktemp -d)
  stage=
  trap cleanup EXIT
  trap 'fail interrupted' INT TERM

  step_start "Downloading pedit $version ($os/$arch)"
  download "$base/$archive" "$tmp/$archive"
  download "$base/checksums.txt" "$tmp/checksums.txt"
  verify_checksum "$tmp" "$archive"
  step_end DONE
  verify_provenance "$tmp/$archive"

  tar -xzf "$tmp/$archive" -C "$tmp" pedit
  mkdir -p "$install_dir"
  # mv would move the binary into a directory instead of replacing it.
  [ ! -d "$install_dir/pedit" ] || fail "$install_dir/pedit is a directory"
  # Stage next to the destination and rename over it: overwriting a running
  # pedit in place fails on Linux (Text file busy), and a rename never leaves
  # a half-written binary behind. mktemp creates the staging directory
  # exclusively, so nothing planted under a guessable name gets written to.
  stage=$(mktemp -d "$install_dir/.pedit.XXXXXXXX")
  cp "$tmp/pedit" "$stage/pedit"
  chmod 755 "$stage/pedit"
  mv -f "$stage/pedit" "$install_dir/pedit"
  echo "Installed pedit $version to $install_dir/pedit"

  case ":$PATH:" in
    *":$install_dir:"*) ;;
    *) echo "Add $install_dir to your PATH to run pedit, for example: export PATH=\"$install_dir:\$PATH\"" ;;
  esac
}

main "$@"
