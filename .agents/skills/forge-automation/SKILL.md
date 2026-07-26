---
name: forge-automation
description: Execute Brainstrike's Forge small-ticket implementer automation from `.night-shift/charters/forge.md`. Use for scheduled or manual Forge runs, `agent-ready` ticket selection and claiming, eligibility gating against risk factors, red-green single-ticket implementation, PR stewardship, ineligibility escalation, and append-only Forge state checkpoints.
---

# Forge Automation

Execute the repository-owned Forge charter without duplicating its policy. Forge has no bundled collector: its evidence surface is Linear tickets and `gh` directly, and the hard part — eligibility judgment — cannot be scripted. What follows is execution discipline, not policy.

## Establish authority and state

1. Resolve the Brainstrike repository root and read `AGENTS.md` plus any more-specific instruction files.
2. Read `.night-shift/PROTOCOL.md`, `.night-shift/charters/forge.md`, every `.night-shift/*.md` file, and `.night-shift/charters/assay.md` (the risk-factor definitions your eligibility gate re-derives). Read the architecture contract for any subsystem the selected ticket touches — before implementation, not during review.
3. Resolve automation memory when an Automation ID is present. Treat it as an execution aid, never as authority over Linear, GitHub, or repository state.
4. Note the UTC start time and the live wall-clock budget. Fetch `origin/main`.
5. Resolve the exact charter-named Linear state issue and its latest append-only protocol-shaped checkpoint. Ignore newer non-checkpoint discussion.
6. Forge is an EXTERNAL-STATE loop: the watched set is the unresolved `agent-ready`-labeled tickets (minus `forge:attempted`) plus your open PR. Enumerate BY LABEL ONLY and never by status — Linear's `Backlog` is a distinct status type from `unstarted`/`Todo`, so a status filter of "open"/"unstarted"/"Todo" returns an empty page with `hasNextPage: false` while real tickets sit in Backlog. Drop `completed`/`canceled` items by inspecting each returned issue's `statusType`, not by filtering the query. Enumerate with complete pagination; a pagination gap means the watched set is unproven — checkpoint BLOCKED, never guess.
7. PROVE AN EMPTY QUEUE BEFORE REPORTING ONE. An empty watched set is only NOOP when the enumeration itself is sound, and a wrong status filter is silent — it looks exactly like success. Before checkpointing an empty queue, re-read the label's issues and count the NON-TERMINAL ones (`statusType` neither `completed` nor `canceled`, minus `forge:attempted`) — the same population as your watched set. Zero non-terminal is a genuinely quiet day: checkpoint NOOP. A non-terminal labeled ticket missing from your watched set is a contradiction and means your enumeration is broken: checkpoint BLOCKED naming the ticket. Never compare against the label's RAW total — a human who labels a ticket then closes it himself leaves the label attached forever, and a raw-count check would then report BLOCKED on every wake for an empty queue, which is worse than the NOOP it replaced. Your checkpoint's one-line message states the enumeration used and both counts, so the ledger shows a broken query instead of hiding it.
8. Stewardship precedes selection: reconcile your one open PR per protocol before considering any ticket. More than one open Forge PR is a protocol violation — stop and surface it.

Resolve conflicts in this order: repository instructions and subsystem contracts, protocol, Forge charter, this skill.

## Enforce the label contract exactly

- Ensure the `agent-ready` and `forge:attempted` labels exist (create-if-missing). Never apply `agent-ready` to any ticket, and never treat a ticket as eligible without it — a ticket that merely LOOKS trivial is not authorization.
- Claim before work: swap `agent-ready` → `forge:attempted` and comment your intent on the ticket BEFORE creating a branch. Re-read the ticket after the swap to confirm the claim landed; a failed claim means another wake may own it — do not proceed.
- Never implement a `needs-human` escalation, your own or another loop's, regardless of labels.

## Gate eligibility per the charter

Apply the charter's eligibility test literally. The failing test must be writable from the ticket text alone; estimate the diff's territory against the risk factors re-derived from `charters/assay.md` at wake. When declining, the ticket comment must name the exact missing criterion or risk factor — "too vague" is not a reason, "acceptance criteria do not specify the expected ordering for X" is. Escalating with specific questions is a success outcome; checkpoint it as such.

For a dry-run or audit request, stop after reporting the would-be selection and eligibility reasoning. Make no writes.

## Implement red-green in isolation

1. Branch `night-shift/forge/<ticket-id>-<slug>` in an isolated worktree at `origin/main`.
2. Write the failing test first and capture its red output verbatim — it goes in the PR body. A test that passes before the change means you misread the ticket; stop and re-gate.
3. Implement the smallest coherent diff. Scope discipline is absolute: adjacent debt becomes a fingerprinted Linear ticket, never part of this diff.
4. Run the full repository gates green in the same run on the final code state, with lane-manifest registration for any new `packages/db` test.
5. A durable, codebase-specific learning lands in `.night-shift/forge.md` in the same PR.

## Report and checkpoint

Open ONE PR per the charter's title format, quoting the acceptance criteria and the red→green evidence. Comment the PR link on the ticket. Use `$brainstrike-pr-loop` for stewardship through READY; the ticket is closed by the human after merge, never by you.

Append exactly one protocol-shaped checkpoint whose watermark is the current `agent-ready` ticket-ID set plus your claimed ticket's disposition. Never edit the state description or prior comments. Checkpoint BLOCKED on pagination gaps, claim races, or gate failures you cannot diagnose within budget; record the exact next action.

Finish by verifying the ticket labels, PR set, checkpoint, working tree, and automation memory agree. Report NOOP (empty label queue) as success.
