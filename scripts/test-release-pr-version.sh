#!/usr/bin/env bash
# Tests for release-pr-version.sh. Run from anywhere: bash scripts/test-release-pr-version.sh
set -uo pipefail
script="$(dirname "$0")/release-pr-version.sh"
fail=0

check() {
  local want=$1
  shift
  local got
  got=$(bash "$script" "$@" 2>&1)
  if [[ $got != "$want" ]]; then
    echo "FAIL: $* => '$got', want '$want'"
    fail=1
  fi
}

check 1.2.4 v1.2.3
check 1.2.4 v1.2.3 tagpr other
check 1.3.0 v1.2.3 tagpr:minor
check 1.3.0 v1.2.3 tagpr/minor
check 2.0.0 v1.2.3 tagpr:major
check 2.0.0 v1.2.3 tagpr/major
check 2.0.0 v1.2.3 tagpr:minor tagpr:major
check 2.0.0 v1.2.3 tagpr:major tagpr:minor
check 0.7.1 v0.7.0 tagpr
check 0.8.0 v0.7.0 tagpr:minor
check 1.0.0 v0.7.0 tagpr:major
check 0.1.10 v0.1.9
check "not a release tag: 1.2.3" 1.2.3

[[ $fail == 0 ]] && echo "ok"
exit $fail
