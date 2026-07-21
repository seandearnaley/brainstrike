---
name: scribe-automation
description: Run Brainstrike's Scribe docs-as-contracts audit. Use when asked to execute the Scribe charter, audit docs/agents contracts for factual drift, generate a contract freshness manifest, or prepare the single Scribe PR.
---

# Scribe Automation

Use this skill as a thin executor. Treat the repository's live charter and
protocol as authoritative; do not copy their policy into a generated report or
silently weaken their gates.

## Workflow

1. Read `.night-shift/charters/scribe.md`, `.night-shift/PROTOCOL.md`, every
   `.night-shift/*.md`, and the automation memory. Read each relevant
   `docs/agents` contract before editing it.
2. Fetch `origin/main`. Resolve the previous Scribe watermark and open Scribe
   PRs/state issue before deciding whether the cheap NOOP path applies.
3. Run the collector against the exact revision being audited:

   ```sh
   node <skill-dir>/scripts/collect-scribe-references.mjs \
     --repo "$PWD" --revision origin/main --format summary
   ```

   Use `--format json` for the complete, line-numbered manifest and
   `--format markdown` for a deterministic mechanical-scan table. Do not use
   the markdown output as the charter's final freshness report until all
   manual classifications are complete.
4. Verify every flagged and ambiguous reference against code and its stated
   test lane. The collector proves only mechanical facts; it does not settle
   symbol ownership, prose semantics, rationale, or code/test disagreement.
5. Follow the charter's truth ordering exactly. File deduplicated Linear
   tickets for conflicts or dangling invariants; make only minimal factual
   corrections. Never revise settled rulings or text marked "do not
   relitigate".
6. Generate `docs/agents/_freshness-report.md` in deterministic document
   order, run each changed contract's paired tests and `pnpm test:scripts`,
   then re-run the collector for edited contracts.
7. Before remote writes, re-fetch `origin/main`; if it moved, re-collect.
   Create at most one PR, cite code locations in its body, append the exact
   checkpoint to the Scribe state issue, and update automation memory.

## Collector boundaries

- Treat `DANGLING` as a lead, not permission to rename a reference. Confirm
  whether the invariant was intentionally deleted before acting.
- Treat `MANUAL` as required human/agent verification, never as ACCURATE.
- The manifest mechanizes only existence: project paths, migration numbers,
  package-script names, and backticked file references (root files included).
  It does NOT settle symbol ownership, constant-value drift, paired-test
  discovery, or prose semantics — the charter's RENAMED / VALUE-DRIFT
  outcomes are your judgment, and most references land `MANUAL` by design.
  A missing bare filename is `MANUAL`, not `DANGLING`: contracts cite
  filenames as examples and contrasts, so absence is a lead, not a defect.
- Keep the collector dependency-free and run it through `node`; it reads Git
  objects at the selected revision and makes no repository changes.
- Fail visibly on an unreadable revision, missing repository, or empty
  contract set.
