# ADR-0004: Bounded scheduled repository-maintenance routines

- **Status:** Accepted
- **Date:** 2026-08-14
- **Related:** ADR-0001, `docs/agents/ci-quality.md`,
  `docs/agents/database.md`, `docs/agents/assistant-providers.md`

## Context

BrainStrike benefits from recurring maintenance work, but its previous Night
Shift fleet was not proportionate to its yield. PR #2177 recorded roughly 1,250
scheduled wakes per day for 27 lifetime merged PRs before consolidating 21 loops
to 12. PR #2311 later removed the remaining `.night-shift` and
`.agents/skills/*-automation` system because its charters, checkpoints, planner,
and generated coordination surfaces had become maintenance work themselves.

The useful pattern is narrower: a small routine observes one evidence source,
performs bounded deterministic analysis, and either emits no change, a report,
or one reviewable proposal. The scheduler must not become a second CI planner or
an autonomous maintainer fleet.

Model-catalog maintenance needs additional care. PR #1921 used OpenRouter data
to add models, while PR #2013 later corrected an invalid context/output limit
and an unsupported reasoning-control declaration. An aggregator can establish
gateway route availability and gateway pricing; it cannot establish
vendor-owned capabilities.

## Decision

Ship five independently scheduled repository-maintenance routines behind one
shared fail-closed policy layer:

1. **Model Catalog Updater** — scans official provider sources every weekday,
   validates field-level provenance, and reports catalog differences. After its
   shadow period, only complete additive, disabled-by-default entries may be
   proposed as PRs. Removals, renames, new providers, defaults, SDK changes, and
   incomplete controls remain reports.
2. **CI Flake Investigator** — classifies qualifying CI failures and preserves
   the first failure. It distinguishes nondeterminism from stale-head
   cancellation, infrastructure failure, and deterministic assertion failure.
3. **Contract Drift Guardian** — runs existing executable repository contracts
   and reports deterministic drift. It does not build a generalized analyzer.
4. **Deterministic Boundary Crash Fuzzer** — sends seeded synthetic hostile
   inputs to a rotating allowlist of parser, containment, projection,
   serialization, persisted-row, and SQL-admission boundaries. It never reads a
   private user workspace.
5. **Mutation Gap Hardener** — rotates through existing Stryker configurations
   and identifies one high-value surviving validation or control-flow mutant.
   After calibration, it may propose a tests-only change that kills that mutant.

Each routine has one thin GitHub Actions workflow and one reviewed Node entry
point under `scripts/agent-routines/`. Shared helpers may freeze the base SHA,
validate policy, isolate a worktree, deduplicate active PRs, and format a result.
There is no fleet-wide scheduler, generated registry, routing-label system,
checkpoint tree, bulletin, doctrine, or routine that watches other routines.

## Autonomy classes

The shared policy recognizes only these classes:

- `observe`: read repository and public evidence; emit a terminal result.
- `report`: publish a workflow summary or short-retention diagnostic artifact.
- `propose-pr`: create at most one branch and one PR after all deterministic
  admission checks pass.

No routine may merge, enable auto-merge, force-push, deploy, write directly to
`main`, weaken tests or quality thresholds, close another author's issue or PR,
or expand its own file/command allowlist. A model cannot alter the policy that
constrains it.

Scheduled runs launch in `observe`/`report` mode. Write privileges graduate by
routine and evidence class; they are not granted to the fleet as a whole.
Human review and fresh explicit merge authorization remain mandatory for every
proposal.

## Deterministic run contract

Every run freezes one fetched `origin/main` SHA before analysis. A mutating run
uses a new isolated worktree and fails if the base moves in a way that
invalidates its assumptions. It must fail closed when GitHub state, evidence,
source payloads, or required checks cannot be read.

Each run emits exactly one final JSON result:

```ts
type RoutineResult =
  | { status: 'no-change'; baseSha: string; fingerprint: string }
  | {
      status: 'report';
      baseSha: string;
      fingerprint: string;
      summary: string;
    }
  | {
      status: 'proposed-pr';
      baseSha: string;
      headSha: string;
      prUrl: string;
      fingerprint: string;
    }
  | {
      status: 'blocked';
      baseSha: string;
      fingerprint: string;
      reasons: readonly string[];
    };
```

Fingerprints suppress duplicate active proposals. There are no committed
checkpoint or evidence-ledger files. Raw diagnostics may use a short-retention
workflow artifact when a workflow summary is insufficient; that artifact is
not a CI proof or source of truth.

## Model evidence contract

Model fields carry their own provenance: source URL, source kind, retrieval
time, and a quote or JSON pointer that resolves inside the captured payload.
The source hierarchy is:

1. official vendor model documentation/model cards/release notes;
2. official provider model-list API;
3. OpenRouter API/docs for its route, gateway limits, and gateway pricing;
4. installed SDK/provider documentation for request-boundary compatibility;
5. news feeds as discovery leads only.

Vendor documentation is required for context, vision, output limits, reasoning
controls, native tool-search behavior, tokenizer claims, and direct-provider
pricing. Unknown required fields block; they are never inferred from a model
name or another model in the same family. OpenRouter metadata cannot establish
vendor reasoning controls.

An additive catalog proposal must preserve the static-literal
`PROVIDER_DEFINITIONS` contract, update both migration runners, preserve user
`is_enabled` choices on conflict, add automated rows disabled by default,
include a faithful down migration, and pass the existing catalog migration and
PGlite tests. Migration collisions cause regeneration, not silent reuse.

## Workflow security

Collection jobs use read-only permissions:

```yaml
permissions:
  contents: read
  pull-requests: read
  actions: read
```

Only a separate admitted proposal job may receive `contents: write` and
`pull-requests: write`. Workflows do not use `pull_request_target`. They do not
receive deployment, package, security-event, OIDC, issue-write, or actions-write
permissions unless a later ADR justifies a concrete need.

The synthetic fuzzer uses repository fixtures only. Real-app crash collection
is out of scope until opt-in, redaction, retention, and workspace-source privacy
contracts are approved.

## Rollout and sunset

For the first two scheduled weeks all five routines are report-only. Safe
additive model proposals may graduate first. Deterministic contract fixes and
tests-only fuzzer/mutation proposals require demonstrated classification
precision. The flake investigator remains report-only until repeated reports
show that it distinguishes flakes from infrastructure and deterministic
failures.

Each routine records wakes, no-change rate, reports, proposals, acceptance,
human edits, blocked/reverted proposals, duplicates, cost, and estimated
maintainer time saved using live workflow/PR metadata—not committed state.

Hermes owns the calibration loop. Before promotion it evaluates shadow reports
against historical fixtures and live repository state, labels every finding as
correct/actionable, duplicate/noise, ambiguous, or unsafe, and reruns the
routine after each bounded adjustment. Automatic tuning may tighten evidence
rules, add deterministic suppressions for proved duplicates, reduce cadence or
sampling, and improve report grouping/rendering. It may not loosen safety
requirements, broaden file or command allowlists, hide validator failures,
change production semantics, or promote a routine based only on that routine's
own unevaluated output.

Promotion is per routine and fail-closed. Missing or unreadable evaluation data
blocks it. A routine needs a routine-specific minimum evaluated sample, no
critical unsafe finding, reproducible output, acceptable duplicate/noise rate,
and demonstrated precision before `propose-pr` becomes reachable. Promotion is
reversible when later results cross a pause threshold.

- Pause after two blocked or reverted proposals in five.
- Pause below 25% acceptance after eight proposals.
- Reduce cadence above 95% no-change after 20 wakes.
- Add no sixth routine until all five have four weeks of scorecard data.
- Keep fleet-internal maintenance below 10% of merged routine PRs.

## Consequences

- Repository maintenance lives in GitHub Actions and reviewed scripts, not the
  desktop database scheduler.
- ADR-0001 still applies: do not import `@mastra/core/harness`, `mastracode`, or
  `@mastra/libsql` to run these routines.
- The first release intentionally produces reports more often than patches.
  Missing evidence is a visible blocked result, not a silent fallback.
- Broad dead-code deletion, test pruning, abstraction campaigns, real-app crash
  collection, dependency-major updates, and autonomous security fixes remain
  outside this five-routine pilot.
