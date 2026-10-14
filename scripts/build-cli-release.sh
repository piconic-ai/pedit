#!/usr/bin/env bash
# Build the release archives and checksums.txt for VERSION into OUTPUT_DIRECTORY.
#
# The archives are reproducible: the same commit built in the same environment
# (Go version, runner image) gives byte-identical files, so anyone can rebuild a
# release and compare it with the published checksums. Everything that would
# otherwise leak from the build machine is fixed:
#   - file times are SOURCE_DATE_EPOCH (default: the commit time of HEAD)
#   - modes are 0755 for the binary and 0644 for LICENSE, whatever the umask
#   - tar entries are owned by 0:0 with no user or group names
#   - gzip stores no file name or time (-n), zip no extra attributes (-X)
#   - zip's DOS times are local times, so they are written in UTC
# GNU tar is required (on macOS: brew install gnu-tar, which provides gtar).
set -euo pipefail

version=${1:?Usage: build-cli-release.sh VERSION OUTPUT_DIRECTORY}
output=${2:?Usage: build-cli-release.sh VERSION OUTPUT_DIRECTORY}

if tar --version 2>/dev/null | grep -q 'GNU tar'; then
  gnutar=tar
elif command -v gtar >/dev/null 2>&1; then
  gnutar=gtar
else
  echo "GNU tar is required to build reproducible archives (macOS: brew install gnu-tar)" >&2
  exit 1
fi

epoch=${SOURCE_DATE_EPOCH:-$(git log -1 --format=%ct)}
export TZ=UTC0
# touch -t takes local time, which TZ=UTC0 makes UTC. GNU date reads
# @EPOCH with -d, BSD date with -r.
stamp=$(date -d "@$epoch" +%Y%m%d%H%M.%S 2>/dev/null || date -r "$epoch" +%Y%m%d%H%M.%S)

mkdir -p "$output"
output=$(cd "$output" && pwd)
staging=$(mktemp -d)
trap 'rm -rf "$staging"' EXIT

for target in darwin/amd64 darwin/arm64 linux/amd64 linux/arm64 windows/amd64 windows/arm64; do
  os=${target%/*}
  arch=${target#*/}
  name="pedit_${version}_${os}_${arch}"
  package="$staging/$name"
  mkdir -p "$package"
  binary=pedit
  if [[ "$os" == windows ]]; then binary=pedit.exe; fi
  GOOS="$os" GOARCH="$arch" CGO_ENABLED=0 go build \
    -trimpath -ldflags "-s -w -X main.version=$version" \
    -o "$package/$binary" ./cmd/pedit
  cp LICENSE "$package/LICENSE"
  chmod 0755 "$package/$binary"
  chmod 0644 "$package/LICENSE"
  touch -t "$stamp" "$package/$binary" "$package/LICENSE"
  if [[ "$os" == windows ]]; then
    (cd "$package" && zip -q -X "$output/$name.zip" "$binary" LICENSE)
  else
    "$gnutar" --create --format=gnu --owner=0 --group=0 --numeric-owner \
      --mtime="@$epoch" -C "$package" "$binary" LICENSE |
      gzip -n -9 >"$output/$name.tar.gz"
  fi
done

(cd "$output" && sha256sum pedit_*.tar.gz pedit_*.zip > checksums.txt)
