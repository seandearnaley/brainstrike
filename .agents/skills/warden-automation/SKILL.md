---
name: warden-automation
description: Execute Brainstrike's Warden guard-script meta-health automation from `.night-shift/charters/warden.md`. Use when running, dry-running, debugging, or maintaining the Warden loop; auditing root guard scripts for CI wiring, paired tests, and deliberate negative controls; regenerating the guard inventory; or checkpointing Warden findings in Linear.
---

# Warden Automation

Run Warden consistently while keeping the repository charter authoritative. Use the bundled collector for deterministic read-only discovery; retain human judgment for deciding which scripts are guards and whether a test is genuinely armed.

## Establish authority

1. Work from the Brainstrike repository root.
2. Read `AGENTS.md`, `.night-shift/PROTOCOL.md`, `.night-shift/charters/warden.md`, and every `.night-shift/*.md` file completely.
3. Read `docs/agents/ci-quality.md` before changing a guard, script test, package script, workflow, or inventory.
4. Resolve conflicts in this order: repository instructions and architecture docs, protocol, Warden charter, this skill.
5. Re-derive the charter version, state issue, fingerprint shape, repair cap, branch name, commands, and inventory every run. Never copy their current values into this skill.
6. Preserve unrelated work. Audit `origin/main` from a clean detached worktree when the active checkout is dirty or is not based on current main.

## Check live state first

1. Record the UTC wake time. For a live wake, fetch `origin/main`; for a dry-run, do not fetch and report remote currency as unproven.
2. Read open Warden PRs before repository state, then read Warden's Linear state issue and comments.
3. Apply the protocol's MAIN-DIFF watermark shortcut only when the prior watermark, open-PR state, and reopened-ticket state are all proven unchanged.
4. Fail visibly if GitHub authentication, repository identity, Linear access, main currency, or the state issue cannot be proven. Do not guess or silently degrade.

For a dry-run or audit request, perform only read operations and stop before GitHub, Linear, repository, or Git-ref writes.

## Collect deterministic evidence

Run:

```bash
node .agents/skills/warden-automation/scripts/collect-warden-evidence.mjs \
  --repo /absolute/path/to/brainstrike \
  --pretty > /tmp/warden-evidence.json
```

The collector performs no writes. It:

- derives Warden metadata from the live charter;
- inventories every root `scripts/*.mjs` and `scripts/*.cjs` file plus every `scripts/__tests__/*.test.mjs` file;
- traces CI workflow → root package-script → guard entry reachability separately from test-only reachability;
- reports direct and transitive test pairings, candidate negative-control test titles, package/workflow references, guard-like signals, git history, main identity, and dirty state;
- fails closed on missing required files, empty enumerations, malformed package metadata, or an unprovable repository root, and reports dirty/divergent checkout and missing-inventory blockers separately from successful evidence collection.

Treat `candidateHint` and `negativeControlCandidates` as routing evidence, never verdicts.

## Classify every script explicitly

Review every root script in the collector output. Assign exactly one disposition:

- `guard`: enforces a repository invariant by failing on a target defect;
- `support`: imported helper or execution plumbing that does not independently enforce an invariant;
- `operation`: performs maintenance, reporting, benchmarking, cleanup, or orchestration rather than guarding a rule.

Read the script whenever its disposition is not obvious from the evidence. Record a short exclusion reason for every non-guard. An ambiguous script is not silently excluded: mark classification unproven and BLOCKED.

For each guard, prove all three charter properties:

- `WIRED`: `wiring.ciReachable` is true from a non-test CI entry for the actual guard behavior, not merely from its paired test or an unrelated exported helper.
- `PAIRED`: a direct test under `scripts/__tests__` exercises the guard. A test elsewhere or a transitive helper-only import does not satisfy the charter unless the live charter says otherwise.
- `ARMED`: manually inspect at least one paired test whose fixture deliberately violates the protected invariant and assert that the guard detects it. A negative-sounding title is only a candidate.

Count failed properties, not just affected files. The executed-guard count is the number of classified guards with a paired test that actually invokes the protected behavior.

## Decide before acting

1. Before calling a guard ORPHANED, inspect the collector's history and the relevant commits. If recent history intentionally removed or replaced it, follow the charter's human-confirmation path instead of restoring it.
2. Search Linear for the live charter-derived fingerprint before creating or updating a finding.
3. If failed properties exceed the live repair cap, create or update one `needs-human` build-system ticket, append a BLOCKED checkpoint, and stop. Do not open a broad PR or write the inventory into an unrelated checkout.
4. If the run is within the cap, use the one-PR repair path from the charter. Create a dedicated clean worktree and branch; never reuse another loop's branch.

## Repair with red-green proof

Keep repairs mechanical and scoped to Warden's authority:

1. Add the failing paired test or negative control first and run it red.
2. Restore only the missing wiring or guard behavior needed to make it green.
3. Never weaken an assertion, threshold, timeout, or protected surface; never add a retry to make CI pass.
4. Regenerate `scripts/_guard-inventory.md` from the final classified set in deterministic name order, one line per guard: name → wired/paired/armed → protection.
5. Add a Warden learning only when the same PR establishes durable repository-specific knowledge.
6. Add a bulletin line only when a guard went dark in the same change window as its subsystem, naming Axiom and Scribe as required by the live charter.

## Verify and checkpoint

On a clean final tree, run the live charter's verification plus the repository-required coding gates. At minimum, prove `pnpm test:scripts` is green and the executed-guard count equals the final inventory. For a coding PR, also satisfy the current `AGENTS.md` clean-run requirements.

Then verify:

- the inventory is deterministic and matches the classified guard set;
- every repaired guard is CI-reachable and has a direct armed test;
- the open Warden PR count remains within protocol;
- Linear has one deduplicated finding per fingerprint and one append-only checkpoint;
- the active user checkout and unrelated files remain unchanged;
- automation memory records the run time, watermark, outcome, stable issue/PR identifiers, and exact next action when an Automation ID is present.

Report NOOP as success. Surface partial external writes, uncertain classifications, and environmental test failures explicitly.
