#!/usr/bin/env bash
# Auto-merge open agent/* and dependabot/* PRs whose CI passed on the PR's head commit.
# CI red → leave open. Conflict → close PR and send the issue back to the agent (label `ready`).
# Merges made with GITHUB_TOKEN don't trigger push workflows, so deploys are dispatched explicitly.
set -uo pipefail
WAIT="${1:-0}"   # seconds to wait for pending CI
MERGED=0
ci_state() {  # success | failure | pending
  gh api "repos/$GITHUB_REPOSITORY/commits/$1/check-runs?per_page=100" --jq '
    [.check_runs[] | select(.name=="build" or .name=="test")] as $c
    | if ($c|length)==0 then "pending"
      elif any($c[]; .conclusion=="success") then "success"
      elif any($c[]; .conclusion=="failure") and all($c[]; .status=="completed") then "failure"
      else "pending" end'
}
for PR in $(gh pr list --state open --json number,headRefName --jq '.[] | select(.headRefName|startswith("agent/") or startswith("dependabot/")) | .number'); do
  read -r SHA BRANCH <<<"$(gh pr view "$PR" --json headRefOid,headRefName --jq '"\(.headRefOid) \(.headRefName)"')"
  ISSUE=""; case "$BRANCH" in agent/issue-*) ISSUE="${BRANCH#agent/issue-}";; esac
  STATE=$(ci_state "$SHA"); T=0
  while [ "$STATE" = pending ] && [ "$T" -lt "$WAIT" ]; do sleep 30; T=$((T+30)); STATE=$(ci_state "$SHA"); done
  MERGEABLE=$(gh pr view "$PR" --json mergeable --jq .mergeable)
  if [ "$MERGEABLE" = CONFLICTING ] && [ -z "$ISSUE" ]; then
    gh pr comment "$PR" -b "@dependabot rebase" >/dev/null 2>&1; echo "↻ PR #$PR (dependabot) conflicted; asked to rebase"; continue
  fi
  if [ "$MERGEABLE" = CONFLICTING ]; then
    gh pr close "$PR" --delete-branch -c "Conflicts with main — sending #$ISSUE back to the agent to redo on current code."
    gh issue edit "$ISSUE" --remove-label review --remove-label in-progress --add-label ready || true
    echo "↻ PR #$PR conflicted; issue #$ISSUE re-queued"; continue
  fi
  case "$STATE" in
    success) gh pr merge "$PR" --squash --delete-branch && echo "✓ merged PR #$PR" && MERGED=1 && [ -n "$ISSUE" ] && gh issue close "$ISSUE" -c "Done in #$PR (auto-merged)." >/dev/null 2>&1 ;;
    failure) [ -n "$ISSUE" ] && gh issue edit "$ISSUE" --add-label needs-human >/dev/null 2>&1 || true
             gh pr comment "$PR" -b "CI failed — not auto-merging. Needs a human look." >/dev/null 2>&1 || true
             echo "✗ PR #$PR CI failed" ;;
    *) echo "… PR #$PR CI still pending; will retry next run" ;;
  esac
done
if [ "$MERGED" = 1 ]; then
  for w in ci.yml codeql.yml deploy.yml docker.yml play-store.yml; do
    [ -f ".github/workflows/$w" ] && gh workflow run "$w" --ref main >/dev/null 2>&1 && echo "▶ dispatched $w on main" || true
  done
fi
exit 0
