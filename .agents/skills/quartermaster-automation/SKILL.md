---
name: quartermaster-automation
description: Execute Brainstrike's Quartermaster dependency-triage automation from `.night-shift/charters/quartermaster.md`. Use for scheduled or manual Quartermaster runs, pinned-landmine denylist derivation, outdated-dependency partitioning, unpin-condition checks, major-version tickets, grouped family update PRs, gate-failure reverts, and append-only Quartermaster state checkpoints.
---

# Quartermaster Automation

Execute the repository-owned Quartermaster charter without duplicating its policy. Dependency triage is landmine-aware by construction: the denylist derivation comes first, and no update is safe until it survives the full repository gate in the same run. There is no bundled collector; the repository's own `scripts/generate-dependency-update-report.mjs` is the observation tool.

## Establish authority and state

1. Resolve the Brainstrike repository root and read `AGENTS.md` plus any more-specific instruction files.
2. Read `.night-shift/PROTOCOL.md`, `.night-shift/charters/quartermaster.md`, and every `.night-shift/*.md` file completely.
3. RE-DERIVE the pinned-landmine denylist from the current `docs/agents/ci-quality.md` and `docs/agents/database.md` before touching any version. The charter's examples are hints; the live docs are the denylist. Never copy pin names or unpin conditions into this skill.
4. Resolve automation memory when an Automation ID is present. Treat it as an execution aid, never as authority over repository or remote state.
5. Note the UTC start time and live wall-clock budget. Fetch `origin/main`, then resolve state in protocol trust order: open `night-shift/quartermaster/*` PRs (the charter allows up to its family limit), repository HEAD, the exact Linear state issue and latest append-only checkpoint, then nothing.
6. Require an exact MAIN-DIFF watermark from trusted state; never guess or substitute one. When the watermark range is empty, no Quartermaster PR is open, and no reopened Quartermaster ticket needs work, append a NOOP checkpoint and stop.
7. Resume open Quartermaster PRs before starting new families. Surface a protocol violation if the open set exceeds the live charter's limit.

Resolve conflicts in this order: repository instructions and architecture contracts, protocol, Quartermaster charter, this skill.

## Observe and partition

1. Run `node scripts/generate-dependency-update-report.mjs` from the repository root and read its full output plus the current report file it maintains.
2. Partition every outdated entry exactly as the live charter requires: DENYLISTED, MAJOR, or safe patch/minor. Record each denylisted skip with its documented reason for the checkpoint — no silent skips.
3. For each denylisted pin, check whether its documented unpin condition is now satisfied upstream, using the exact condition from the live docs. Satisfied → deduplicated Linear ticket with the evidence. NEVER auto-bump a pin, even a "trivially" satisfied one.
4. For each major, file one Linear ticket with the charter's fingerprint shape, a changelog-derived breaking-changes summary, and an affected-usage scan of this repository. No PRs for majors.
5. Search Linear for the charter fingerprint before every ticket write; update an open twin rather than filing a duplicate. Respect prior gate-failure tickets: do not retry a family whose failure fingerprint is open unless the family or repository changed.

For a dry-run or audit request, stop after the partition and report what would change. Make no PR, ticket, or repository writes.

## Update by family

Follow the live charter's family rules exactly: group by family, respect the per-run family limit, order riskiest-first so a budget expiry drops the safest work, and skip any package with an open Pruner PR against it.

Per family:

1. Read the changelog for every bumped package version-by-version. An unreadable or missing changelog makes the family ineligible this run — record why.
2. Apply the bump respecting workspace `catalog:` entries and the repository's catalog-reference verification. Never fork a version that the catalog centralizes.
3. Run the full repository gate required by the current `AGENTS.md` green in the same run. CI confirms local proof; it is not the first test runner.
4. Open one PR per family with the charter's title shape and changelog links. Never merge or enable auto-merge.
5. A family whose gate fails is fully reverted in the working tree, then recorded as one deduplicated Linear ticket with the failure evidence and fingerprint. Never ship a partially-updated family, weaken a check, or add a retry to force green.

Commit the refreshed dependency report in the run's final PR as the charter requires.

## Checkpoint and finish

Append exactly one protocol-shaped checkpoint using the fully swept `origin/main` SHA, listing families updated, families reverted, denylist skips with reasons, and tickets filed. Never edit the state issue description or prior comments.

Add a Quartermaster learning only for a durable compatibility trap established by the same PR, and the charter's bulletin line only when a bump changed benchmark-relevant behavior.

Finish by verifying:

- no denylisted pin moved;
- every open Quartermaster PR is within the charter limit and green or being stewarded;
- reverted families left zero trace in the working tree;
- tickets are deduplicated by fingerprint;
- automation memory records UTC timing, watermark, per-family outcomes, remote identifiers, and the exact next action when an Automation ID is present.

Report NOOP as success. Surface every partial write, gate failure, and budget-dropped family explicitly.
