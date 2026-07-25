---
name: vigil-automation
description: Execute Brainstrike's Vigil security-advisory watcher automation from `.night-shift/charters/vigil.md`. Use for scheduled or manual Vigil runs, pnpm audit and Dependabot alert collection against the lockfile, advisory verification and reachability triage, patchable-vs-exploitable routing, advisory ticket sweeps, and append-only Vigil state checkpoints.
---

# Vigil Automation

Execute the repository-owned Vigil charter without duplicating its policy. Use the bundled collector for the deterministic advisory surface; retain judgment for reachability, routing, and disclosure discipline.

## Establish authority and state

1. Resolve the Brainstrike repository root and read `AGENTS.md` plus any more-specific instruction files.
2. Read `.night-shift/PROTOCOL.md`, `.night-shift/charters/vigil.md`, and the DISCLOSURE RULE in `.night-shift/charters/sentinel.md` — it binds every Vigil write.
3. Resolve automation memory when an Automation ID is present. Treat it as an execution aid, never as authority over the advisory feed, Linear, or repository state.
4. Note the UTC start time and the live wall-clock budget. Vigil's budget is short; it sees and routes, it never investigates a fix.
5. Resolve the exact charter-named Linear state issue and its latest append-only protocol-shaped checkpoint. Ignore newer non-checkpoint discussion.
6. Vigil is an EXTERNAL-STATE loop: the watched set is the collector's advisory-triple set. Never NOOP on the main diff.

Resolve conflicts in this order: repository instructions and subsystem contracts, protocol, Vigil charter, this skill.

Stay tickets-only. Never bump a version, edit code or lockfiles, run mutating installs, or re-run CI.

## Collect the advisory surface

Run:

```bash
node .agents/skills/vigil-automation/scripts/collect-vigil-advisories.mjs \
  --repo /absolute/path/to/brainstrike \
  --pretty
```

The collector performs no repository writes and no mutating installs. It:

- validates repository identity and requires the lockfile;
- runs `pnpm audit --json` in lockfile-only mode and normalizes every advisory (id, package, vulnerable range, installed versions, severity, patched range, dependency paths with a prod/dev marker);
- fetches the repo's Dependabot alerts via `gh api` with complete pagination and merges them by GHSA id — BOTH sources are required: if either fails or alert access is disabled, the collector fails visibly rather than silently narrowing coverage to one feed;
- emits the charter's per-PACKAGE ticket fingerprint (`fingerprint`) on every advisory, plus the pre-rule per-advisory shape as `legacyFingerprint` (for folding old tickets in the sweep), and a sorted `watchedSetHash` over the advisory triples;
- distinguishes an empty advisory set (healthy, hash of empty) from a failed collection (exit 1) — the two are never conflated.

Treat collector output as the surface, not the verdict: the collector proves version-range membership; reachability and routing are yours.

When the `watchedSetHash` matches the prior checkpoint and no reopened Vigil ticket needs attention, append the NOOP checkpoint and exit.

For a dry-run or audit request, stop after reporting the would-be routings. Make no writes.

## Verify and route

1. For each NEW advisory, apply the charter's verification: dependency paths (dev-only vs shipped surface), plausible reachability in this local-first architecture, patched-version availability inside the current range. Read the actual dependent code paths before claiming reachability either way — never infer from the advisory text alone.
2. Search Linear for the exact package `fingerprint` before any write, with complete pagination — one ticket per package, its body listing every advisory id, severity label = max across them. Update an open match rather than filing a twin. Also search the advisory's `legacyFingerprint`: a pre-rule per-advisory ticket found open is folded into the package ticket per the charter's LEGACY CONSOLIDATION rule.
3. Route per the charter: patchable-not-exploitable → Quartermaster-territory ticket (optionally noting Forge candidacy — the human applies `agent-ready`, never you); plausibly exploitable → DISCLOSURE RULE (public ticket carries only advisory id, package, severity; full analysis through Sentinel's private channel; `needs-human`); pinned-by-doctrine package → always `needs-human`; false positive → state-issue reasoning only, no ticket.
4. Sweep open Vigil tickets per the charter's closure rules: strike resolved advisories from the package ticket's body (citing the resolving lockfile commit), relabel down when the remaining max severity drops, and close only when the LAST advisory clears. A human-commented ticket is never closed by you.

Read before every Linear write and re-read after it. Surface partial writes immediately.

## Checkpoint and finish

Append exactly one protocol-shaped checkpoint whose watermark is the collector's `watchedSetHash`. Never edit the state description or prior comments. Checkpoint BLOCKED when audit execution, alert-feed access, pagination, or lockfile identity cannot be proven — a Vigil that silently saw only half the feed is worse than one that visibly stopped.

Durable observations go through pending-learnings (Vigil has no PR authority). Finish by verifying tickets, checkpoint, and automation memory agree; record UTC timing, watermark, routing counts, and the exact next action when an Automation ID is present. Report NOOP as success.
