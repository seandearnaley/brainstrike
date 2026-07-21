#!/usr/bin/env bash
set -euo pipefail

if [[ $# -lt 3 || $# -gt 4 ]]; then
  echo "usage: $0 <owner> <repo> <pr-number> [interval-seconds]" >&2
  exit 1
fi

owner="$1"
repo="$2"
pr_number="$3"
interval="${4:-60}"

while true; do
  printf '\n=== %s ===\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
  gh pr checks "$pr_number" --repo "$owner/$repo" || true
  gh api graphql \
    -f query='query($owner:String!, $repo:String!, $number:Int!) { repository(owner:$owner, name:$repo) { pullRequest(number:$number) { headRefOid reviewThreads(first:100) { nodes { isResolved } } } } }' \
    -F owner="$owner" \
    -F repo="$repo" \
    -F number="$pr_number" \
    --jq '"head=" + .data.repository.pullRequest.headRefOid + " unresolved_threads=" + (([.data.repository.pullRequest.reviewThreads.nodes[] | select(.isResolved==false)] | length) | tostring)' || true
  sleep "$interval"
done
