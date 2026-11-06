#!/usr/bin/env bash
# Fail unless the tagpr release PR's title and CHANGELOG heading carry the
# version its labels select (see release-pr-version.sh), and record the result
# as the commit status `release-version` on the PR's current head: a job result
# would sit on the commit of the event, not on the commit tagpr just pushed.
#
#   check-release-pr.sh <pr-number>           check, and set success or failure
#   check-release-pr.sh <pr-number> pending   only mark the head pending
#
# GH_TOKEN and GH_REPO set; run in a clone with tags. Only a completed check of
# the PR as it is now sets success: the head is marked pending first, and any
# error on the way sets failure, so an earlier success never outlives a change.
set -euo pipefail

pr_number=${1:?usage: check-release-pr.sh <pr-number> [pending]}
mode=${2:-check}

status() {
  gh api "repos/$GH_REPO/statuses/$1" -f state="$2" -f context=release-version \
    -f description="$3" >/dev/null
}

# Read the PR live: an event payload can be older than tagpr's update.
pr=$(gh pr view "$pr_number" --json title,labels,headRefName,headRefOid)
sha=$(jq -r .headRefOid <<<"$pr")
status "$sha" pending "Checking the release version"
[[ $mode == pending ]] && exit 0
trap 'status "$sha" failure "The check could not run; rerun it"' ERR

title=$(jq -r .title <<<"$pr")
mapfile -t labels < <(jq -r '.labels[].name' <<<"$pr")
head=$(jq -r .headRefName <<<"$pr")
latest=$(git tag -l 'v[0-9]*.[0-9]*.[0-9]*' --sort=-v:refname | head -n 1)
want=$(bash "$(dirname "$0")/release-pr-version.sh" "$latest" "${labels[@]}")
heading=$(gh api -H 'Accept: application/vnd.github.raw' \
  "repos/$GH_REPO/contents/CHANGELOG.md?ref=$sha" |
  sed -n 's/^## \[\(v[^]]*\)\].*/\1/p' | head -n 1)

ok=1
if [[ $title != "Release for v$want" ]]; then
  echo "::error::PR title is '$title', expected 'Release for v$want' (latest tag $latest, labels: ${labels[*]})"
  ok=0
fi
if [[ $heading != "v$want" ]]; then
  echo "::error::CHANGELOG.md's first heading is '$heading', expected 'v$want' (on $head)"
  ok=0
fi
trap - ERR
if [[ $ok == 1 ]]; then
  status "$sha" success "v$want matches the labels"
  exit 0
fi
echo "::error::The release PR is stale. Rerun the tagpr workflow (or change a tagpr:* label), then rerun this check."
status "$sha" failure "Stale: expected v$want; rerun tagpr"
exit 1
