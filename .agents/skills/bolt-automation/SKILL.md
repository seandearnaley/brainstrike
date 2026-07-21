---
name: bolt-automation
description: Execute Brainstrike's Bolt night-shift performance-maintainer loop from `.night-shift/charters/bolt.md`. Use for scheduled or manual Bolt runs, MAIN-DIFF watermark reconciliation, open Bolt PR continuation, measurable local-first performance discovery, red-green benchmark work, exact-head correctness and performance reviews, PR stabilization, readiness audits, and append-only Linear checkpoints.
---

# Bolt Automation

Execute the repository-owned Bolt charter without duplicating its policy. Use the bundled scripts for deterministic read-only collection and readiness checks; retain human judgment for candidate selection, mechanism analysis, benchmarks, and risk.

## Establish authority and state

1. Resolve the Brainstrike repository root and read `AGENTS.md` plus any more-specific instructions.
2. Read `.night-shift/PROTOCOL.md`, `.night-shift/charters/bolt.md`, every top-level `.night-shift/*.md` learning file, and every document the live charter requires.
3. Read the architecture contract for each subsystem before changing it. Resolve conflicts in this order: repository instructions and contracts, protocol, Bolt charter, this skill.
4. Note the UTC start time and live wall-clock budget.
5. Read automation memory when an Automation ID is present. Treat it as an execution aid, never as authority over GitHub, repository HEAD, or Linear state.
6. Resolve state in protocol trust order: the single open `night-shift/bolt/*` PR, repository HEAD, the exact Linear state issue and latest append-only checkpoint, then nothing.
7. Fetch `origin/main`. Require an exact checkpoint watermark; never guess or substitute a merge base. On first-ever setup, establish the baseline explicitly from current repository evidence and checkpoint it.

Resolve the latest checkpoint by listing all comments on the exact state issue and selecting the newest comment that matches the protocol's checkpoint shape. Ignore newer discussion notes that are not checkpoints. Fail visibly when pagination, issue identity, or an exact watermark cannot be proven.

For an explicit dry-run that forbids Git-ref writes, do not fetch. Run the collector against the existing `origin/main`; its `ls-remote` comparison proves freshness without updating refs and fails with `fetch required` when local state is stale.

Resume an open Bolt PR before new discovery. Stop and surface a protocol violation if more than one is open.

## Collect read-only evidence

After fetching and resolving the watermark, run:

```bash
node .agents/skills/bolt-automation/scripts/collect-bolt-evidence.mjs \
  --repo /absolute/path/to/brainstrike \
  --watermark "$watermark" \
  --pretty
```

The collector performs no repository or external writes. It:

- validates repository identity, live charter assignments, and watermark ancestry;
- compares local `origin/main` with `git ls-remote` and fails when a fetch is required;
- inventories the first-parent delta, exact `origin/main` blob IDs, open Bolt PRs, learning files, and worktree state;
- groups changed paths into advisory evidence leads derived from the live charter's performance surfaces;
- fails visibly on missing state, malformed output, GitHub failure, or multiple open Bolt PRs.

Treat `evidenceLeads` as routing hints, never findings. Read the full diff, relevant source, tests, benchmarks, and contracts. When the delta is empty, no Bolt PR is open, and no reopened Bolt ticket requires work, append a NOOP checkpoint and stop before expensive profiling.

## Select one measurable candidate

Apply the live evidence gate. Require a stable fixture, an understood mechanism, improvement above measured noise or an exact avoidable operation count, proof that the runtime does not already remove the work, and a small local patch with no degraded behavior.

Prefer critical local-first paths and reject round-trip dependencies. Search Linear for the stable fingerprint before filing or updating anything. Record rejected candidates with exact file hashes as required by the charter. Route valuable architecture-sized work to a deduplicated backlog ticket; do not force it into Bolt authority.

NOOP is success. Select at most one candidate.

## Implement evidence-red and evidence-green

1. Create or resume the charter-compliant branch and isolated worktree.
2. Add a benchmark, exact operation-count assertion, or characterization test that fails or exposes the old work.
3. Implement the smallest coherent optimization without changing public APIs, dependencies, schemas, or architecture boundaries.
4. Run focused tests and repeat the proof enough to report samples, variance, environment, and uncertainty. Preserve an exact runnable command, fixture parameters, warmup/sample counts, checksum, Node/OS/architecture, and raw range or dispersion in the PR body. If the command depends on a temporary script, include its complete source in the PR body or commit a narrow harness; never rely on an untracked script that a later wake cannot reproduce.
5. Run `pnpm lint && pnpm type-check && pnpm build && pnpm test` together on the final code state. Use proportional native, browser, or E2E proof when the affected path requires it.
6. Update `.night-shift/bolt.md` only with a durable, codebase-specific learning established by the same PR.

Never weaken thresholds, add retries, use CI as the first test runner, or claim improvement from a single noisy sample.

Use this PR-body evidence shape so a later wake can reproduce it exactly:

```text
Evidence method
Command: <complete copy-paste runnable command or committed harness path>
Fixture: <inputs, scale, and checksum or exact operation count>
Environment: <Node/runtime version, OS, architecture, relevant flags>
Sampling: <warmups, measured samples, ordering, isolation controls>
Before: <median plus range or dispersion>
After: <median plus range or dispersion>
Uncertainty: <remaining noise or limitation>
```

## Stabilize one PR

Use `$brainstrike-pr-loop` for GitHub review, watcher, CI, reply, resolution, and superseded-run handling. Follow the Bolt charter's title, body, fix-cycle, and one-PR limits.

For every pushed HEAD:

1. Start or restart the one foreground watcher immediately and poll its session once.
2. Read both unresolved review threads and flat comments before waiting on CI.
3. Spawn two fresh read-only reviewers over the full exact-head diff: one correctness reviewer and one performance verifier challenging mechanism, benchmark method, noise, and memory/operation claims.
4. Batch valid fixes into one red-green push. Re-run both reviewers only after the HEAD changes.
5. Reply to every actionable review item and resolve only after verifying the fix on the current head.

Never merge or enable auto-merge.

## Audit mechanical readiness

After local proof, reviews, and remote checks appear complete, fetch `origin/main` and run:

```bash
node .agents/skills/bolt-automation/scripts/audit-bolt-readiness.mjs \
  --repo /absolute/path/to/brainstrike-worktree \
  --pr <number> \
  --head <full-head-sha> \
  --pretty
```

The audit is deliberately stricter than GitHub's merge button: it requires the exact local/remote head, current base, clean tree, open non-draft PR, mergeable clean state, at least one observed check with every observed check terminal-green, and zero unresolved review threads. Both helpers disable Git optional locks, fsmonitor, and untracked-cache writes; they perform no repository or external writes.

`mechanicalReady=true` is necessary, not sufficient. Declare READY TO MERGE only when the exact same SHA also has passing evidence and two clean fresh reviewers.

On a later wake with the same PR HEAD, reuse evidence and reviewer status only when a valid append-only Bolt checkpoint names that exact head and explicitly records `evidence=pass`, `reviewers=correctness+performance-clean`, and `threads=0`; the PR must still contain the exact reproducible evidence method. Re-read all PR discussion since that checkpoint. Any head drift, base drift, new actionable discussion, missing field, irreproducible method, or ambiguous checkpoint invalidates reuse and requires fresh verification. Never reconstruct a missing benchmark method by guesswork.

## Checkpoint and finish

Append exactly one Linear checkpoint in the live protocol format using the fully swept `origin/main` watermark. Never edit the state description or earlier comments. For READY state, record PR number, exact head, fingerprint, `evidence=pass`, `reviewers=correctness+performance-clean`, `checks=green`, and `threads=0` on the same checkpoint line. Use explicit failure or pending values for incomplete work; never omit a field and imply success.

Update automation memory with UTC timing, watermark, decision, stable remote identifiers, evidence, validation, and next action. Report files changed, nearby files intentionally untouched, follow-ups, and any partial external writes. Do not merge.
