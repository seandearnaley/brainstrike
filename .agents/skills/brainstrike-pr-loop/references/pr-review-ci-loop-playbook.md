# PR Review / CI Loop Playbook

## Purpose

This guide explains how to run a GitHub PR iteration loop in Brainstrike with low thrash, low cognitive load, and minimal wasted CI time.

The operating reality in this repo is:

- PRs often get fast automated review comments.
- Full GitHub `Lint, Type Check & Unit Tests` can take roughly 30-35 minutes.
- Full E2E and cross-package workflows stretch wall-clock time further.
- A careless push cadence can burn overlapping CI runs and create a noisy review backlog.

The goal is not just "fix CI." The goal is to keep one coherent control loop running until the PR is either mergeable or intentionally split into a follow-up.

## The Two Loops

There are always two loops:

1. Review/comment loop
2. Pipeline/check loop

### Review/comment loop

This loop is fast. Comments and review threads often show up before the slow workflows finish.

Use it to answer:

- What new review threads appeared?
- Which threads are stale or already covered by the current head?
- Which comments are real and worth fixing now?
- Which comments are valid but better handled in a follow-up PR?

### Pipeline/check loop

This loop is slow and expensive.

Use it to answer:

- Which workflow run belongs to the latest head SHA?
- Which old runs are superseded and should be canceled?
- Which check failed on the newest head?
- Is the failure real, stale, or already fixed locally?

## Why Comments Come First

Comments should be handled before waiting on checks because every new push restarts the expensive pipeline.

The cheaper strategy is:

1. Read new review threads quickly.
2. Batch cheap and clearly correct fixes together.
3. Add tests for those fixes.
4. Run local validation.
5. Push once.
6. Let the pipeline rerun only after the review batch is incorporated.

## Operational Rhythm

1. After every push, identify the newest run for the current head SHA.
2. Cancel superseded in-progress or pending runs for older SHAs.
3. Start one long-lived polling loop with `sleep`.
4. While that loop runs, fetch unresolved review threads and classify them.
5. Fix only comments that are clearly correct, cheap enough to justify another push, and within current scope.
6. Before each push:
   - run targeted tests for changed files and packages
   - then run the full root gates from the repo root
7. After the push:
   - cancel superseded runs again
   - resolve threads that are now clearly covered
   - return to polling

## Common Waste Patterns

### Treating stale CI as current CI

Always map a failure back to the latest head SHA before fixing it.

### Not keeping one watcher alive

Start one watcher immediately after a push. Do not wait passively.

### Too many open exec sessions

The right pattern is:

- one watcher
- one active validation process
- a few short one-shot commands

### One push per comment

That burns CI. Classify comments into:

- already covered
- fix now
- follow-up hardening
- out of scope

Only the `fix now` group should usually trigger another push.

## Commands

### PR checks

```bash
gh pr checks <pr-number>
```

### Workflow runs by branch

```bash
gh run list --branch <branch> --limit 20 --json databaseId,workflowName,headSha,status,conclusion,url
```

### Failed job logs

```bash
gh run view <run-id> --job <job-id> --log-failed
```

### Review threads

```bash
gh api graphql -f query='
query($owner:String!, $repo:String!, $number:Int!) {
  repository(owner:$owner, name:$repo) {
    pullRequest(number:$number) {
      reviewThreads(first:100) {
        nodes {
          id
          isResolved
          comments(first:10) {
            nodes {
              body
              path
              outdated
              originalLine
            }
          }
        }
      }
    }
  }
}' -F owner='<owner>' -F repo='<repo>' -F number=<pr-number>
```

### Cancel superseded runs

```bash
gh run cancel <run-id>
```

## Suggested Watch Loop

```bash
while true; do
  printf '\n=== %s ===\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
  gh pr checks <pr-number> || true
  gh api graphql \
    -f query='query($owner:String!, $repo:String!, $number:Int!) { repository(owner:$owner, name:$repo) { pullRequest(number:$number) { reviewThreads(first:100) { nodes { isResolved } } } } }' \
    -F owner='<owner>' \
    -F repo='<repo>' \
    -F number=<pr-number> \
    --jq '[.data.repository.pullRequest.reviewThreads.nodes[] | select(.isResolved==false)] | length' || true
  sleep 60
done
```

## TDD Standard

For each real review comment or CI failure:

1. Write or tighten a regression test that fails for the reported issue.
2. Implement the fix.
3. Run the smallest affected test surface.
4. Once the batch is complete, run full root gates:

```bash
pnpm lint && pnpm type-check && pnpm build && pnpm test
```

## Merge Now vs Follow-Up

Prefer merge now when:

- the core feature works
- all required checks are green
- remaining comments are mostly hardening
- the next fixes would expand scope more than stabilize the change

Prefer keep iterating when:

- a required check is still failing
- a review comment points to a correctness bug
- the remaining fixes are small and cheap

## Follow-Up Candidates

Good follow-up material includes:

- security hardening needing auth/rate limiting/WAF design
- artifact integrity restoration or redesign
- proxy/cache policy redesign
- large cancellation/timeout semantics changes

## Merge Gate Checklist

- Current branch has no uncommitted changes.
- Latest pushed SHA is known.
- Required GitHub checks on that SHA are green.
- Superseded runs are canceled.
- Remaining unresolved review threads are either blocking right now or explicitly deferred.
- Local root gates passed on the same logical code state:

```bash
pnpm lint && pnpm type-check && pnpm build && pnpm test
```
