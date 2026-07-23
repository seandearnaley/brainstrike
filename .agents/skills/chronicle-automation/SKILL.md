---
name: chronicle-automation
description: Execute Brainstrike's Chronicle shift-report and fleet meta-monitor automation from `.night-shift/charters/chronicle.md`. Use for scheduled or manual Chronicle runs, 24h fleet-activity windows, night-shift PR and scheduled-workflow evidence collection, missed-wake and stale-BLOCKED anomaly detection, the [shift-report] digest overwrite, anomaly tickets, and append-only Chronicle state checkpoints.
---

# Chronicle Automation

Execute the repository-owned Chronicle charter without duplicating its policy. Use the bundled collector for the deterministic GitHub-side evidence; retain judgment for anomaly confirmation, digest composition, and ordering by importance.

## Establish authority and state

1. Resolve the Brainstrike repository root and read `AGENTS.md` plus any more-specific instruction files.
2. Read `.night-shift/PROTOCOL.md`, `.night-shift/charters/chronicle.md`, and `.night-shift/charters/README.md` — the roster table is the source of truth for which loops exist and their cadences. Re-derive it every run; never use a remembered roster.
3. Resolve automation memory when an Automation ID is present. Treat it as an execution aid, never as authority over GitHub or Linear state.
4. Note the UTC start time and the live wall-clock budget. Chronicle's budget is short; the digest is a report, not an investigation.
5. Resolve the exact charter-named Linear state issue and its latest append-only protocol-shaped checkpoint. The window opens at that checkpoint's timestamp; for a proven first run, open it at the Night Shift bootstrap commit's date and say so in the digest.
6. Chronicle is an EXTERNAL-STATE loop: the watched window is fleet activity, never the main diff.

Resolve conflicts in this order: repository instructions and subsystem contracts, protocol, Chronicle charter, this skill.

Stay report-only. Never open a PR, edit code, touch labels outside Linear, re-run CI, or act on another loop's behalf — an anomaly is reported, not repaired.

## Collect fleet evidence

Run:

```bash
node .agents/skills/chronicle-automation/scripts/collect-chronicle-evidence.mjs \
  --repo /absolute/path/to/brainstrike \
  --window-start <prior-checkpoint-utc-iso> \
  --pretty
```

The collector performs no repository or external writes; all `gh` access is read-only. It:

- validates repository identity and derives the rostered loops and cadences from the charters directory at `origin/main`;
- enumerates `night-shift/*` PRs opened, merged, or still open in the window, with per-PR check rollup, unresolved-thread counts, and the newest commit timestamp (`lastCommitAt`, the STALLED STEWARDSHIP input), paginated completely;
- derives scheduled workflows from `.github/workflows/` and records each one's latest completed run conclusion;
- computes expected-wake counts per loop from the roster cadence over the window (with the charter's scheduler-slack allowance) so missed-wake detection is arithmetic, not recollection;
- fails visibly on `gh` errors, ambiguous cron expressions, or an unparseable roster — a meta-monitor that guesses is worse than none.

Gather the Linear side yourself with complete pagination: new checkpoints per `[automation-state]` issue, night-shift-labeled ticket activity in the window, and open `needs-human` tickets. Parse each newest checkpoint against the protocol grammar; a parse failure is itself a MALFORMED CHECKPOINT anomaly, never something to normalize silently.

For a dry-run or audit request, stop after reporting the would-be digest and anomalies. Make no writes.

## Detect anomalies and compose the digest

1. Apply the charter's anomaly rules exactly (missed wake, no footprint, stale BLOCKED, malformed checkpoint, stalled stewardship, stuck loop, stalled handoff). Every anomaly must cite its evidence: the expected cron and the empty window, the resolved blocking ticket, the unparseable line, the `lastCommitAt` age beside the unresolved-thread or failing-check count, the repeated next-action text. Confirm a STALE BLOCKED by reading the blocking ticket's actual state, not its title.
2. File anomaly tickets per the charter's fingerprint scheme, searching Linear first with complete pagination; update an open match rather than filing a twin. Stalled handoffs are digest lines only.
3. Compose the digest per the charter's six sections (including FORGE QUEUE) and length cap, then fully overwrite the `[shift-report]` issue description, marked generated. Plain factual prose, ordered by importance; every line traceable to collected evidence.

## Checkpoint and finish

Append exactly one protocol-shaped checkpoint recording the window end and the observed newest-checkpoint set. Never edit the state description or prior comments. Checkpoint BLOCKED when `gh` access, Linear pagination, or roster parsing cannot be proven — and still write the digest if any partial window was proven, noting the gap in it.

Chronicle routes durable observations through pending-learnings; the Librarian migrates them. Never edit `.night-shift/*.md` files directly.

Finish by verifying the digest, anomaly tickets, checkpoint, and automation memory agree; record UTC timing, window bounds, anomaly counts, and the exact next action in automation memory when an Automation ID is present. A quiet night is success — report it as such.
