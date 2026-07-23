---
name: librarian-automation
description: Execute Brainstrike's Librarian learnings-consolidation automation from `.night-shift/charters/librarian.md`. Use for scheduled or manual Librarian runs, pending-learnings migration from Linear state issues into tracked `.night-shift/*.md` files, learnings-file dedupe and staleness pruning, bulletin cap enforcement, learnings-convention audits, and append-only Librarian state checkpoints.
---

# Librarian Automation

Execute the repository-owned Librarian charter without duplicating its policy. Use the bundled inventory collector for the deterministic repo-side evidence; retain judgment for verification, consolidation quality, and what counts as durable.

## Establish authority and state

1. Resolve the Brainstrike repository root and read `AGENTS.md` plus any more-specific instruction files.
2. Read `.night-shift/PROTOCOL.md`, `.night-shift/charters/librarian.md`, and every `.night-shift/*.md` file completely — the learnings files are both your input and your output surface.
3. Resolve automation memory when an Automation ID is present. Treat it as an execution aid, never as authority over repository or Linear state.
4. Note the UTC start time and the live wall-clock budget. Fetch `origin/main`.
5. Resolve the exact charter-named Linear state issue and its latest append-only protocol-shaped checkpoint. Ignore newer non-checkpoint discussion.
6. Librarian is an EXTERNAL-STATE loop: the watched set is the fleet's unmigrated pending-learnings entries plus the bulletin and learnings-file hygiene state. Never NOOP on an unchanged `main`.
7. Resume the one open Librarian PR before starting new work. Stop and surface a protocol violation if more than one is open.

Resolve conflicts in this order: repository instructions and subsystem contracts, protocol, Librarian charter, this skill.

## Collect repo-side inventory

Run:

```bash
node .agents/skills/librarian-automation/scripts/collect-librarian-inventory.mjs \
  --repo /absolute/path/to/brainstrike \
  --pretty
```

The collector performs no repository or external writes. It:

- validates repository identity and reads the `.night-shift/` tree at `origin/main`;
- parses every charter's meta block and cross-references `LEARNINGS_FILE` declarations against the files that actually exist (missing files for diagnose-only loops are expected, orphaned learnings files are flagged);
- measures the bulletin against its declared cap and emits a content hash for the checkpoint watermark;
- flags convention-smell lines in learnings files (timestamps-as-content, run-log phrasing) as candidates, never verdicts.

Gather the Linear side yourself: every `[automation-state]` issue's `## pending-learnings` entries that lack a migration reply, with complete pagination. A pending-learnings entry you cannot attribute to a rostered loop is a visible blocker, not something to guess about.

For a dry-run or audit request, stop after reporting the would-be migrations. Make no writes.

When the watched set (unmigrated entry IDs + collector hygiene findings + bulletin hash) is unchanged and no Librarian PR is open, append the NOOP checkpoint and exit.

## Verify, then consolidate

1. Verify every candidate learning against current code before promoting it — read the referenced files, symbols, or commands and confirm the claim still holds. A learning that fails verification is never migrated; reply on the state issue with the reason and ticket the owning loop when the underlying finding still matters.
2. Consolidate mechanically: move verified entries into the owning loop's `.night-shift/<loop>.md`, merge duplicates, delete entries invalidated by code changes (cite the invalidating commit), and trim the bulletin to its cap, stalest first. Rewrite for concision; never change technical meaning, soften a settled ruling, or invent content.
3. Never touch `PROTOCOL.md`, charters, or any file outside `.night-shift/` learnings and bulletin surfaces.
4. Open at most ONE PR per the charter's title and branch rules. Librarian's own durable insights go in `.night-shift/librarian.md` in the same PR.

## Report and checkpoint

After the PR exists, reply on each source state issue marking the migrated entries with the PR number, append-only. Use `$brainstrike-pr-loop` for stewardship of the open PR.

Append exactly one protocol-shaped checkpoint whose watermark is the processed pending-learnings comment-ID set plus the collector's bulletin hash. Never edit the state description or prior comments. Checkpoint BLOCKED when Linear pagination, entry attribution, or verification evidence cannot be proven.

Finish by verifying the PR set, checkpoint, working tree, and automation memory agree, and record UTC timing, watermark, migrated/rejected counts, and the exact next action in automation memory when an Automation ID is present. Report NOOP as success.
