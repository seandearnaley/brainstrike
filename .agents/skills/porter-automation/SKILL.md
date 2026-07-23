---
name: porter-automation
description: Execute Brainstrike's Porter merge-executor automation from `.night-shift/charters/porter.md`. Use for scheduled or manual Porter runs, night-shift PR merge-eligibility evidence, required-context verification, kill-switch and circuit-breaker checks, post-merge main watching, and revert-PR escalation.
---

# Porter Automation

Execute the repository-owned Porter charter without duplicating its policy.
The collector supplies the GitHub-side evidence table; the charter owns every
eligibility judgment. Porter is the only loop with merge authority, bounded
by the charter's committed `AUTHORITY_LEVEL` — this skill never widens it.

## Establish authority and state

1. Resolve the repository root; read `AGENTS.md`, `.night-shift/PROTOCOL.md`,
   and `.night-shift/charters/porter.md`.
2. Check the kill switches BEFORE any other work, in charter order: the
   committed `.night-shift/HOLD` file, then the breaker state on the Porter
   state issue (newest checkpoint vs any later human `porter: clear`
   comment). Unreadable switch state = BLOCKED, not a guess.
3. Resolve the `[automation-state] Porter` issue and its newest checkpoint;
   your merge ledger for the post-merge watch is the last 72h of your own
   checkpoints.

Resolve conflicts in this order: repository instructions and subsystem
contracts, protocol, Porter charter, this skill.

## Collect evidence

```bash
node .agents/skills/porter-automation/scripts/collect-porter-evidence.mjs \
  --repo /absolute/path/to/brainstrike \
  --pretty
```

The collector is read-only (all `gh` access is queries; it never merges,
comments, or labels). It:

- enumerates required contexts from the main-branch ruleset and fails
  visibly when none are found — a merge-evidence run without a
  required-check list proves nothing;
- lists open `night-shift/*` PRs with, per PR: head SHA, risk/hold labels,
  per-required-context status on that exact head (an ABSENT required
  context reads as not green — the skipped-check masking class), failing
  advisory checks, unresolved-thread count, newest Assay work_key head SHA,
  last-activity timestamp (commits, reviews, comments, thread replies),
  and dependent PRs targeting the head branch;
- reports whether `.night-shift/HOLD` is committed at the checked revision.

Linear-side conditions (the owning loop's `status=READY` checkpoint for the
exact head SHA) are verified directly, with complete pagination.

## Act

Follow the charter's beats exactly: at most one merge per wake; the
pre-merge audit comment before the merge; squash without `--admin` and
treat any gh refusal as a false belief (skip + fingerprinted ticket, never
retry with force); re-check dependents before branch deletion; post-merge
watch with revert-PR + urgent ticket + breaker on a traced red main. Never
merge a revert. When in doubt there is no doubt: skip.

For a dry-run or audit request (or at AUTHORITY_LEVEL 0), stop after
posting/reporting the would-merge verdicts. Make no merges.

## Checkpoint and finish

Append exactly one protocol-shaped checkpoint (validated with
$night-shift-checkpoint): merged PR or none, waiting count, per-PR blocked
condition numbers, breaker state. Durable eligibility edge cases go through
pending-learnings.
