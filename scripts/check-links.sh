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

inputs=(
  './*.md'
  'docs/**/*.md'
  'packages/*.md'
  'packages/*/README.md'
  'examples/*/README.md'
)

lychee --config lychee.toml -- "${inputs[@]}"

# A Markdown file that none of the inputs cover (a new directory, a moved one)
# would otherwise go unchecked without anyone noticing: lychee only warns
# about an input that matches nothing.
checked="$(lychee --config lychee.toml --dump-inputs -- "${inputs[@]}" | LC_ALL=C sort)"
present="$(find . -name '*.md' \
  -not -path './.git/*' -not -path '*/node_modules/*' -not -path '*/dist/*' -not -path '*/.wrangler/*' \
  | sed 's|^\./||' | LC_ALL=C sort)"
missing="$(comm -13 <(printf '%s\n' "$checked") <(printf '%s\n' "$present"))"
if [ -n "$missing" ]; then
  echo "Markdown files that scripts/check-links.sh does not check; add their path to its inputs:" >&2
  printf '  %s\n' $missing >&2
  exit 1
fi
