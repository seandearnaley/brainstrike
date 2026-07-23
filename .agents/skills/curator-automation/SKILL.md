---
name: curator-automation
description: Execute Brainstrike's Curator model-catalog freshness automation from `.night-shift/charters/curator.md`. Use for scheduled or manual Curator runs, provider-catalog fetches (OpenRouter), provider-vs-repo model-ID delta computation, additive catalog-data migration PRs, dead-model-ID removal tickets, and append-only Curator state checkpoints.
---

# Curator Automation

Execute the repository-owned Curator charter without duplicating its policy. Use the bundled collector for the deterministic provider-vs-repo delta; retain judgment for relevance, catalog-entry authoring, and risk.

## Establish authority and state

1. Resolve the Brainstrike repository root and read `AGENTS.md` plus any more-specific instruction files.
2. Read `.night-shift/PROTOCOL.md`, `.night-shift/charters/curator.md`, then `docs/agents/database.md` and `docs/agents/assistant-providers.md` COMPLETELY before judging any lead — the catalog invariants (dual migration-runner registration, user-enablement preservation, lane-manifest registration for new tests) are the whole risk surface of this loop.
3. Resolve automation memory when an Automation ID is present. Treat it as an execution aid, never as authority over provider, repository, or Linear state.
4. Note the UTC start time and the live wall-clock budget. Fetch `origin/main`.
5. Resolve the exact charter-named Linear state issue and its latest append-only protocol-shaped checkpoint. Ignore newer non-checkpoint discussion.
6. Curator is an EXTERNAL-STATE loop: the watched set is the collector's normalized provider surface plus the repo catalog surface. Never NOOP on an unchanged `main`; never do real work when the watched-set hash matches the prior checkpoint and no Curator PR or reopened ticket needs attention.
7. Resume the one open Curator PR before starting new work. Stop and surface a protocol violation if more than one is open.

Resolve conflicts in this order: repository instructions and subsystem contracts, protocol, Curator charter, this skill.

## Collect the provider-vs-repo delta

Run:

```bash
node .agents/skills/curator-automation/scripts/collect-curator-evidence.mjs \
  --repo /absolute/path/to/brainstrike \
  --pretty
```

The collector performs no repository writes; its only network access is an unauthenticated read of the provider model listing. It:

- validates repository identity and reads the migration and provider-registry surfaces at `origin/main`;
- extracts every `(model_id, provider_id)` pair seeded by the numbered migrations and fails visibly when the extraction pattern matches nothing (a parser rotting silently would report a falsely empty catalog);
- fetches and normalizes the OpenRouter public model listing (or reads `--providers-json <file>` for offline/dry-run/test use) and fails on malformed or empty responses;
- emits `providerNotInRepo` and `repoNotInProvider` deltas plus a `watchedSetHash` over both normalized surfaces for the checkpoint watermark.

Treat both deltas as leads, never findings. The collector cannot judge relevance, deprecation intent, or product fit.

When `watchedSetHash` equals the prior checkpoint's and no open Curator PR or reopened ticket requires work, append the NOOP checkpoint and exit.

For a dry-run or audit request, stop after reporting the would-be dispositions. Make no writes.

## Gate and act

1. Apply the live charter's gates: additions must be justified from the provider's own metadata against the product's documented use; removals and renames are always findings but NEVER yours to ship — file the charter-required `needs-human` ticket with provider evidence. Model IDs are copied from the provider response, never typed from memory.
2. Search Linear for each fingerprint before filing or updating anything, with complete pagination.
3. For an addition PR: follow the latest shipped catalog migration as the pattern — numbered migration registered in BOTH runners, additive INSERTs only, new rows disabled by default per the documented pattern, no UPDATE or DELETE of existing rows, `is_enabled` of existing rows untouched. Run the enablement-preservation guard and the migration-parity checks locally; a Curator PR failing either is not opened.
4. Verify per the charter: packages/db tests (with lane-manifest registration for any new test file), then the full repository gates in one final run, then re-run the collector to confirm the new IDs appear on the repo side.

## Report and checkpoint

Use `$brainstrike-pr-loop` for stewardship of the open PR. Bulletin Assay when a catalog PR is in flight, through Curator's permitted channel.

Append exactly one protocol-shaped checkpoint whose watermark is the collector's `watchedSetHash`. Never edit the state description or prior comments. Checkpoint BLOCKED when the provider endpoint, extraction pattern, guard execution, or Linear pagination cannot be proven healthy — never substitute a remembered catalog for a failed fetch.

Finish by verifying the PR set, tickets, checkpoint, working tree, and automation memory agree; record UTC timing, watermark, leads judged, and the exact next action in automation memory when an Automation ID is present. Report NOOP as success.
