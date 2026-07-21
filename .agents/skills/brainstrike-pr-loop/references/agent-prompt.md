# Agent Prompt: Brainstrike PR Loop

Use this prompt when an agent is responsible for taking a Brainstrike PR from "open and noisy" to "mergeable or intentionally split."

## Prompt

You are responsible for driving this Brainstrike PR to a clean state without wasting CI time.

Rules:

1. Treat review comments and CI as two separate loops.
2. Read review comments before waiting on CI, because each push restarts the expensive pipeline.
3. After every push:
   - do not stop the turn after `git push`
   - immediately start a raw inline watcher loop with `while true; do ... sleep 60; done`
   - make sure it is a real visibly blocking foreground process, not a one-shot command and not an abstract helper the user cannot see
   - capture the watcher `session_id`
   - poll that same session at least once before saying you are monitoring
   - identify the newest run for the latest head SHA
   - cancel superseded in-progress or pending runs for older SHAs
   - keep exactly one poll loop running with `sleep`
4. Never analyze an old failing run until you verify it belongs to the latest head SHA.
5. Use red/green TDD for each real issue:
   - add or tighten a regression test first
   - implement the fix
   - run targeted tests
   - then run the full root gates before push:

```bash
pnpm lint && pnpm type-check && pnpm build && pnpm test
```

6. Classify unresolved review threads into:
   - already fixed or stale
   - fix now
   - follow-up hardening
   - out of scope
7. Resolve stale or covered threads only after verifying the current head really covers them.
8. Batch cheap, clearly correct fixes into a single push. Do not push one comment at a time.
9. Prefer merging the current PR and creating a follow-up PR or ticket when:
   - the core feature is stable
   - required checks are green
   - remaining comments are mostly hardening or scope expansion
10. Do not stop at push. Keep monitoring the pipeline and new review comments until the PR is either:
   - green and mergeable
   - or explicitly split into a follow-up
11. Resolve or reply to covered review comments on the current head before spending another push on CI cleanup.
12. A review item is not done until the GitHub surface is updated:
   - reply on the PR issue comment if one exists
   - reply on the review thread if one exists
   - resolve the review thread only after verifying the fix on the current head
13. Treat non-required third-party checks as non-blocking unless the user explicitly asks to chase them or they reveal a real required regression.

## Required Commands

### PR checks

```bash
gh pr checks <pr-number>
```

### Workflow runs

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

### Watcher loop

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

If the user explicitly asks for foreground monitoring, use this literal inline loop rather than a helper script.

## Working Style

- Keep one watcher alive instead of spawning many overlapping polling commands.
- If you pushed and there is no active watcher session yet, that is a process failure; start it immediately.
- A watcher is not valid unless it remains alive after launch, contains a real `sleep`, and you have verified that by polling the same session.
- Treat comment replies as first-class deliverables. Do not tell the user a review item is addressed if you have not replied on GitHub where that concern was raised.
- Keep a scratchpad with:
  - latest pushed SHA
  - active `Test` run id
  - active review run id
  - unresolved thread ids by category
- If a failing review item is not worth widening the current PR, split it into a follow-up instead of dragging the current PR deeper into churn.
