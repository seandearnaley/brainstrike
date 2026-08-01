# Night Shift charters

Committed scheduled-maintainer prompts. The `.night-shift` dot-directory is
intentional: these are repository-internal operating files, not user-facing
product docs. Git tracks them normally, and the dot prefix does not prevent a
scheduled task from reading them.

The scheduler stores a thin reference such as
`Read and execute .night-shift/charters/keeper.md.` and therefore must run
from a checkout containing these committed paths. Each charter is the
reviewable source of truth for behavior (name, scope, and stop conditions),
while its `MODEL` and `REASONING_EFFORT` fields mirror the live scheduler
settings for auditability. Changing those two fields here does not
reconfigure the scheduler; deployment must keep both surfaces in sync.
Shared machinery lives in [../PROTOCOL.md](../PROTOCOL.md), which every loop
reads at wake, so fleet doctrine upgrades are one PR here instead of N
scheduler edits.

Fleet design docs: "The Night Shift" (original 16-loop survey), and the
2026-08-01 fleet-graph renovation (21 loops → 12 by same-surface merges;
findings: ~1,250 scheduled wakes/day for 27 lifetime merged PRs, ~60 of ~160
fleet tickets were fleet-about-fleet, and four loops spent model wakes on
deterministic arithmetic).

Execution skills: each loop names the `.agents/skills/*` collectors it uses
in its charter. Consolidated loops inherit their predecessors' skill
directories (watchman → watch-automation; reviewer → assay-automation +
magnify-automation; overseer → chronicle-automation; keeper →
axiom/warden/ledger-automation; editor → scribe/librarian-automation;
groundskeeper → pruner/quartermaster-automation; sentinel additionally →
vigil-automation). Collector tests run in the Static lane via the root
`test:scripts` script. PR-authoring loops share
`.agents/skills/brainstrike-pr-loop/`, and every loop shares
`.agents/skills/night-shift-checkpoint/` — checkpoints are COMPOSED with its
`compose-checkpoint.mjs` (which validates before printing), never
hand-written; the first scored week measured 38 of 88 Assay checkpoints
malformed under hand composition.

## Roster

| charter | role | schedule (scheduler-local) | autonomy |
| --- | --- | --- | --- |
| [forge](forge.md) | small-ticket implementer (label-gated) | `23 3 * * *` | propose-pr (one `agent-ready` ticket max) |
| [sentinel](sentinel.md) | security maintainer + advisory judgment | `07 4 * * *` | propose-pr / private-escalate / advisory tickets |
| [bolt](bolt.md) | performance maintainer | `29 8 * * *` | propose-pr |
| [watchman](watchman.md) | nightly QA: flake investigator + ticket janitor | `57 10 * * *` | diagnose + auto-close tickets |
| [reviewer](reviewer.md) | grades every PR, deep-reviews risk-3/4 | `11 */2 * * *` | annotate + comment only |
| [porter](porter.md) | low-risk merge executor (authority-ratcheted) | `53 */2 * * *` | merge (L1: night-shift risk-1 PRs only) |
| [keeper](keeper.md) | invariants → guards, guard-net health, migration parity | `23 6 * * 1` | propose-pr (guards + registration lines only) |
| [editor](editor.md) | doc truth + learnings consolidation + bulletin | `17 7 * * 1` | propose-pr (facts + mechanical edits only) |
| [overseer](overseer.md) | digest, anomalies, scoreboard, felt budget | `43 9 * * 1,4` | report-only (Thu = health wake) |
| [groundskeeper](groundskeeper.md) | dead code + dependency currency | `19 5 * * 2` | propose-pr, one PR |
| [curator](curator.md) | model-catalog freshness scout | `19 6 * * 2,5` | propose-pr (additive catalog data only) |
| [gauntlet](gauntlet.md) | agent-behavior eval curator | `43 6 * * 4` (acts first Thursday/month) | propose-pr (eval flows + fixtures only) |

Retired by the 2026-08-01 renovation, with their coverage preserved:
watch + sweep → watchman; assay + magnify → reviewer; chronicle + auditor →
overseer; axiom + warden + ledger → keeper; scribe + librarian → editor;
pruner + quartermaster → groundskeeper; vigil → sentinel Beat 0. Palette
retired outright — its mission recurs as a quarterly `agent-ready`
accessibility-sweep ticket that Overseer nominates and Forge implements.
Old `[automation-state]` issues for retired loops stay as historical record;
new loops create their own on first wake (create-if-missing).

## Deployment notes

- TIMEZONES. Two clocks exist and they are NOT the same:
  - SCHEDULE crons (this README and every charter meta block) execute on
    the scheduler client's LOCAL clock: **America/New_York** (verified
    2026-07-25 — observed wakes sit at a consistent DST offset from a UTC
    reading of the same cron). Cron values are local wall-clock times.
  - Everything the loops WRITE — checkpoint timestamps, watermark
    evidence, ticket bodies — is always UTC (the checkpoint grammar
    enforces the trailing `Z`).
  Expected-wake arithmetic (Overseer) must therefore evaluate crons in the
  scheduler timezone, never raw UTC: pass
  `--schedule-timezone America/New_York` to the chronicle collector. A UTC
  evaluation misses/misplaces every wake by the DST offset and files false
  MISSED-WAKE anomalies. If the scheduler host's timezone ever changes,
  update this bullet — it is the fleet's single declared source of truth
  for the scheduler clock.

- RENOVATION DEPLOYMENT CHECKLIST (2026-08-01). Charters mirror the
  scheduler; landing this file does not reconfigure it. The scheduler edit
  that must land with this PR:
  1. DELETE the scheduled tasks for: watch, sweep, assay, magnify,
     chronicle, auditor, axiom, warden, ledger, scribe, librarian, pruner,
     quartermaster, vigil, palette.
  2. CREATE tasks for: watchman (`57 10 * * *`), reviewer (`11 */2 * * *`),
     overseer (`43 9 * * 1,4`), keeper (`23 6 * * 1`), editor
     (`17 7 * * 1`), groundskeeper (`19 5 * * 2`), each with the thin
     `Read and execute .night-shift/charters/<name>.md.` prompt and the
     charter's MODEL / REASONING_EFFORT.
  3. REPLACE the 13 steward-wake tasks with the 8 below (30-minute
     cadence).
  4. Leave bolt, sentinel, forge, curator, porter, gauntlet discovery
     tasks unchanged (gauntlet's monthly gating is in-charter).

- RUN BOUNDARIES (PROTOCOL.md). One wake = one frozen watched set = one
  checkpoint. Added after the fleet demonstrated both failure modes: Assay
  posted four checkpoints in four minutes on 2026-07-25, each superseding
  the last because a PR head moved mid-run, and the daily digest scored the
  day "20/12 expected checkpoints" as a result. Loops that post a
  correction line must pass `--posted-this-run` to the checkpoint
  composer/validator, which rejects a second line that does not declare
  what it corrects.

- PR stewardship (PROTOCOL.md) applies to every PR-authoring loop: at wake,
  an open PR is reconciled — checks + review threads — before any new work;
  every comment gets a reply, threads are resolved via gh once addressed,
  and out-of-scope feedback becomes a linked Linear ticket.

- STEWARD WAKES (PROTOCOL.md "PR stewardship"). Discovery cadence and
  stewardship cadence are decoupled: every PR-authoring loop also gets a
  steward-only scheduled task so review comments and check failures are
  answered promptly. Scheduler prompt shape:
  `STEWARD WAKE for <Name>: read .night-shift/PROTOCOL.md (PR stewardship,
  steward-wake rules) and .night-shift/charters/<name>.md, then reconcile
  your open PR only.`

  Cadence is **every 30 minutes**, offset by loop so the fleet never
  stampedes one minute. The previous 15-minute table polled ~1,250 times a
  day for what was usually zero open PRs; 30 minutes halves that while a
  review comment still waits at most half an hour. The durable replacement
  remains event-driven triggers (see the backlog below) — polling is the
  interim, not the destination. Affordable only because of the protocol's
  steward-wake probe: with no open PR the wake exits on a single
  `gh pr list`.

  | loop | steward cron (scheduler-local) |
  | --- | --- |
  | keeper | `0-59/30 * * * *` |
  | curator | `1-59/30 * * * *` |
  | editor | `2-59/30 * * * *` |
  | forge | `3-59/30 * * * *` |
  | gauntlet | `5-59/30 * * * *` |
  | groundskeeper | `7-59/30 * * * *` |
  | bolt | `9-59/30 * * * *` |
  | sentinel | `10-59/30 * * * *` |

  Each loop owns a distinct minute, firing at that minute plus 30. Minutes
  11–29 stay free for future loops without reshuffling.

- Monday chain: keeper 06:23 → editor 07:17 → overseer 09:43 — each
  benefits from the previous one's output landing first. The coupling is
  clock offsets only; a loop that overruns its budget degrades the chain to
  independent runs silently. If the scheduler ever supports
  trigger-on-completion, chain on completion instead.

- First run of each consolidated loop has an empty watermark — expect a
  bigger initial sweep; consider temporarily doubling budgets.

- CATALOG VERIFICATION (curator.md). Models enter the catalog only with
  per-field official-provider-doc citations AND live smoke-test evidence;
  unverifiable models are tickets. Backfill debt: the rows shipped under
  curator v1 (#1921's nine OpenRouter coding models, #1933's Ling 3.0
  Flash) were never smoke-tested; they need a one-off audit against the v2
  bar.

- FELT-VALUE DOCTRINE (2026-08-01, PROTOCOL.md). Every fleet PR body
  carries a `Felt-by:` line naming who notices the change (or an honest
  `fleet-internal`), FLEET-INTERNAL merges target ≤10% of all repo merges
  over any trailing 7 days (a mix cap — felt output is never throttled),
  and self-churn counts against yield. Overseer measures the share weekly
  under committed operational definitions and proposes demotions on
  sustained breach, and surfaces the tag in SHIPPED lines via the
  collector's `feltBy` field. No authority changes — enforcement moves
  through Overseer proposals and human-merged charter PRs.

- Reviewer owns the `review/*` label namespace; no workflow may ever
  consume a `review/*` label (docs/agents/ci-quality.md) — a bot that
  gates merges rebuilds the CI planner this repo explicitly retired.
  Reviewer's grading phase deliberately gets NO probe in front of its
  work_key cache — "a probe in front of a cache is a second cache"
  (standing ruling, inherited from Assay). Porter remains the fleet's ONLY
  merge authority, with its ladder (L0 shadow → L1 fleet risk-1 → L2 human
  opt-in → L3 risk-2) in its charter; every lift is a human-merged charter
  PR, proposed by Overseer with evidence, never self-applied.

- Remaining backlog:
  - Event-driven steward triggers: a workflow on pull_request_review /
    check_suite events for night-shift/* branches pinging the scheduler,
    replacing polling steward wakes entirely. Must never create a check
    run (required-check masking, docs/agents/ci-quality.md) — trigger
    only. Prerequisite: every EXTERNAL-STATE collector emits a
    `watchedSet` field so an external gate has a uniform hash to compare
    (porter-automation currently does not).
  - Nightly fleet-health script: the chronicle collector already computes
    most anomaly arithmetic deterministically; a scheduled deterministic
    job maintaining one rolling health ticket would let Overseer's
    Thursday health wake retire too.
  - Shared evidence bakery: one nightly workflow publishing knip / doctor
    / dependency-report artifacts that groundskeeper and watchman
    collectors consume instead of re-running full scans per wake.
    Reconcile with the ci-quality "no generated proof artifacts" ruling
    first.
  - Constitutional loop: monthly, reads all checkpoints/anomalies/bulletin
    and drafts ONE PROTOCOL.md amendment PR with fleet-history evidence.
    Kept separate from Overseer so the measurer never amends its own
    doctrine.
  - Cartographer (contract docs for undocumented subsystems), Recall
    Bench (needs a committed fixture corpus + baseline recall@k), and the
    perf-creep tracker (needs its bootstrap metrics-upload PR) — deferred,
    unchanged.
  - Skill-directory consolidation: retired loops' `*-automation`
    directories are inherited by their successors under the old names;
    renaming them to match the new roster is mechanical follow-up.
