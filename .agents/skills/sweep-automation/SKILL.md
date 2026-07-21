---
name: sweep-automation
description: Execute Brainstrike's Sweep nightly-noise janitor automation from `.night-shift/charters/sweep.md`. Use for scheduled or manual Sweep runs, stale nightly-failure ticket closure, green-run verification against latest workflow runs, cross-stream failure correlation, consolidated infra-regression tickets, and append-only Sweep state checkpoints.
---

# Sweep Automation

Execute the repository-owned Sweep charter without duplicating its policy. Sweep is tickets-only: it closes stale nightly-failure tickets against fresh workflow evidence and correlates failure streams. There is no bundled collector; the evidence surface is small enough to gather directly with `gh` and the Linear tools, and every claim must cite a specific workflow run.

## Establish authority and state

1. Resolve the Brainstrike repository root and read `AGENTS.md` plus any more-specific instruction files.
2. Read `.night-shift/PROTOCOL.md`, `.night-shift/charters/sweep.md`, and every `.night-shift/*.md` file completely.
3. Resolve automation memory when an Automation ID is present. Treat it as an execution aid, never as authority over Linear or GitHub state.
4. Note the UTC start time and the live wall-clock budget. Sweep's budget is short; do not start open-ended investigations.
5. Resolve the exact charter-named Linear state issue and its latest append-only protocol-shaped checkpoint. Ignore newer non-checkpoint discussion.
6. Sweep is an EXTERNAL-STATE loop: its watched set is its own open-ticket set plus the latest runs of the charter-derived nightly streams. Never NOOP on an unchanged `main`; never checkpoint a main-diff watermark as if it proved anything.

Resolve conflicts in this order: repository instructions and subsystem contracts, protocol, Sweep charter, this skill.

Stay tickets-only. Never open a PR, edit code or workflow files, re-run or cancel CI, reopen an old closed ticket, or touch anything outside Linear comments/closures and the state checkpoint.

## Gather live evidence

1. Re-derive the nightly failure streams from `.github/workflows/` on the current checkout — enumerate workflows with `schedule:` triggers and select those the live charter's stream definition covers. Never trust a remembered stream list.
2. Enumerate Sweep-relevant open Linear tickets with complete pagination: the auto-filed nightly-failure tickets for those streams, using the label and fingerprint conventions from the live protocol and charter.
3. For each candidate ticket, fetch the workflow's latest completed runs with `gh run list --workflow <file> --limit` sufficient to prove ordering, and record run IDs, head SHAs, conclusions, and completion times.
4. Read each ticket's comment history far enough to establish its last recorded failure and whether any human has commented.

Every disposition must cite exact run URLs and timestamps. A missing workflow, ambiguous stream mapping, failed `gh` call, or incomplete Linear pagination is a visible blocker — checkpoint BLOCKED rather than guessing.

For a dry-run or audit request, stop after reporting the would-be dispositions. Make no Linear writes.

## Disposition each ticket

Apply the live charter's rules exactly:

1. Close a ticket only when at least one confirmed green run of its workflow completed AFTER the ticket's last recorded failure, and link that run in the closing comment.
2. Never close a ticket carrying any human comment: comment your green-run evidence, add the charter-required label, and leave it open.
3. An in-progress or queued run proves nothing; only a completed green run counts. A red latest run means the ticket stays open with the new occurrence recorded.
4. When open tickets from two streams point at overlapping commit ranges, file ONE consolidated ticket per the charter, deduplicated by protocol fingerprint, linking both streams' evidence, and add the charter-required bulletin escalation through Sweep's permitted channel.

Read before every Linear write and re-read after it. Surface partial writes immediately; never silently repair history.

## Checkpoint and finish

Append exactly one protocol-shaped checkpoint recording the observed ticket set and the run evidence high-water mark. Never edit the state issue description or prior comments.

Sweep has no learnings file by charter: route durable observations through the state issue only, as the live charter directs.

Finish by verifying:

- every closed ticket cites a green run that genuinely postdates its last failure;
- no human-commented ticket was closed;
- consolidation tickets are deduplicated by fingerprint;
- no repository file, PR, or workflow changed;
- automation memory records UTC timing, dispositions, ticket identifiers, and the exact next action when an Automation ID is present.

Report NOOP as success when no ticket needed a disposition change.
