# Night Shift charters

Committed scheduled-maintainer prompts. The `.night-shift` dot-directory is
intentional: these are repository-internal operating files, not user-facing
product docs. Git tracks them normally, and the dot prefix does not prevent a
scheduled task from reading them.

The scheduler stores a thin reference such as
`Read and execute .night-shift/charters/assay.md.` and therefore must run from
a checkout containing these committed paths. Each charter is the reviewable
source of truth for behavior (name, scope, and stop conditions), while its
`MODEL` and `REASONING_EFFORT` fields mirror the live scheduler settings for
auditability. Changing those two fields here does not reconfigure the
scheduler; deployment must keep both surfaces in sync. Shared machinery lives
in [../PROTOCOL.md](../PROTOCOL.md), which every loop reads at wake, so fleet
doctrine upgrades are one PR here instead of N scheduler edits.

Fleet design doc: "The Night Shift" (16-loop survey, tiers, guardrails).

Every loop has a matching execution skill at `.agents/skills/<name>-automation/`
(deterministic evidence collectors + step ordering; see PROTOCOL.md
"Execution skills" for the authority ordering). PR-authoring loops share
`.agents/skills/brainstrike-pr-loop/` for stewardship mechanics, and every
loop shares `.agents/skills/night-shift-checkpoint/` (the executable
checkpoint-grammar validator; run it before posting any checkpoint).

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
| [librarian](librarian.md) | learnings consolidator & bulletin curator | `31 8 * * 1` | propose-pr |
| [curator](curator.md) | model-catalog freshness scout | `19 6 * * 2,5` | propose-pr (additive catalog data only) |
| [chronicle](chronicle.md) | shift-report writer & fleet meta-monitor | `47 11 * * *` | report-only |
| [forge](forge.md) | small-ticket implementer (label-gated) | `23 3 * * *` | propose-pr (one `agent-ready` ticket max) |
| [vigil](vigil.md) | security-advisory watcher | `27 9 * * *` | tickets-only |
| [gauntlet](gauntlet.md) | agent-behavior eval curator | `43 6 * * 4` | propose-pr (eval flows + fixtures only) |
| [porter](porter.md) | low-risk merge executor (authority-ratcheted) | `53 */2 * * *` | merge (L1: night-shift risk-1 PRs only) |
| [auditor](auditor.md) | outcome scoreboard & promotion proposer | `43 9 * * 1` | report-only (proposal tickets) |

## Deployment notes

- PR stewardship (PROTOCOL.md) applies to every PR-authoring loop: at wake,
  an open PR is reconciled — checks + review threads — before any new work;
  every comment gets a reply, threads are resolved via gh once addressed,
  and out-of-scope feedback becomes a linked Linear ticket. Bolt's charter
  adds its reviewer-subagent specifics on top of this baseline.

- STEWARD WAKES (PROTOCOL.md "PR stewardship"). Discovery cadence and
  stewardship cadence are decoupled: every PR-authoring loop also gets a
  steward-only scheduled task so review comments and check failures that
  land after a wake's opening burst are answered within hours, not at the
  next weekly discovery wake. Scheduler prompt shape:
  `STEWARD WAKE for <Name>: read .night-shift/PROTOCOL.md (PR stewardship,
  steward-wake rules) and .night-shift/charters/<name>.md, then reconcile
  your open PR only.` All run at hours 0,6,12,18 UTC with offset minutes;
  the protocol's newest-checkpoint-vs-budget guard prevents overlap with a
  still-running discovery wake:

  | loop | steward cron (UTC) |
  | --- | --- |
  | axiom | `3 0,6,12,18 * * *` |
  | curator | `5 0,6,12,18 * * *` |
  | scribe | `9 0,6,12,18 * * *` |
  | forge | `11 0,6,12,18 * * *` |
  | ledger | `15 0,6,12,18 * * *` |
  | gauntlet | `17 0,6,12,18 * * *` |
  | warden | `21 0,6,12,18 * * *` |
  | pruner | `27 0,6,12,18 * * *` |
  | quartermaster | `33 0,6,12,18 * * *` |
  | bolt | `39 0,6,12,18 * * *` |
  | sentinel | `45 0,6,12,18 * * *` |
  | palette | `51 0,6,12,18 * * *` |
  | librarian | `57 0,6,12,18 * * *` |

- Cadences are pre-staggered (offset-minute house style). Monday's chain
  composes: axiom → scribe → ledger → warden each benefit from the previous
  one's output landing first. If the scheduler ever supports
  trigger-on-completion, chain them on completion instead of clock offsets —
  a loop that overruns its budget currently degrades the chain to
  independent runs silently.
- First run of each loop has an empty watermark — expect a bigger initial
  sweep; consider temporarily doubling budgets.
- One-PR-per-loop plus distinct territories should prevent collisions; the
  likeliest pair is pruner/quartermaster (24 minutes apart on Tuesdays). If
  the scheduler runs them concurrently, quartermaster skips any package
  pruner has an open PR against.
- Assay owns the `review/*` label namespace; magnify owns findings comments;
  neither may approve, block, or merge — a bot that gates merges rebuilds the
  CI planner this repo explicitly retired (docs/agents/ci-quality.md).
- Wave 4 shipped: Porter (the fleet's ONLY merge authority — executes
  merges already mechanically proven: risk-1 grade fresh for the exact
  HEAD, zero unresolved threads, every required context individually green
  on that HEAD, READY checkpoint, 2h cooling, no dependent PRs; one merge
  per wake; kill switches = committed `.night-shift/HOLD` + `review/hold`
  label + self-tripping breaker that only a human `porter: clear` comment
  resets). Porter does not rebuild the retired CI planner: it gates
  nothing and blocks no one — humans merge anything at any time; Porter
  only executes merges whose conditions are already proven. Its authority
  ladder (L0 shadow → L1 fleet risk-1 → L2 human opt-in → L3 risk-2)
  lives in its charter; every lift is a human-merged charter PR, proposed
  by Auditor with evidence, never self-applied. And Auditor (weekly
  outcome scoreboard per loop keyed by CHARTER_VERSION — merge precision,
  revert traces, finding acceptance, response latencies — plus
  threshold-gated promotion/demotion proposal tickets; the evidence
  engine that makes capability lifts measured instead of vibes).
- Wave 2 shipped: the Librarian (consolidates pending-learnings + bulletin),
  Curator (model-catalog freshness — the only loop with propose-pr authority
  over catalog-data migrations, and even then additive-only), and Chronicle
  (daily shift report + fleet meta-monitor; detects missed wakes, missing
  state issues, and stale BLOCKED loops). Chronicle runs last in the daily
  sequence so the digest covers the whole shift.
- Wave 3 shipped: Forge (the backlog consumer — implements ONE Linear ticket
  labeled `agent-ready` per run; the human applies the label, so throughput
  is entirely human-throttled), Vigil (security-advisory watcher: pnpm audit
  + the repo's Dependabot alerts feed vs the lockfile, tickets-only, routes
  patchable→Quartermaster territory and exploitable-in-context→Sentinel's
  private channel), and Gauntlet (observed assistant failures → permanent
  deterministic eval gates with paired control flows). Forge is the first
  loop with generic implementation authority — its eligibility gate (decline
  anything in Assay risk-4 territory, escalate ambiguity) is the safety
  boundary; do not loosen it in charter edits without re-reading the
  risk-factor list in assay.md.
- Each loop has a matching helper skill in `.agents/skills/<name>-automation`
  with a deterministic read-only collector; collector tests run in the Static
  lane via the root `test:scripts` script. Declared exceptions with no
  bundled collector: palette, quartermaster, sweep, forge, auditor
  (evidence surface is Linear + gh directly).
- Remaining backlog: the perf-creep tracker (needs its bootstrap PR uploading
  metrics from successful performance.yml runs first), Recall Bench (needs a
  committed fixture corpus + baseline recall@k metrics first), Cartographer
  (drafts contract docs for undocumented subsystems; deferred until the
  Librarian has accumulated a few weeks of fleet data), and the remaining
  meta tier:
  - Constitutional loop: monthly, reads all checkpoints/anomalies/bulletin
    and drafts ONE PROTOCOL.md amendment PR with fleet-history evidence.
    Kept separate from Chronicle so the monitor never grades its own
    homework.
  - Two-phase wake economics: Assay (2h) and Magnify (4h) mostly NOOP on
    opus-class models; a deterministic cheap probe (collector + watermark
    compare) should gate whether the expensive model wakes at all.
  - Event-driven steward triggers: a workflow on pull_request_review /
    check_suite events for night-shift/* branches pinging the scheduler,
    replacing polling steward wakes. Must never create a check run
    (required-check masking, docs/agents/ci-quality.md) — trigger only.
  - Shared evidence bakery: one nightly workflow publishing knip/doctor/
    dependency-report artifacts that pruner/quartermaster/watch collectors
    consume instead of re-running full scans per loop. Reconcile with the
    ci-quality "no generated proof artifacts" ruling before building.
