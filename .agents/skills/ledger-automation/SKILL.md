---
name: ledger-automation
description: Execute Brainstrike's Ledger migration-registration parity automation from `.night-shift/charters/ledger.md`. Use when running, dry-running, debugging, or maintaining the Ledger loop; auditing numbered database migrations across the test and production runners; checking DB test-lane, factory-reset, or runtime-baseline implications; or preparing Ledger-only registration parity PRs and checkpoints.
---

# Ledger Automation

Keep the live charter and contracts authoritative. This skill makes mechanical evidence repeatable; it does not decide SQL semantics or replace the required human review.

## Establish authority and state

1. Work from the Brainstrike repository root. Read `AGENTS.md`, `.night-shift/PROTOCOL.md`, `.night-shift/charters/ledger.md`, and every top-level `.night-shift/*.md` file completely.
2. Read `docs/agents/database.md` completely before inspecting a migration. If a changed migration creates a table, read the applicable factory-reset rules in `docs/agents/platform-contracts.md` before classifying it.
3. Resolve automation memory when an Automation ID is present. Treat it as an execution aid, never as authority over the repository, GitHub, or Linear.
4. Record the UTC start time and charter budget. Fetch `origin/main`, then resolve an open `night-shift/ledger/*` PR, the current repository state, and the exact Linear state issue/checkpoint in the protocol's trust order.
5. Require a proven main-SHA watermark. On a first run, establish the eligible range by inspecting the history that introduced the live Ledger charter; never substitute the current branch, a date, or automation memory. Create a missing state issue only as the live protocol requires.
6. Resume Ledger's one open PR before creating work. Stop and surface a protocol violation if more than one exists.

Resolve conflicts in this order: repository instructions and architecture contracts, protocol, Ledger charter, then this skill.

## Collect mechanical evidence

Run the bundled read-only collector against the fetched main revision:

```bash
node .agents/skills/ledger-automation/scripts/collect-ledger-evidence.mjs \
  --repo /absolute/path/to/brainstrike \
  --watermark <trusted-main-sha> \
  --revision origin/main \
  --pretty > /tmp/ledger-evidence.json
```

The collector fails closed on unreadable revisions, an unproven watermark, unparseable runner ledgers, or incomplete test-lane assignment. It performs no network or repository writes.

Treat its output as evidence, not permission:

- `mechanicalGaps` identifies missing numbered-runner or Drizzle `customMigrations` registration and broken ordering.
- `semanticReviewCandidates` identifies exact migration statements that require the charter's human route; inspect the full changed migration and diff before filing or editing.
- `factoryResetReview` and `runtimeBaselineReview` name affected tables/DDL and source references but never assert that a reset or baseline change is required.
- `testLaneAssignments` mechanically checks every newly added DB test against the live manifest regexes. Confirm whether a changed test is actually part of the migration change.

If `noMigrationDelta` is true, separately prove no Ledger-owned open PR or reopened ticket requires continuation, then take the protocol's NOOP path. Do not run unrelated expensive checks to manufacture activity.

## Classify before editing

Never author, alter, reorder, or renumber migration bodies. Do not resolve a semantic candidate with a registration-only edit.

For any divergent SQL, ordering anomaly, catalog upsert involving `ON CONFLICT`, or destructive statement, search Linear by the protocol fingerprint before writing. Update an open match or create the deduplicated `needs-human` ticket with the exact diff, then checkpoint BLOCKED as required. Factory-reset omissions belong to Axiom: route them rather than editing reset code.

Only a confirmed missing registration line is Ledger work. Before editing, add or extend a focused regression test that starts from a fresh DB and demonstrates equivalent schema through both runners. Change only the import/ledger registration and that test. Keep the one PR title, branch, scope, and learning rules from the live charter.

## Verify, checkpoint, and finish

For a Ledger change, run these in one final command sequence from `packages/db`:

```bash
node scripts/test-lanes.mjs check
node scripts/coverage-lanes.mjs check
pnpm test
```

Re-fetch `origin/main` before a remote write. If it moved, re-collect the delta and re-evaluate the classification. Never merge, deploy, migrate a live schema, or touch live data.

Append exactly one protocol-shaped checkpoint using the fully swept `origin/main` SHA. Never edit prior comments. Update automation memory with UTC time, watermark, result, evidence, validation, remote identifiers, and exact next action. Re-read every external write, then verify the worktree, PR set, checkpoint, and memory agree. Report NOOP as success.
