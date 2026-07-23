---
name: auditor-automation
description: Execute Brainstrike's Auditor outcome-scoreboard automation from `.night-shift/charters/auditor.md`. Use for scheduled or manual Auditor runs, weekly per-loop outcome scoring, merge/revert tracing, finding-precision measurement, and authority promotion/demotion proposal tickets.
---

# Auditor Automation

Execute the repository-owned Auditor charter without duplicating its policy.
Declared collector exception: the evidence surface is gh + Linear directly
(cross-source aggregation), paginated completely — fail closed on partial
data rather than scoring a truncated week.

## Establish authority and state

1. Resolve the repository root; read `AGENTS.md`, `.night-shift/PROTOCOL.md`,
   `.night-shift/charters/auditor.md`, and `charters/README.md` (re-derive
   the roster, each charter's CHARTER_VERSION, and Porter's AUTHORITY_LEVEL
   at wake — never from memory).
2. Resolve the `[automation-state] Auditor` issue; the scoring window opens
   at the previous checkpoint.

Resolve conflicts in this order: repository instructions and subsystem
contracts, protocol, Auditor charter, this skill.

Stay report-only: one scoreboard issue overwrite plus fingerprinted proposal
tickets. Never edit charters, PROTOCOL.md, code, labels, or any authority
field, and never file a proposal below the charter's committed sample-size
thresholds — "insufficient data (n=X)" in the scorecard is the correct
output for a thin week.

## Gather

Per loop, keyed by (loop, CHARTER_VERSION):

- gh: PRs opened/merged/closed-unmerged in the window; time-to-READY and
  READY→merge latencies from state-issue checkpoints vs merge timestamps;
  review-response latency (review submittedAt → the loop's reply); reverts
  or fix-forward commits touching a merged diff within 72h.
- Linear: finding tickets filed vs closed Done vs closed Canceled;
  needs-human response ages; checkpoint status streaks and NOOP ratios.
- Porter: merges, per-condition block counts, refusals, breaker events,
  traced reverts — the L1→L2 evidence ledger.

## Report and propose

Overwrite the `[scoreboard] Auditor` issue description (marked generated):
one block per loop, headline rates each with their n, trend vs prior week.
File proposal tickets only when a charter threshold is met, quoting the
threshold and attaching the full evidence ledger. Checkpoint per the
protocol grammar (validated with $night-shift-checkpoint).
