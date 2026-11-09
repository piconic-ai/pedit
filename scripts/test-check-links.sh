#!/usr/bin/env bash
# Tests scripts/check-links.sh: a tree whose links are all good passes, and a
# missing file, a fragment that names no heading, or a fragment that names no
# heading in the page itself each fails.
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

make_tree() {
  rm -rf "$work/tree"
  mkdir -p "$work/tree/docs" "$work/tree/scripts"
  cp "$here/../lychee.toml" "$work/tree/"
  cp "$here/check-links.sh" "$work/tree/scripts/"
  cat > "$work/tree/docs/guide.md" <<'EOF'
# Guide

## Kept rooms

Text.
EOF
  cat > "$work/tree/README.md" <<EOF
# Test

[guide](docs/guide.md) [section](docs/guide.md#kept-rooms) [here](#test) $1
EOF
}

expect() {
  local want="$1" label="$2"
  if "$work/tree/scripts/check-links.sh" "$work/tree" > "$work/out" 2>&1; then got=pass; else got=fail; fi
  if [ "$got" != "$want" ]; then
    echo "FAIL: $label: expected $want, got $got" >&2
    cat "$work/out" >&2
    exit 1
  fi
  echo "ok: $label"
}

make_tree ""
expect pass "good links pass"

make_tree "[missing](docs/nope.md)"
expect fail "a missing file fails"

make_tree "[fragment](docs/guide.md#no-such-heading)"
expect fail "a fragment that names no heading fails"

make_tree "[own fragment](#no-such-heading)"
expect fail "a fragment of the page itself that names no heading fails"

# A web link is not checked: offline mode skips it rather than failing.
make_tree "[web](https://example.invalid/missing)"
expect pass "web links are skipped"
