---
name: axiom-automation
description: Execute Brainstrike's Axiom invariant-maintainer automation from `.night-shift/charters/axiom.md`. Use for scheduled or manual Axiom runs, MAIN-DIFF watermark checks, documented-but-unscripted invariant discovery, guard-script and control-test creation, unsafe-fix escalation, Axiom PR continuation, append-only Linear checkpoints, or debugging and maintaining the Axiom loop.
---

# Axiom Automation

Execute the repository-owned Axiom charter with deterministic read-only discovery and explicit semantic review. Keep live repository policy authoritative; never copy its invariant list into this skill.

## Establish authority and state

1. Resolve the Brainstrike repository root and read `AGENTS.md` plus applicable nested instructions.
2. Read `.night-shift/PROTOCOL.md`, `.night-shift/charters/axiom.md`, `.night-shift/charters/README.md`, and every `.night-shift/*.md` file completely.
3. Read the architecture contract for every subsystem inspected or changed. Never infer an invariant from a filename or an old run.
4. Resolve conflicts in this order: repository instructions and architecture contracts, protocol, Axiom charter, this skill.
5. Read automation memory when an Automation ID is present. Use it only as an execution aid; verify every mutable fact against GitHub, the repository, and Linear.
6. Note the UTC start time and the live charter's wall-clock budget. Fetch `origin/main` before deriving the work range.
7. Resolve state in protocol trust order: open Axiom PRs, repository HEAD, the exact Linear state issue and latest append-only checkpoint, then nothing.

Resume the single open Axiom PR before starting a new sweep. Verify its exact head, base, diff, unresolved review threads, and required checks; address only work belonging to its existing fingerprint. Do not absorb a newly queued main delta while that PR remains open. Stop and surface a protocol violation if more than one exists. Require an exact, trusted MAIN-DIFF watermark. For a first run, follow the live bootstrap/full-sweep rule; never invent a merge base, date-derived SHA, or silent substitute.

## Collect deterministic evidence

Run one of these commands from the Brainstrike repository root:

```bash
node .agents/skills/axiom-automation/scripts/collect-axiom-evidence.mjs \
  --repo /absolute/path/to/brainstrike \
  --watermark "$watermark" \
  --pretty
```

Use `--full-sweep` instead of `--watermark` only when the live first-run rule explicitly requires it.

The collector performs no repository, GitHub, or Linear writes. It:

- validates the repository, required live sources, Axiom identity, watermark ancestry, and GitHub read access;
- reads discovery inputs from the exact fetched `origin/main` tree, never from a possibly dirty checkout;
- extracts current uppercase `MUST` and `NEVER` statements with source lines from `AGENTS.md` and `docs/agents/*.md`;
- inventories repository scripts, guard-shaped candidates, paired guard tests, and root package-script wiring from that same tree;
- records the exact `watermark..origin/main` file and first-parent commit set, or the explicit full-sweep file set;
- lists open Axiom PRs and reports a protocol violation when more than one exists.

Exit `0` means collection succeeded. Exit `2` means evidence was emitted but a protocol violation requires a stop. Any other nonzero exit is a fail-closed collection error.

Treat the collector as an evidence index, not an invariant classifier. Read the cited contracts and relevant scripts yourself. A lexical statement without semantic analysis is not a finding, and a guard-shaped filename is not proof of coverage.

## Derive and sweep live invariants

1. Compare every current invariant statement with the actual behavior of scripts and its `lint:ci` or `test:scripts` wiring.
2. Verify every seed expectation in the live charter still exists before using it. Add no remembered seed to this skill or collector.
3. Identify documented invariants that lack an effective, runnable detector. Reject duplicates, obsolete rulings, examples, and already-covered behavior.
4. Inspect only the collector's eligible main-diff files for the sweep. For each uncovered invariant, derive a targeted grep, AST query, or focused code inspection appropriate to that invariant.
5. Require the live charter's three-part evidence gate: exact contract citation, exact violating code, and concrete eventual user failure.
6. Rank real findings by user-facing risk and select at most one. Treat NOOP as success. Follow the charter's multi-violation refactor gate exactly.

For a dry-run, audit, or collector-maintenance request, stop before GitHub, Linear, branch, or repository writes and report the evidence and proposed next action.

## Implement one permanent guard

Before writing, derive the stable fingerprint and search Linear verbatim. Update an open twin; reopen a closed twin only when the relevant code hash changed.

Use a fresh protocol-named branch or the existing Axiom PR branch. Preserve unrelated work. Then follow the live charter:

1. RED: add a repository guard under `scripts/` and a paired `scripts/__tests__/*.test.mjs` with a deliberately bad control. Prove the guard fails for the current violation.
2. GREEN: make the smallest safe fix and prove the guard passes without weakening assertions, thresholds, or existing checks.
3. For factory-reset deletion, migration-runner, or data-loss-adjacent work, do not apply the unsafe fix. Add an exact, documented temporary allowlist and create or update the required `needs-human` Linear ticket.
4. Wire the detector into the live root `lint:ci` or `test:scripts` path as appropriate.
5. Add one consolidated, codebase-specific learning to Axiom's live learning file in the same PR. Add a bulletin only when the live cross-loop rule is met.

Never merge, enable auto-merge, deploy, migrate, touch live data, add a retry to force green, or open a second Axiom PR.

## Verify, publish, and checkpoint

Run `pnpm lint:ci && pnpm test:scripts` plus the touched package's build, type-check, and tests together after the final change. Also satisfy the repository-wide final verification rule in `AGENTS.md`. CI confirms local proof; it is not the first test runner.

Before publishing, verify the final diff, violating commit, detector logic, control-case RED/GREEN evidence, learning, and exact gates. Use the live charter's branch and PR title requirements. Do not add GitHub labels outside the protocol's allowed namespace.

After every external write, re-read the resulting remote object. Append exactly one checkpoint comment using the fully swept `origin/main` SHA; never edit the state description or prior comments. Finally verify the open-PR set, PR head, checkpoint, clean worktree, and automation memory agree.

Record the UTC completion time, outcome, watermark, stable remote identifiers, validation, and exact next action in automation memory when an Automation ID is present. Report files changed, nearby files intentionally untouched, follow-ups, and every pending or partial remote state.
