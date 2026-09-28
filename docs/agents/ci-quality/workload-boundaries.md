# Workload boundaries — evidence

Supports `docs/agents/ci-quality.md` § "Workload boundaries" (and the
"PR CI FLOW" rules list that closed it). Read this before proposing to change
the Unit shard partitions, Turbo affected selection, the Radix menu fixture
teardown, the Test workflow's `pull_request` event types, or the no-planner /
no-routing-label ruling. The contract holds the rules; this file is the record
of the measurements and incidents behind them. Desktop E2E lane ceilings have
their own record in `e2e-lane-timeout-budgets.md`.

## Unit shard partitions, Turbo affected selection, Radix fixture teardown

The September 4 audit found desktop's serial test + integration phases on the
critical path: run `33920421898` spent 8m11s on units and 12m22s on integration;
the other UI integration tasks took seconds. Desktop now owns three native
Vitest file shards on separate runners, independent of the UI `heavy` row.
Each runner retains one fork and no file parallelism; every file still runs,
and the required `Unit` fan-in rejects any failed or missing shard. Local runs
without `DESKTOP_TEST_SHARD` execute the entire suite. The 30-minute job timeout
is a failure ceiling, not a latency target. Aim for a complete PR verdict in
15 minutes; compare queue, setup, unit, integration, and fan-in time separately.

The September 18 Agent audit measured 664 seconds on the prior PR head and 614
seconds on current `main` (`a589a066`, run `35381284576`); on that baseline the
`rest` row spent 720 of its 831 seconds in integration. Agent therefore owns a
dedicated two-runner native Vitest partition and is excluded from `rest`. Each
Agent runner executes its unit phase and uncached integration phase serially,
with one fork and no file parallelism. `AGENT_TEST_SHARD_REQUIRED` makes a
missing or malformed shard identity fail before collection. Both phases inherit
the event-loop watchdog and lost-file reporter from the shared Agent config,
and the required `Unit` fan-in rejects a failure from either Agent shard. Local
runs without `AGENT_TEST_SHARD` continue to execute the complete Agent suite.

Turbo's native `affectedUsingTaskInputs` flag makes `--affected` follow
declared task inputs and dependency edges, intersected with package partition
filters. PR steps set `TURBO_SCM_BASE` to the event's exact base SHA and
`TURBO_SCM_HEAD` to the tested checkout SHA; inferred ranges are forbidden. Cross-package
contract reads belong in the consuming package's task inputs. In particular,
`assistant-providers.md` belongs to MCP lab tests and coverage, not global
inputs. Simply moving that path without task-aware filtering is unsafe: the
old package-only filter misses document-only changes even when the cache hash
is correct. `scripts/__tests__/ci-input-locality.test.mjs` executes the pinned
Turbo binary to prove both selection and hash locality, including a negative
control. Shared configuration and lockfile changes still receive broad checks.

Radix menu fixtures must finish their close/focus lifecycle before React cleanup
and jsdom environment disposal. `git-workbench-header.test.tsx` closes any open
menu with Escape and awaits focus on that menu's labelled trigger in its local
`afterEach`. Radix FocusScope schedules its `onCloseAutoFocus` dispatch on a
zero-delay task; leaving the last menu open lets that callback outlive the DOM
realm and produce an unhandled Event-brand error even when all assertions pass
(observed twice in Unit heavy, PRs #3105 and #3107). The lifecycle regression
deliberately leaves a menu open and observes its trigger focus event from the
real `afterEach` chain, asserting completion in `afterAll`. It fails when the
close hook is removed or runs after RTL cleanup. Keep this ownership local to
the fixture: do not suppress unhandled exceptions, replace Event constructors,
add global sleeps, or discard pending timers to make the suite pass.

The September 28 BST-879 minimatch refresh hit the same failure in
`indexing-status-item.test.tsx` (run `36362962548`, Unit heavy): all 253 files
and 2,789 assertions passed, but an open popover's deferred FocusScope callback
outlived its jsdom realm. That fixture now closes the actual Workspace Index
popover with Escape and awaits its trigger focus in its own `afterEach`.
Its regression leaves the popover open, records the trigger's real focus event,
and checks completion in `afterAll`; without the hook, all 11 test bodies pass
but the lifecycle suite fails. This is a separate fixture fix from the
minimatch dependency resolution.

## Draft-to-ready does not rerun Test; plain workflows, no planner

Draft PRs already run the full Test workflow on opened/synchronize. Marking a
draft ready must not rerun the same code: run `33929271597` repeated successful
run `33927789987` on the same head after PR #2962 became ready. Test therefore
omits `ready_for_review`; reopened remains to cover commits pushed while closed.
Review workflow lifecycle is independent of test execution.

Pull requests use plain GitHub Actions workflows. There is no custom planner,
no generated CI artifact, no CI routing labels, and no local command registry.

Rules:
- Do not add CI **routing** labels. The removed custom planner used labels to
  decide WHICH CI ran; that stays dead. The one permitted label is `coverage`
  (see "Coverage is a separate workflow" below) — an on-demand re-run request
  for an ADVISORY job, not routing, and it can only ever ADD work, never skip
  a required check.
- Do not commit generated CI proof artifacts.
- A pull request touching official MCP conformance must link its workflow-dispatch run URL
  in the pull request body. The URL is the reviewable evidence; a self-reported pass count
  is not a substitute. This is a reviewer-enforced evidence contract, not a custom CI
  planner; required gate ownership is tracked separately by BST-1582.
- Do not reintroduce the removed custom proof/planner commands or any custom
  planner script.
- Required PR checks should be the always-present checks from `.github/workflows/test.yml`.
  As of the Series C R7 split this is exactly: `Static`, `Unit`, `Build`,
  `Web E2E`, `Desktop E2E`. `Coverage` is deliberately NOT required.
- Web and desktop E2E smoke workflows run on every PR.
- Full web and desktop E2E regression runs on `schedule` or explicit
  `workflow_dispatch`.
- Pushes to `main` run static, unit, build, web smoke, and desktop smoke. A
  failing static/unit/build verdict there opens a `main-broken` tracking issue,
  and the next all-green push closes it — see "A red `main` announces itself"
  below.

## Desktop E2E `workflow_dispatch` suite choice

This paragraph sat under "Open PR to Linear conformance" in the original; it
describes `.github/workflows/desktop-e2e.yml`.

Desktop `workflow_dispatch` exposes a `suite` choice. `full` preserves the
scheduled workflow exactly. `memory-baseline` skips the unrelated broad
regression job and runs only the desktop embedding-worker and database
live-query memory specs with one worker, no retries, and no max-failure
truncation. Use the narrow mode for controlled, sequential same-head memory
calibration runs; it is evidence collection, not a way to replace or route
required PR checks.
