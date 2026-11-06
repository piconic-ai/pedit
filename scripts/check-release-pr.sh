#!/usr/bin/env bash
# Fail unless the tagpr release PR's title and CHANGELOG heading carry the
# version its labels select (see release-pr-version.sh).
#
#   check-release-pr.sh <pr-number>    (GH_TOKEN and GH_REPO set, run in a clone with tags)
set -euo pipefail

pr_number=${1:?usage: check-release-pr.sh <pr-number>}
# Read the PR live: an event payload can be older than tagpr's update.
pr=$(gh pr view "$pr_number" --json title,labels,headRefName)
title=$(jq -r .title <<<"$pr")
mapfile -t labels < <(jq -r '.labels[].name' <<<"$pr")
head=$(jq -r .headRefName <<<"$pr")
latest=$(git tag -l 'v[0-9]*.[0-9]*.[0-9]*' --sort=-v:refname | head -n 1)
want=$(bash "$(dirname "$0")/release-pr-version.sh" "$latest" "${labels[@]}")
heading=$(gh api -H 'Accept: application/vnd.github.raw' \
  "repos/$GH_REPO/contents/CHANGELOG.md?ref=$head" |
  sed -n 's/^## \[\(v[^]]*\)\].*/\1/p' | head -n 1)

status=0
if [[ $title != "Release for v$want" ]]; then
  echo "::error::PR title is '$title', expected 'Release for v$want' (latest tag $latest, labels: ${labels[*]})"
  status=1
fi
if [[ $heading != "v$want" ]]; then
  echo "::error::CHANGELOG.md's first heading is '$heading', expected 'v$want'"
  status=1
fi
if [[ $status != 0 ]]; then
  echo "::error::The release PR is stale. Rerun the tagpr workflow (or change a tagpr:* label), then rerun this check."
fi
exit $status
