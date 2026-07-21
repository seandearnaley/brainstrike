---
name: brainstrike-pr-loop
description: Drive a Brainstrike pull request from open to mergeable with disciplined GitHub review, CI, and follow-up loops. Use when working on a Brainstrike PR, addressing GitHub review threads, fixing failing GitHub Actions, monitoring pipelines after each push, canceling superseded runs, batching safe fixes to reduce CI churn, deciding merge-vs-follow-up, or creating follow-up tickets for out-of-scope hardening.
---

# Brainstrike PR Loop

## Overview

Use this skill to run a Brainstrike PR through review comments, CI, and merge-or-follow-up decisions without thrashing GitHub Actions or drowning in review noise.

Invoke it explicitly with `$brainstrike-pr-loop` when the task is about an open PR, repeated pushes, CI failures, review comments, merge readiness, or follow-up split decisions.

This skill is optimized for Brainstrike's actual operating conditions:

- fast bot reviews
- expensive GitHub Actions runs
- long tail review noise
- repo-specific requirement that full root gates pass before push

Use helper skills only when they materially narrow the task:

- `$gh-address-comments` for comment triage and responses
- `$gh-fix-ci` for failing GitHub Actions diagnosis
- `$linear` when remaining work should become explicit follow-up tickets

## Core Model

There are always two loops:

1. Review/comment loop
2. Pipeline/check loop

They run at different speeds and must be handled differently.

### Review/comment loop

This loop is fast. New bot comments and review threads usually arrive before the expensive workflows finish.

This loop answers:

- What new unresolved review threads exist?
- What new flat PR issue comments or bot summaries exist?
- Which ones are stale or already covered by the current head?
- Which comments are real and cheap enough to fix now?
- Which comments are valid but should be moved to a follow-up PR or ticket?

### Pipeline/check loop

This loop is slow and expensive. Every push can restart 15-30+ minutes of work.

This loop answers:

- Which workflow run belongs to the latest head SHA?
- Which runs are superseded and should be canceled?
- Which failure is real on the newest head?
- Is the current PR actually mergeable?

## Working Rules

- Never analyze an old failing run until you verify it belongs to the latest head SHA.
- Read review comments before waiting on CI, because every push restarts the expensive pipeline.
- Read both unresolved review threads and flat PR issue comments before waiting on CI.
- Treat GitHub comment hygiene as required work, not optional cleanup. A fix is not operationally complete until the relevant PR comments and review threads have been replied to and, where appropriate, resolved.
- Keep exactly one long-lived watcher alive with `sleep`; do not spam many polling commands.
- After every push, start or restart the watcher in the same turn before you do anything else. Do not wait for another user message to begin monitoring.
- A watcher only counts if it is a live long-running process that contains `sleep` and will keep polling on its own. Running a one-shot command or printing one check result is not a watcher.
- Record the watcher `session_id` immediately and reuse it with polling calls. If you cannot point to the active watcher session, assume no watcher exists.
- After starting the watcher, poll it at least once in the same turn to prove it is still alive. Do not tell the user “watching” before you have confirmed that.
- Do not stop at “push succeeded.” Pushing is the midpoint, not the finish line.
- Keep monitoring until the latest head is either mergeable or explicitly deferred into follow-up work.
- Keep one scratchpad with:
  - latest pushed SHA
  - current active `Test` run id
  - current active review run id
  - unresolved thread ids grouped by category
- Cancel superseded runs immediately after every newer push.
- Use red/green TDD for each real issue:
  - write or tighten a regression test first
  - implement the fix
  - run targeted tests
  - then run full root gates before push
- For Brainstrike, full local validation means:

```bash
pnpm lint && pnpm type-check && pnpm build && pnpm test
```

- Do not claim the PR is ready unless the latest pushed SHA is green and the local root gates passed on the same logical code state.

## Workflow

## Step 1: Identify the current control surface

Gather the minimum state first:

```bash
gh pr view <pr-number> --json number,title,headRefName,headRefOid,url
gh pr checks <pr-number>
gh run list --branch <branch> --limit 20 --json databaseId,workflowName,headSha,status,conclusion,url
```

You need:

- PR number
- current branch
- latest head SHA
- active run ids for that SHA

If multiple runs are still alive for older SHAs, mark them for cancellation.

## Step 2: Start the watcher immediately

This is mandatory after every push. Start it in the same turn as the push and keep it running without waiting for another prompt:

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

This is the preferred form. It makes the monitoring mechanism explicit and visibly blocks in the foreground with `sleep`.

Operationally, this means:

- launch the raw `while true; do ... sleep 60; done` loop as the foreground monitoring task
- capture the returned `session_id`
- poll that same session at least once before reporting status
- continue reusing that same session instead of spawning new watchers

Do not satisfy this step with a helper wrapper if the user asked for explicit foreground monitoring. The literal `while ... sleep ...` loop is the contract in that case.

One watcher is enough. More than one creates noise and burns exec slots.

Operational rule:

- If you pushed code, you must leave this step with an active watcher.
- “Active watcher” means a visibly blocking foreground loop that is still running after launch, not just a command that was invoked once.
- If a previous watcher is stale or tied to an older PR/head, replace it rather than starting a second one.
- If the user comes back later asking why nothing happened, you failed this step.

## Step 3: Read review threads before touching CI logs

Use unresolved review threads, not just flat comments:

```bash
.agents/skills/brainstrike-pr-loop/scripts/review-threads.py seandearnaley brainstrike <pr-number>
```

Or use raw GraphQL if you need more detail.

Then read the latest flat PR issue comments as well:

```bash
gh api repos/seandearnaley/brainstrike/issues/<pr-number>/comments --paginate \
  | jq '[.[] | {user:.user.login, created_at, url, body}] | reverse[:20]'
```

Review threads and flat comments serve different purposes:

- review threads are the authoritative source for unresolved inline review state
- flat issue comments often contain bot summaries, codecov guidance, and follow-up requests that are not represented as unresolved threads

You must read both before deciding whether to push again.

Immediately classify each thread:

- `covered`
- `fix-now`
- `follow-up`
- `out-of-scope`

### Covered

Verify against the current file and current head SHA, then resolve the thread.
If a flat PR comment raised the issue and the new head covers it, leave a short reply summarizing the fix and the commit or file path when that will reduce future review churn.

### Fix-now

Only fix if it is:

- clearly correct
- cheap enough to justify another push
- within the PR's current scope

Batch multiple `fix-now` items into one push.

### Follow-up

Use when the comment is valid but would widen scope substantially:

- security hardening
- artifact integrity redesign
- proxy/cache policy redesign
- major product or architecture expansion

Create a Linear ticket or a follow-up PR instead of bloating the current branch.

### Out-of-scope or stale

Resolve or reply once you have verified the current head already supersedes the concern.

## Step 3.5: Reply and resolve explicitly

This step is mandatory. Do not stop at implementing the fix. Clean up the GitHub surface:

- Reply on flat PR comments when:
  - a bot or reviewer raised a concrete issue that has now been fixed
  - you are intentionally deferring a valid concern to a follow-up ticket
  - the comment is otherwise likely to trigger repeat review noise
- Reply on review threads when:
  - the fix is now present on the current head SHA
  - you are explicitly deferring the concern
  - the thread is stale and you are closing the loop with evidence
- Resolve review threads in GitHub only after you have verified the fix is on the current head SHA.
- Do not resolve threads speculatively or “because it should be fixed.”
- Do not leave addressed review items silent. If you acted on a review comment, leave a reply that says what changed and where.

Use short factual replies. Prefer:

- what changed
- where it changed
- whether a follow-up ticket was created

Avoid long narratives in PR comments.

## Step 4: Use red/green TDD for every real issue

For each real comment or CI failure:

1. Add or tighten a regression test first.
2. Make it fail for the reported behavior.
3. Implement the fix.
4. Run the smallest affected test surface.
5. When the batch is complete, run full root gates:

```bash
pnpm lint && pnpm type-check && pnpm build && pnpm test
```

Do not push speculative fixes without a concrete failing test or a concrete failing CI log tied to the latest head SHA.

## Step 5: Push deliberately and prune CI immediately

After a validated batch:

1. commit
2. push
3. immediately start or restart the watcher loop for the new head SHA
4. identify the newest run for the new head SHA
5. cancel superseded in-progress or pending runs for older SHAs

Use:

```bash
gh run cancel <run-id>
```

Do not leave expensive superseded runs alive.

Do not send a “done”, “pushed”, or “waiting on CI” update until steps 3-5 are actually complete.

## Step 6: Reconcile reviews after the push

After the new push:

- reply to any flat PR comments that are now addressed by the pushed head
- resolve threads that are now clearly covered
- reclassify any remaining threads
- only then go deeper into failing CI logs for the latest head

This ordering is strict:

1. clean up comment/review surface on the current head
2. then investigate remaining failing checks
3. then decide whether another push is justified

Do not burn a new pipeline run while stale review noise is still unresolved.

This ordering keeps review churn from forcing unnecessary extra pushes.

## Step 7: Decide merge now vs follow-up

Prefer merge now when:

- the core feature is correct and stable
- required checks are green
- remaining comments are mostly hardening or scope expansion
- the next changes would widen the PR more than stabilize it

Prefer keep iterating when:

- a required check is still failing on the latest head
- a review comment points to a real correctness bug in the shipped path
- the remaining fixes are small and cheap

If the PR is fundamentally good but only deeper hardening remains, merge and open a follow-up ticket or PR.

### Night Shift mode (mandatory override)

When this skill is invoked by a Night Shift loop (any `night-shift/*` branch, or any run governed by `.night-shift/PROTOCOL.md`), the protocol's PR-stewardship section overrides this step and parts of Step 3.5:

- You NEVER merge or enable auto-merge, no matter how clean the PR is. The terminal state is the protocol's `status=READY` checkpoint: required checks green, every thread replied AND resolved, working tree clean, all on the same HEAD. Then hand off to the human.
- EVERY review comment gets a reply — bots included, "covered" ones included. The reply is the fixing commit SHA, a concise reasoned decline, or a link to the follow-up Linear ticket. The "resolve silently when covered" shortcut in Step 3 does not apply.
- Deferrals go to a fingerprinted Linear ticket per the protocol's ticket rules, linked in the thread reply before resolving.
- The protocol's cap of six fix/push cycles per run applies; on hitting it, checkpoint `status=INCOMPLETE` with the exact next action instead of continuing.

Non-blocking check policy:

- Repo-owned GitHub checks and required status checks determine mergeability.
- Third-party informational checks (for example `codecov/project`) should not automatically trigger another push unless the user explicitly wants them green or the signal points to a real required regression.

## Brainstrike-Specific Constraints

Read [references/brainstrike-repo-contracts.md](references/brainstrike-repo-contracts.md) when you need repo-specific guardrails.

High-value reminders:

- AGENTS.md is authoritative.
- No silent degradation, no fallback stories, no hand waving.
- Verify fixes in code/tests before claiming them.
- Full root gates are expected before push.
- Be disciplined with exec sessions; one watcher plus one active validation job is the right pattern.

## Common Failure Patterns

These are the mistakes this skill is intended to prevent.

### 1. Push-and-disappear

Bad pattern:

- push the branch
- tell the user it is being monitored
- run a one-shot command or launch a watcher but never verify the session is still alive

Why this fails:

- the pipeline keeps running without supervision
- new review comments arrive and sit untouched
- the user comes back hours later to a stale PR

Correct pattern:

- push
- immediately start or restart the watcher in the same turn
- confirm the watcher session exists and is long-lived
- poll that same session once before reporting status
- only then report status

### 2. Reading checks but not comments

Bad pattern:

- stare at CI first
- ignore unresolved review threads or bot summaries
- push again for a CI failure while stale review noise is still open

Why this fails:

- review comments often describe the next cheap fix before CI finishes
- every extra push restarts expensive checks
- cognitive load increases because old and new concerns get interleaved

Correct pattern:

- read unresolved review threads
- read flat PR issue comments
- classify them
- only then decide whether another push is worth the CI cost

### 3. Treating every red check as equally important

Bad pattern:

- see one red status
- immediately respin the branch

Why this fails:

- some checks are informational or third-party only
- repo-owned required checks may already be green
- you can waste an entire run budget chasing non-blocking noise

Correct pattern:

- distinguish required repo-owned checks from informational third-party checks
- only respin for non-required checks when the user explicitly asks or the signal reveals a real regression

### 4. Resolving threads without a verified head

Bad pattern:

- assume a comment is fixed
- resolve the thread before checking the current file and current head SHA

Why this fails:

- review state becomes misleading
- later readers cannot trust resolved threads

Correct pattern:

- inspect the current file
- verify the current head actually contains the fix
- then resolve the thread or leave a short reply with the commit/file context

### 5. Mixing mergeable work with hardening follow-ups

Bad pattern:

- keep widening a basically-good PR because more hardening is imaginable

Why this fails:

- branch scope balloons
- CI churn grows
- reviewers lose confidence in what is actually being merged

Correct pattern:

- merge the stable branch once required checks are green and remaining comments are follow-up hardening
- create a Linear ticket or a new PR for the next batch

### 6. Spawning too many exec sessions

Bad pattern:

- multiple overlapping poll loops
- many one-off long-lived commands
- no reuse of existing watcher sessions

Why this fails:

- hits exec limits
- older useful sessions get pruned
- status becomes harder to reconstruct

Correct pattern:

- keep one watcher
- reuse existing sessions when polling
- avoid opening extra long-lived processes unless they replace the current watcher
- if you lose the watcher session id, treat that as a broken loop and start a fresh single watcher deliberately

## Recommended Resources

- [references/pr-review-ci-loop-playbook.md](references/pr-review-ci-loop-playbook.md)
- [references/agent-prompt.md](references/agent-prompt.md)
- [references/brainstrike-repo-contracts.md](references/brainstrike-repo-contracts.md)

Use the references progressively. Do not bulk-load everything unless the task actually needs it.

## Quick Start

If the user says something like:

- "monitor the pipeline after push"
- "address comments before checks"
- "cancel superseded runs"
- "take this PR to merge"
- "decide whether to split a follow-up"

then use `$brainstrike-pr-loop` and start here:

```bash
gh pr view <pr-number> --json number,title,headRefName,headRefOid,url
.agents/skills/brainstrike-pr-loop/scripts/watch-pr.sh seandearnaley brainstrike <pr-number> 60
.agents/skills/brainstrike-pr-loop/scripts/review-threads.py seandearnaley brainstrike <pr-number>
```
