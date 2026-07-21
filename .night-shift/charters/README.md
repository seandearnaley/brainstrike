# Night Shift charters

Reference copies of the scheduled-maintainer prompts. The scheduler holds the
deployed copy; this directory is the reviewable source of truth. Each charter
is a thin identity (name, scope, stop conditions) — the shared machinery lives
in [../PROTOCOL.md](../PROTOCOL.md), which every loop reads at wake, so fleet
doctrine upgrades are one PR here instead of N scheduler edits.

Fleet design doc: "The Night Shift" (16-loop survey, tiers, guardrails).

## Roster

| charter | role | schedule (UTC) | autonomy |
| --- | --- | --- | --- |
| [axiom](axiom.md) | invariant maintainer — codifies unscripted invariants into guards | `23 6 * * 1` | propose-pr |
| [scribe](scribe.md) | docs-as-contracts freshness auditor | `37 6 * * 1` | propose-pr |
| [ledger](ledger.md) | migration-runner parity clerk | `51 6 * * 1` | propose-pr (registration lines only) |
| [warden](warden.md) | guard-script meta-health monitor | `17 7 * * 1` | propose-pr |
| [watch](watch.md) | flake investigator | `13 10 * * *` | diagnose-only |
| [pruner](pruner.md) | dead-code burndown | `19 5 * * 2` | propose-pr |
| [quartermaster](quartermaster.md) | landmine-aware dependency triage | `43 5 * * 2` | propose-pr |
| [sweep](sweep.md) | nightly-noise janitor | `57 10 * * *` | auto-close tickets |
| [assay](assay.md) | PR risk grader & review-queue triage | `11 */2 * * *` | annotate-only |
| [magnify](magnify.md) | adversarial deep reviewer (risk-3/4 PRs) | `41 */4 * * *` | comment-only |
| [bolt](bolt.md) | performance maintainer (migrated, charter v3) | `29 8 * * *` | propose-pr |
| [sentinel](sentinel.md) | security maintainer (migrated, charter v2) | `07 4 * * *` | propose-pr / private-escalate |
| [palette](palette.md) | accessibility & UI-consistency maintainer (migrated, charter v2) | `33 7 * * 3` | propose-pr |

## Deployment notes

- Cadences are pre-staggered (offset-minute house style). Monday's chain
  composes: axiom → scribe → ledger → warden each benefit from the previous
  one's output landing first.
- First run of each loop has an empty watermark — expect a bigger initial
  sweep; consider temporarily doubling budgets.
- One-PR-per-loop plus distinct territories should prevent collisions; the
  likeliest pair is pruner/quartermaster (24 minutes apart on Tuesdays). If
  the scheduler runs them concurrently, quartermaster skips any package
  pruner has an open PR against.
- Assay owns the `review/*` label namespace; magnify owns findings comments;
  neither may approve, block, or merge — a bot that gates merges rebuilds the
  CI planner this repo explicitly retired (docs/agents/ci-quality.md).
- Wave 2 (once these are stable): bolt watermark/fingerprint retrofit, the
  Librarian (consolidates pending-learnings + bulletin), the perf-creep
  tracker (needs its bootstrap PR uploading metrics from successful
  performance.yml runs first).
