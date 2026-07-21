---
name: magnify-automation
description: Execute Brainstrike's Magnify adversarial PR-review automation from `.night-shift/charters/magnify.md`. Use when running, dry-running, debugging, or maintaining Magnify; reviewing open PRs labeled risk-3 or risk-4; checking Magnify report markers and dismissed findings; spawning the three mandated review lenses; posting one advisory report per PR head; or appending Magnify's Linear state checkpoint.
---

# Magnify Automation

Execute the repository-owned Magnify charter without duplicating its policy. Use the bundled collector for deterministic read-only discovery and retain the strongest available model for verification and reporting.

## Establish authority

1. Resolve the Brainstrike repository root and read `AGENTS.md` plus any more-specific instruction files.
2. Read `.night-shift/PROTOCOL.md`, `.night-shift/charters/magnify.md`, every `.night-shift/*.md` file, and every document the live charter requires.
3. Note the UTC start time and the live wall-clock budget.
4. Resolve the charter's Linear state issue and latest append-only checkpoint. Create the state issue only when its exact title is absent, using the charter-required label.
5. Resolve automation memory when an Automation ID is present. Treat it as an execution aid, never as authority over repository or remote state.
6. Resolve conflicts in this order: repository instructions and subsystem contracts, protocol, Magnify charter, this skill.

Never copy label names, marker versions, selection limits, schedule, state title, or report policy into this skill. Re-derive them from the live charter on every run.

## Collect the evidence

Run:

```bash
node .agents/skills/magnify-automation/scripts/collect-magnify-evidence.mjs \
  --repo /absolute/path/to/brainstrike \
  --pretty > /tmp/magnify-evidence.json
```

The collector performs no writes. It:

- validates repository identity and derives the live charter values;
- enumerates all open elevated-risk PRs with complete pagination;
- verifies exact current-head Magnify markers and orders work from live charter rules;
- fails if a selected PR moves head or closes during collection;
- gathers complete changed-file pagination, the full diff, checks, prior reports, and discussion after the latest prior report;
- inventories available subsystem contracts and records the working-tree status.

Treat `discussionAfterLatestPriorReport` as evidence, not an automatic dismissal. A human must have explicitly dismissed a specific finding. If intent is ambiguous, do not mark it dismissed and do not guess.

For a dry-run, audit, skill test, or collector-debug request, stop after reviewing the evidence. Make no GitHub or Linear writes.

## Review selected PRs

For each selected PR, read the full diff and every applicable `docs/agents` contract before spawning reviewers. Determine applicable contracts from actual changed behavior, not filenames alone.

Spawn three fresh read-only subagents with the raw evidence and relevant contracts. Do not pass suspected findings or conclusions between lenses.

1. Ask the correctness lens to refute safety through behavior gaps, unpinned edge cases, and async, cleanup, or ordering hazards.
2. Ask the contract lens to refute safety against all applicable contracts and house rules, including silent fallback, capability gating, reset wiring, lane manifests, and assertion weakening.
3. Ask the blast-radius lens to refute safety by tracing every changed surface to other consumers, distant breakage, and rollback behavior.

Subagents never edit files, post comments, change labels, or call side-effectful external tools. Stop them when the live budget expires.

## Verify and report

Independently verify every proposed finding. Keep it only when it has:

- a specific current-head diff hunk;
- a concrete failure scenario or applicable contract citation;
- evidence that the scenario is reachable;
- a resolution proportional to the defect.

Deduplicate findings and record independent lens convergence. Compare new-head findings with prior reports and explicit dismissals. Never re-litigate a dismissed finding.

Before posting, re-fetch the PR and require the same open head. Post exactly one top-level advisory comment with the live marker and charter-prescribed structure. Never approve, request changes, label, edit code, merge, or deploy. For Night Shift branches, verify territory, evidence, and claimed gates against the owning charter and current checks.

After posting, re-read PR comments and verify exactly one current-head marker exists and the body matches the intended report. Surface a duplicate or partial write immediately; never silently repair history.

## Checkpoint and finish

Append exactly one state comment covering selected PRs, heads, finding counts, and honored dismissals. Never edit the issue description or prior checkpoint comments. Apply the protocol fingerprint and deduplication rules before any learning or recurrence ticket.

Verify that:

- the eligible set and selected heads have not drifted;
- each processed head has exactly one Magnify report;
- unprocessed eligible PRs remain visible when the run limit is reached;
- the checkpoint matches the posted reports;
- the repository working tree is unchanged;
- automation memory records the UTC completion time, outcome, and stable remote identifiers.

Report NOOP as success when every eligible current head is already covered or no elevated-risk PR exists. Surface all blocked or partial external state explicitly.
