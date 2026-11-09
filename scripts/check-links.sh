#!/usr/bin/env bash
# Checks that every link from the repository's Markdown to a file in the
# repository points at a file that exists, and that every #fragment names a
# heading in that file. Web links are not checked (lychee.toml).
#
# Usage: scripts/check-links.sh [directory]   (default: the repository root)
# Needs lychee (https://lychee.cli.rs; `brew install lychee`).
set -euo pipefail

root="${1:-$(cd "$(dirname "$0")/.." && pwd)}"
cd "$root"

lychee --config lychee.toml -- \
  './*.md' \
  'docs/**/*.md' \
  'packages/*.md' \
  'packages/*/README.md' \
  'examples/*/README.md'
