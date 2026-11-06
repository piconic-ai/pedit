#!/usr/bin/env bash
# Print the version tagpr proposes for the next release, without the "v".
#
#   release-pr-version.sh <latest-tag> [label...]
#
# Mirrors Songmu/tagpr v1.21 (semver.go): on the release PR, tagpr:major (or
# tagpr/major) bumps the major, even from 0.x; else tagpr:minor (or tagpr/minor)
# bumps the minor; otherwise the patch is bumped. Major wins over minor.
set -euo pipefail

tag=${1:?usage: release-pr-version.sh <latest-tag> [label...]}
shift
if [[ ! $tag =~ ^v([0-9]+)\.([0-9]+)\.([0-9]+)$ ]]; then
  echo "not a release tag: $tag" >&2
  exit 1
fi
major=${BASH_REMATCH[1]} minor=${BASH_REMATCH[2]} patch=${BASH_REMATCH[3]}

bump="patch"
for label in "$@"; do
  case $label in
    tagpr:major | tagpr/major) bump=major ;;
    tagpr:minor | tagpr/minor) [[ $bump == major ]] || bump=minor ;;
  esac
done

case $bump in
  major) echo "$((major + 1)).0.0" ;;
  minor) echo "$major.$((minor + 1)).0" ;;
  patch) echo "$major.$minor.$((patch + 1))" ;;
esac
