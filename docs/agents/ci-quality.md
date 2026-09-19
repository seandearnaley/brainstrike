# CI & Quality Gates: PR Flow, React Doctor

> Extracted from AGENTS.md (2026-07-12). Read before changing workflows, doctor.config.ts, or knip config. Keep updated with the code.

## PR CI FLOW

### Review and CI budget

Before implementation, record the start time, acceptance criteria, actual PR
base chain, and the required checks. Check open and recently merged PRs for an
existing fix. Review completion means every finding has a disposition, not
that every suggestion becomes code in this PR.

- Collect the complete review for one head, classify correctness/contract
  blockers, in-scope changes, follow-ups, and stale findings, then fix the
  in-scope batch and run local checks before one push. Do not push each comment
  separately. Valid adjacent work gets a concrete follow-up under the tracker
  authorization policy; it does not expand the current acceptance criteria.
- Allow an initial whole-PR review and one re-review after the batch. A third
  whole-PR review requires a scope checkpoint and explicit user approval.
  Prefer a targeted review of the fix over restarting whole-diff discovery.
- At 45 minutes, report elapsed time, exact head, remaining blockers, and the
  next stop. At 90 minutes without an exact-head-ready PR layer, stop new
  pushes, reviews, reruns, and merges; preserve work and present a recovery
  plan. This budget applies to the whole delivery, including a stack.
- Keep one CI watcher. Reuse successful evidence for the same tested head/base;
  rerun failed jobs only after identifying an infrastructure failure that makes
  a retry meaningful. A code correction needs a new head and its own checks.
  Do not close/reopen PRs, toggle draft state, or push empty commits to solicit
  another review. Those lifecycle changes can start complete pipelines.
- Read the live ruleset and distinguish required checks from advisory work.
  Coverage is advisory; do not wait for it to finish before declaring the
  required gate ready. Report its current state accurately. Inspect individual
  Unit rows for failures while the aggregate is pending, so remediation does
  not wait behind an unrelated healthy integration row.
- Batch lower-layer fixes before rebasing descendants once. A changing main
  branch alone does not justify repeatedly rebasing a stack; refresh only for
  an actual conflict, required up-to-date protection, or a relevant base change.
  Preserve exact-head/base verification before merge, and existing merge holds.

These rules apply without an installed external skill. The external
`pr-scope-guard` may automate the audit, but is not the only place the delivery
budget is defined. Contract: `scripts/__tests__/engineering-skills-contract.test.mjs`.

### Browser failure traces

The shared browser project writes Playwright traces through
`browser.trace: { mode, tracesDir }`. Vitest does not route these files through
`test.outputDir`: using that field silently leaves traces next to test sources,
outside the Browser job's uploaded `test-results/` directories. Keep local
tracing off by default and CI at `retain-on-failure`; a deliberate failing
browser fixture must produce a readable trace ZIP beneath the configured
artifact directory. Failure screenshots have their separate Vitest attachment
path. Paired contract: `packages/config/__tests__/vitest-browser.test.ts`.

### Workload boundaries

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

An E2E lane's `--global-timeout` is a **failure ceiling, not a latency target**,
and it stops being one silently. Read a lane's budget as a ratio against its
measured runtime, never as an absolute number: the desktop smoke lane's 300000
was calibrated on 2026-05-20 against three files finishing in 28.3s
(`docs/architecture-reset/pipeline-calibration-desktop-smoke-2026-05-20.json`),
a 10x ceiling, and nobody revisited it while the lane grew to 16 files and 34
tests. By 2026-09-09 ten green runs measured 226.5s-278.4s and run
`34353940887` measured 297.5s on a ~7% slower runner — 99.2% of budget. The
deadline landed mid-test and produced a failure that looks like a product bug
and is not one (BST-1713): Playwright marks the in-flight test `interrupted`
(**not** failed), reports two `Timed out waiting Ns for the ...` entries as
"errors not part of any test", and hands teardown the ALREADY-ELAPSED deadline,
so the trace zip is never finalised and the blob reporter raises
`ENOENT ... blob-report/.playwright-artifacts-<n>/<hash>.zip`. The named test is
whichever one was running — with `--workers=1` that is just the last file in
the lane's file list, and the surface it exercises is a red herring. Diagnose
this shape by checking the run's total against its budget FIRST; app shutdown
noise in the same log (git-inventory drain abandonment, `DB host closed.`,
`the worker is ending`) is per-test teardown chatter that also appears in green
runs, and timestamps place it minutes away from the interruption. Raise a
lane's budget when you add work to it, not after the next interruption. The
desktop smoke lane's 900000 ms ceiling (raised from 720000 ms when 43 cases
measured 11.8 minutes on main, Test 34646256371) was being reached again by a
passing suite by 2026-09-15: 47 cases took 722-871 s across 24 green Test runs
(2026-09-12..15), and run `34988958978` interrupted `worktree-mode` at 898 s
with the same missing-artifact shape. BST-1762 split the suite rather than
raising the ceiling a third time. `test:e2e:lane:smoke` (17 specs whose
per-case CI means sum to 337 s) and `test:e2e:lane:smoke-delegated` (the four
`delegated-*` specs, 466 s) run on separate `ubicloud-standard-4` runners,
each with a 900000 ms ceiling inside the unchanged 25-minute job boundary.
Their first run (Test 34997197693) took 367 s and 440 s of Playwright, 41% and
49% of that ceiling, in 496 s and 573 s jobs, so the required check now lands in
under 10 minutes instead of 14-16. A failure in one lane does not cancel the
other (`--max-failures=1` stops only its own lane), so a red PR can spend both
lanes' runner time. The required `Desktop E2E` check is a fan-in over
the `desktop-e2e-smoke` and `desktop-e2e-delegated` jobs, like `Unit` over
`unit-shard`: it carries their condition and fails unless both succeed, so the
ruleset did not change. Moving the delegated specs to nightly regression was
rejected on measurement: that lane had failed its last ten scheduled runs and,
under `--max-failures=1`, left 87-120 cases unrun. Add a smoke spec to the lane
whose measured headroom absorbs it and record the measurement here. Why these
specs run 4.6-9.5x slower on Linux CI than locally, while launch-only specs run
1.6-2.5x slower, is tracked separately by BST-1763. The exact lane commands and
the fan-in are pinned by
`scripts/__tests__/ai-tools-e2e-pr-gate-contract.test.mjs`, which is the guard
that forces the change to be deliberate.

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

### MCP verifier lanes (BST-1495)

The required `Static` job and the default local `pnpm check` plan both invoke
`pnpm run verify:mcp -- --profile pr --output artifacts/pr-evidence.json`.
That representative profile is part of the required PR gate; it is not advisory
and must not gain `continue-on-error`, an event predicate, or a second selection
planner. `.github/workflows/mcp-verification.yml` owns the scheduled and
manual exhaustive lane, using
`pnpm run verify:mcp -- --profile exhaustive --output artifacts/exhaustive-evidence.json`.
The exhaustive job has a ten-minute outer bound, an eight-minute verifier-step
bound, and uploads the exact-SHA sanitized evidence for 14 days. The workflow
also subscribes to pushes to `main` (BST-1582), but the exhaustive `verify` job
is predicated off that event (`if: github.event_name != 'push'`) and must
remain `schedule` plus `workflow_dispatch` only; running it on PRs or pushes
would duplicate the required representative gate. The push trigger exists for
the official conformance jobs below and carries a `paths-ignore` for `docs/**`
and `**/*.md`, because a docs-only merge cannot regress client conformance.

`scripts/run-mcp-verification.mjs` is an identity guard, not a planner. It
derives `HEAD` and porcelain workspace state and under GitHub Actions requires
`GITHUB_SHA` to equal `HEAD` and the checkout to be clean. It then invokes the
one package CLI, which fixes the parent ticket to `BST-1486` and independently
derives the Git identity recorded in evidence. The wrapper accepts exactly one
closed profile and one safe JSON output below `artifacts/`; unknown, duplicate,
or shell-sensitive input fails before platform-specific spawning. The paired script tests control
identity mismatch and dirty-checkout failures; the CI contract test pins the
commands, profile ownership, timeouts, artifact path/retention, and local-check
mapping. Exhaustive artifacts are uploaded only after complete verification;
failed or partial runs never emit an artifact that could be mistaken for proof.
Both automated profiles emit evidence-schema `1.1.0` with desktop applicability
explicitly set to `protocol-lab-only`; they do not fabricate Electron or CDT
proof. Desktop-required bundles remain the bounded implementation-ticket gate
described in `mcp-conformance.md`, outside the scheduled verifier loop.

The same workflow — which runs on every push to `main`, on the nightly
schedule, and on manual dispatch — has a separate `Official MCP auth
conformance` job. It builds the Desktop main-process runtime dependencies
and bundle through the root command.

```bash
pnpm run verify:mcp:official
```

Since BST-1582 the three official jobs (`official_auth`, `official_core`,
`official_modern_auth`) are **required post-merge gates**: none carries
`continue-on-error`, so a single failing scenario fails the workflow and turns
`main` red visibly. "Required" here is deliberately not the ruleset sense used
for `test.yml`'s PR checks — a `push: branches: [main]` job runs after the
merge and can never block one; it detects, it does not block. The entry
condition for promotion was three consecutive exact-head green runs
(33541373505, 33545728828, 33545945643). They deliberately run on `main`
pushes rather than in the PR lane: three Electron-provisioned jobs cost
roughly 30 runner-minutes, and a main-push gate bounds a regression to one
merge instead of 24 hours. The workflow-level `concurrency` group with
`cancel-in-progress: false` serializes overlapping main-push runs rather than
cancelling them, so an intermediate merge commit is never silently skipped.

Exit condition when it goes red: the merge that turned `main` red is fixed
forward or reverted before the next MCP-touching merge, and the failing run
URL is attached to that merge's ticket (working agreements, BST-1590). The
official jobs live outside `test.yml`, so the `notify-main-failure` issue
notifier does not yet cover them; whoever merges checks the workflow run on
their own commit until BST-1591 extends notification to this workflow.

Its combined build/run step has a seven-minute bound and its job an 11-minute
bound (four-minute build, three-minute Electron provisioning, three-minute run,
one minute of workflow overhead). A bounded three-minute "Provision Electron
binary" step runs before the suite: the conformance children execute the desktop
dist entry, which requires the real Electron binary, and Electron has no install
lifecycle — provisioning once prevents parallel children racing an on-demand
download into EEXIST extraction failures. Pinned
`@modelcontextprotocol/conformance@0.2.0-alpha.10` remains prerelease
software, and the evidence records `prerelease: true` alongside
`required: true`. Its runner executes the closed 28-case auth matrix without
`--expected-failures` or `--output-dir`, captures child output through a
bounded line-boundary collector, sanitizes it (ANSI stripped; URL queries,
OAuth parameters, and structured secret assignments redacted), prints a
bounded per-scenario diagnostics block to job stderr for failed scenarios
only, and atomically emits only sanitized fixed-id/timing evidence at
`packages/mcp-test-lab/artifacts/official-auth-evidence.json` — captured
child output never enters the evidence file. The workflow
uploads that file on both green and red scenario outcomes for 14 days under an
exact-SHA artifact name. Missing evidence is a visible job
failure; raw official auth request/response artifacts are never uploaded.
The parent driver provisions and validates Desktop's Electron runtime exactly
once before it launches either parallel protocol wave; scenario processes must
not lazily install the shared runtime concurrently.
Scenario pass/fail counts always sum to the execution count; Job cleanup has its
own status and never inflates scenario failures. If evidence collection or its
atomic write fails after conformance has already failed, the job preserves both
causes rather than replacing the primary conformance failure.

BST-1583 adds the independent required `Official MCP core conformance`
job. It runs the exact alpha.10 non-auth scenarios
applicable to each revision: four at `2025-11-25` and seven at `2026-07-28`.

```bash
pnpm run verify:mcp:official -- --profile core
```

The core job has the same bounded Electron provisioning, parallel-by-protocol
execution, sanitized diagnostics, empty expected-failure ledgers, and 11-minute
job budget as the baseline auth profile. It uploads only
`packages/mcp-test-lab/artifacts/official-core-evidence.json` for 14 days under
`mcp-official-core-${{ github.sha }}`. BST-1582 promoted it, with the two
auth jobs, to a required gate.

BST-1576 adds a second independent job, `Official MCP modern auth closeout`.
It runs:

```bash
pnpm run verify:mcp:official -- --profile modern-closeout
```

The command has a four-minute build allowance, ten-minute runner allowance,
14-minute combined step bound, and 21-minute job bound (which also reserves the
three-minute Electron provisioning step both official jobs share).
The profile executes exactly the eleven alpha.10 scenarios that apply only at
`2026-07-28`, sequentially inside one evidence wave, with zero expected failures.
It uploads only
`packages/mcp-test-lab/artifacts/official-auth-modern-closeout-evidence.json`
for 14 days under `mcp-official-modern-auth-${{ github.sha }}`. The baseline
BST-1560 job remains its reviewed 28 executions; neither job passes
`--expected-failures` or `--output-dir`, and neither uploads raw auth output.
The ten-minute step is load-bearing math: 11 × 45-second scenario deadlines is
495 seconds, leaving 105 seconds for setup, cleanup, and sanitized evidence
persistence. The 21-minute job additionally reserves the four-minute build,
the three-minute Electron provisioning step, and four minutes for workflow
setup/upload. Shared typed descriptors and workflow
contract tests pin these budgets and the required posture of all three
official jobs.

#### MCP 2026 fleet working agreements (BST-1590)

Standing rules for every agent on the MCP 2026 project until BST-1472 closes.
They exist because on 2026-09-01 the same Electron install race was fixed twice
by two agents 44 minutes apart (#2900, #2901), BST-1574 was implemented twice,
roughly 40% of the overnight spend went to rewrite-in-place review loops and
blind iteration against a mute verifier, `assistant-providers.md` was rewritten
by every landing commit, and two epics were marked Done while their product
surface was unreachable. The Linear project description carries the same list.

1. **Dedupe before starting.** Search open PRs and the last 24 hours of merged
   PRs for the same root cause before opening a branch; review an existing fix
   instead of re-fixing it.
2. **WIP limit of 2** on the project until BST-1472 closes; the Tasks
   (BST-1473) and Apps (BST-1474) ladders stay frozen behind the core closeout.
3. **Evidence is a CI artifact URL** at the exact head, linked in the PR body
   and on the ticket. Self-reported test counts are notes, not proof.
4. **Done means reachable.** A host-only deliverable carries an explicit
   "host-only, product surface pending" note and does not close as Done.
5. **PRs only.** No direct-to-main pushes.
6. **One status update per day** on the project: gate state, pass counts,
   blockers.
7. **Doc contention.** Conformance and verification prose lives in
   `docs/agents/mcp-conformance.md`, not in `assistant-providers.md`.

### Open PR to Linear conformance (BST-521)

Every human-authored pull request description must contain a Brainstrike issue
reference in the exact `BST-###` form. A title-only reference is insufficient:
the description is the durable review handoff and should retain either the
identifier or a Linear issue URL containing it. Run `pnpm check:pr-linear` to
inspect every open PR. The command reports each missing PR number, title, URL,
and suggested action, but exits successfully after findings because this is an
advisory rollout; GitHub/API failures and malformed responses fail visibly.
The script is read-only and never comments on or edits PRs. Dependabot and
Renovate PRs are the only exclusions; human maintenance work still requires a
tracker. PRs whose author account has been deleted remain in scope rather than
aborting the audit. `.github/PULL_REQUEST_TEMPLATE.md` prompts authors for the
required reference before they write the summary.

Desktop `workflow_dispatch` exposes a `suite` choice. `full` preserves the
scheduled workflow exactly. `memory-baseline` skips the unrelated broad
regression job and runs only the desktop embedding-worker and database
live-query memory specs with one worker, no retries, and no max-failure
truncation. Use the narrow mode for controlled, sequential same-head memory
calibration runs; it is evidence collection, not a way to replace or route
required PR checks.

### Desktop Electron provisioning (BST-563, BST-1252)

Both Desktop E2E smoke lane jobs in `test.yml` and both regression jobs in
`desktop-e2e.yml` download Electron directly from GitHub Releases and extract
it immediately before launch. Electron 43 declares no install lifecycle;
`install.js` is exposed only as the `install-electron` bin, so `pnpm install`
does not provision the executable or populate `~/.cache/electron`. The former
version lookup and Actions cache steps therefore persisted an unused path. Each
download uses `${RUNNER_TEMP:-/tmp}/electron.zip`; the fallback is required
because a future `container:` job may not define `RUNNER_TEMP`. The paired
`desktop-electron-provisioning-contract.test.mjs` keeps all four sites aligned,
pins the no-lifecycle premise, requires all four jobs to use the shared
`setup-workspace` action, and fails if the unused cache or raw `RUNNER_TEMP`
path returns.

The `Native Electron Package` job has a separate packaging need: its native
smoke launches Electron before electron-builder runs, and electron-builder
otherwise fetches the same release archive again. It now provisions one
`${RUNNER_TEMP:-/tmp}/electron.zip` before either consumer, bounds each transfer
to three minutes, retries transfer errors three times with a visible failure
after exhaustion, verifies the extracted executable is non-empty and runnable,
and passes that same zip to electron-builder through
`config.electronDist`. This keeps one bounded, observable download boundary and
does not restore the obsolete `~/.cache/electron` Actions cache.

That job also owns the packaged MCP core lifecycle proof. The spec carries both
`@packaged` and `@destructive`, and desktop's generic full-regression lane
grep-inverts `@packaged`; an unpackaged regression run must never discover it.
The dependency build includes `@brainstrike/mcp-test-lab`, then the job packages
the desktop once, runs the packaged native-addon checks, and invokes
`test:e2e:lane:packaged-mcp-core` against that existing artifact. The canonical
lane does not build or package. The same job runs
`test:e2e:lane:packaged-mcp-apps-bridge` (`mcp-apps-bridge.desktop.test.ts`,
tagged `@packaged @destructive`, excluded from the generic full-regression
lane) right after packaging; `scripts/__tests__/mcp-apps-bridge-packaged-ci-contract.test.mjs`
pins the step order and the lane script. `test:e2e:mcp-packaged` remains the local
lane does not build or package. The same job packages with
`VITE_MCP_TASK_HARNESS=1` so the E2E-only MCP Tasks harness chunk exists in
THAT package (release packaging never sets it), then runs
`test:e2e:lane:packaged-mcp-tasks` right after packaging (the core lane keeps
its pinned slot immediately after the packaged native checks) (`mcp-task-restart.packaged.desktop.test.ts`,
tagged `@packaged @destructive`, excluded from the generic full-regression lane);
`scripts/__tests__/mcp-tasks-packaged-ci-contract.test.mjs` pins the flag, the
step order, and the lane script. `test:e2e:mcp-packaged` remains the local
developer convenience that builds the lab, packages the app, and delegates to
the same lane. `scripts/__tests__/e2e-lane-coverage.test.mjs` pins the tags,
broad-lane exclusion, canonical delegation, and workflow reachability/order.
The packaged launcher copies only an explicit cross-platform process-environment
allowlist plus test-owned overrides; it never forwards the ambient CI environment.
Its stdio fixtures enforce the exact SDK-default key set expected from that
allowlist, so the packaged proof has no production-environment bypass.

THE CORE LANE'S APPROVAL PROOF AND ITS ERROR PATH (BST-1602). Under the `ask`
MCP policy the proof races two locators — `assistant-tool-approval-notice` and
the scripted completion text — because an approval pause and a final text are
mutually exclusive outcomes of one turn (`agent-streaming`'s pause is terminal
for its leg; see `docs/agents/assistant-runtime.md`). The race is the right
observation; what was wrong was what it did when the WRONG racer won. Two rules
now hold, and both are load-bearing:

- The diagnostic branch never CLICKS. It previously reached for a page-wide
  `getByRole('button', { name: 'Expand details' })` while several tool cards were
  mounted, so the branch that exists to explain a failure produced a
  `locator.click` timeout instead of its own message — and the stalled app then
  failed `closePackagedDesktop` with `code=1` (main's 5 s
  `SIGNAL_SHUTDOWN_TIMEOUT_MS` forced exit), burying the real cause under two
  unrelated errors. A failing proof's error path must resolve immediately: it
  reads text, it does not act.
- Both racers are explicitly `.catch`-handled. The loser keeps waiting out its
  own 45 s budget and then rejects (timeout, or "target closed"), which
  Playwright reports as a second, test-less error. `Promise.race` still settles
  on whichever promise settles first, so "neither appeared" still fails.

The branch dumps three boundaries: `startModelProviderShim`'s `transcript()`
(every decided request — `roles`, `toolResultCount`, and the turn it chose, so
the shim's pure turn accounting is never guesswork), each `tool-fallback` card's
text, and the assistant region. That dump is what distinguishes the two very
different failures that land here. A tool that RAN unprompted would be a
permission-engine defect. What actually reproduces is the other one: when
`legacy_echo` is not in the run's ACTIVE tool definitions at the moment the
model calls it, the call fails fast with a tool RESULT and never reaches the
approval gate at all, so the shim's third turn emits the completion text and
`completed` wins the race. Demonstrated by forcing a `search_tools` miss: the
dump shows `search_tools … 0 results` next to `legacy.echo … Tool execution
failed.`, with no approval notice. In the wild the same state is reachable
because per-run MCP discovery is skip-on-failure — `mcp-tool-loader.ts`'s
`fetchMcpToolsetsWithTimeout` drops the WHOLE toolset after the hard-coded 5 s
`DEFAULT_MCP_TIMEOUT_MS` and `logMcpToolsetErrors` drops a single server's, both
continuing the run, and `pickMcpDiscoveryLogMethod` demotes exactly the two
likeliest reasons (`Connection closed`, `mcp_tool_discovery_timeout`) to
`debug`, which this lane's `LOG_LEVEL=info` does not record. Waiting for the
Settings row to read `Connected` does NOT establish that precondition. Making
that degradation visible is its own change; do not widen this lane to paper
over it.

After packaging, that same `Native Electron Package` job runs
`test:e2e:lane:packaged-mcp-apps`. The tagged `@packaged` spec launches the exact
electron-builder artifact, injects its harness into the REAL main window
(production preload, default session, the production header CSP — never a
harness window on a private partition, which escapes the header stamp and hid
a `frame-src` regression), uses the official MCP Apps transport through the
packaged `brainstrike-mcp-app:` shell protocol, and verifies the production
Apps host: `blob:` frames blocked by the host CSP, shell load + handshake, the
`will-frame-navigate` fence, and a 404 shell URL after release.
`scripts/__tests__/mcp-apps-packaged-ci-contract.test.mjs` pins those
assertions. Production renderer registration remains a separate
release gate. The ordinary unpackaged full-regression lane excludes `@packaged`;
there is no second or advisory path that can make this artifact-dependent proof
appear green.

Desktop renderer working-set snapshots use `app.getAppMetrics()` joined to
each `webContents.getOSProcessId()`. Electron 43 does not expose the older
`webContents.getProcessMemoryInfo()` API on the CI runner; treating that
absence as zero made the large-collection thresholds vacuous. Missing PID
metrics now fail visibly. The older API remains optional only for its private
and shared-memory diagnostics.

Renderer heap readings require `--enable-precise-memory-info` alongside
`--js-flags=--expose-gc` in the E2E launcher: without it Chromium quantizes
`performance.memory.usedJSHeapSize` AND caches it for 20 minutes, so every
in-test read returned the identical value and each "heap growth" was
tautologically `0.0` — the heap ceilings could never bind. The flag is pinned
by `desktop-e2e-harness-contract.test.ts`; the pre-flag calibration tables
(2026-08-11 dispatches `31458099061`/`31458469270`/`31459112520` and the
2026-08-19 head-`07bc230ae` local runs) all showed that dead `0.0` signature.
The flag makes EVERY heap ceiling in the desktop memory suite live at once,
not just the recalibrated tables below. The remaining now-live ceilings were
sampled once locally on 2026-08-19 with comfortable margins: the large-backfill
`retainedGrowthMB < 60` measured `-48.5`/`-48.6`/`-49.1` across three runs, the
20k diagnostic's host-heap growth measured `9.9` MB (limit 120) and main-heap
growth `12.9` MB (limit 80), and the repeated-backfill idle host-heap drift
measured `0.0` MB (limit 40 — a genuine post-GC steady state, not the dead
signature: host heap readings vary at 0.1 MB granularity across the same run).
If a nightly desktop-e2e heap ceiling starts failing after this flag landed,
diagnose it first as calibration of a newly live instrument, not necessarily a
product regression.

The tables below are LOCAL-HOST samples (macOS arm64 dev machine), not
ubuntu-runner CI dispatches like the superseded 2026-08-11 table — do not
compare their absolute values against CI numbers. A confirming
`memory-baseline` dispatch in the CI environment (run `32274868755`, the first
CI execution of the BST-438 tests) measured live heap growth of `1.8` MB in
both live-query scenarios — the 16 MB heap ceilings hold in CI too. That same
dispatch recalibrated the switching test's alive-generation identity bound
from a local-only 6 to 8 (CI held 7 alive with 58/65 collected and zero
drops), and exposed a PRE-EXISTING CI failure unrelated to the flag, since
fixed as BST-1380: the large-backfill error path emitted a WebGPU-refusal
message that
`embedding-worker-renderer.memory.desktop.test.ts` does not expect. Its
correct attribution is recorded below — the Electron 43.4 provisioning window
it coincided with was NOT the cause.

The desktop embedding specs run under `--disable-gpu`, so they only exercise a
real backfill because they configure WASM explicitly. Between 2026-08-12 and
BST-1380 they did not: BST-1235 narrowed the hidden-host preload manifest, the
host lost the capability to read that configured preference, and it fell back
to auto-detection — which fail-closes with no WebGPU adapter. The symptom reads
as an Electron/runner GPU regression and is not one; the last green run
(`31458099061`, 2026-08-11) predates the preload change, and a fixed-Electron
RED/GREEN on one host isolated it. Do not bisect Electron versions for it.
Reproduce on any host by running the spec with `CI=true` (that env var is what
adds `--disable-gpu`): a healthy run reports `outcome: "running"` with a
non-zero `queueStats`, a broken one `outcome: "error"` with
`queued 0 / running 0`. See `docs/agents/local-inference.md` for the capability
contract.

The 50k collection and 50k file-list ceilings are calibrated, not inherited
from the older Collection Browser measurement window. On 2026-08-19, three
sequential local regression runs with precise memory info (head `d4d1af0f2`
plus the flag change) produced:

| Scenario | Visible heap growth (MB) | Visible working-set growth (MB) |
| --- | --- | --- |
| 5k files / 50k chunks | `-8.1`, `-8.4`, `-8.2` | `-1.8`, `-1.4`, `-1.9` |
| 50k-file source-paginated list | `-8.4`, `-8.4`, `-8.4` | `-1.2`, `-2.0`, `-1.7` |

The paired heap and working-set limits remain positive floors of 16 MB
and 32 MB. Those floors preserve at least 16 MB of heap headroom and at least
30 MB of working-set headroom over the largest observed deltas while still
failing a material full-collection hydration. Replace this
table and re-run three sequential same-head samples when changing the fixture,
measurement window, or process-memory source.

BST-438's database live-query limits are calibrated independently from those
50k-list scenarios because its primary signal is forced-GC collection of actual
result-array identities. On 2026-08-19, three sequential local (macOS arm64)
regression runs with precise memory info (head `d4d1af0f2` plus the flag
change) produced:

| Scenario | Visible heap growth (MB) | Visible working-set growth (MB) | Collected / tracked generations |
| --- | --- | --- | --- |
| 100 alternating committed mutations | `1.9`, `1.9`, `1.9` | `-31.7`, `-32.7`, `-31.9` | `100/101`, `100/101`, `100/101` |
| 10 A/B/C switch cycles plus final insert/delete | `1.6`, `1.7`, `1.5` | `13.3`, `12.6`, `13.6` | `60/65`, `60/65`, `60/65` |

The mutation test's midpoint-to-final heap growth was `0.6` MB in all three
runs. An earlier three-run threshold-selection sample at implementation head
`32cd1a46afd97971ceca9d8e96a11abc82b469f0` observed switching working-set
growth of `13.0`, `29.4`, and `11.7` MB, so the 48 MB switch ceiling retains
18.6 MB of headroom over the worst of all six samples. The mutation working-set
ceiling remains 32 MB and both heap ceilings remain the positive 16 MB floor,
now over a real measured heap peak of `1.9` MB (≈8× headroom).
Every final-head run also held the exact renderer/IPC/manager/host ownership
delta, exact one- or three-entry cache cardinalities, zero dropped WeakRef
observations, removal of all named superseded generations, and a live current
generation. Re-run three sequential exact-head samples when changing the
fixture, switch/mutation count, forced-GC window, cache policy, or process-memory
source.

The AI Tools settings specs are deliberately part of both required PR smoke
lanes. Their tool category/loading-tier assertions follow the shared assistant
contract and previously drifted while every PR check stayed green. Web selects
`settings-tools-and-diagnostics.test.ts` through its suite-level `@web-smoke`
tag; desktop requires both the suite-level `@smoke` tag and the explicit
`tools-settings.desktop.test.ts` allowlist entry. Both suites also remain in
nightly regression: the web broad pass includes the suite, while desktop's
regression project excludes `@smoke` and therefore chains the dedicated
`test:e2e:lane:tools-settings-nightly` lane after its broad pass. That lane has a
two-minute Playwright budget, and the scheduled workflow has a 40-minute job
budget (30-minute broad cap plus lane and setup/build headroom). The measured
incremental local cost when this ruling was made was about 5 seconds for web and
28 seconds for desktop; the first Linux CI run after admission completed the
entire desktop smoke step in 149 seconds against its 300-second Playwright
budget. `ai-tools-e2e-pr-gate-contract.test.mjs` verifies every title has
statically resolved tags, the desktop file remains PR-allowlisted and
nightly-routed, and the pull-request E2E jobs still invoke both smoke scripts
without PR-excluding conditions.

### Every Linux apt site drops the unused Google Chrome source first (BST-1715)

`apt-get update` exits non-zero when ANY configured repository's index fails
verification, even when every other repository updated fine (apt's own wording:
"They have been ignored, or old ones used instead"). Under `set -euo pipefail`
that is fatal. On 2026-09-09 Google's CDN served a `Release` manifest
inconsistent with `Packages.gz` on some edges — `Hash Sum mismatch` — and ten
checks on one PR died in system-dependency install steps without running a
single test, across four run attempts, each within ~20 seconds. Fetching the
same URL from outside CI returned HTTP 200 and a valid gzip, so which runner
failed depended on which edge it hit and reruns were a coin flip.

Every package those steps install comes from UBUNTU's archives —
`bubblewrap socat ripgrep`, `dbus-x11 gnome-keyring xdg-utils`, and the Chromium
system libraries `playwright install-deps` resolves. The repository that broke
belongs to Google, is added by the runner image, and NOTHING here installs from
it: every Playwright project pins `channel: 'chromium'` (Playwright's own build,
downloaded from its CDN), never `'chrome'` (the apt-installed Google Chrome).

`.github/actions/apt-drop-unused-sources` removes that source, and asserts the
result rather than trusting the filename pattern: if any configured source still
references `dl.google.com` after the removal it fails by name. It is used
immediately ahead of every apt site — the Unit lane's OS-fence deps (which run
BEFORE `Setup workspace`, so folding this into that composite would have left
the seven shards exposed), native-electron's desktop services, and the three
`playwright install-deps chromium` steps in test.yml and desktop-e2e.yml, plus
local-desktop-e2e.yml's xvfb step.

It is NOT `apt-get update || true`, `-o APT::Update::Error-Mode`, or any other
relaxation of apt's exit status, and `apt-source-guard-contract.test.mjs`
forbids all of them: those would also swallow a genuine failure to reach
Ubuntu's archives and turn a clear provisioning error into a baffling install
error several steps later. Narrow the exposure; never widen the tolerance. The
same contract scans every workflow for apt steps rather than a list of today's
sites, so a NEW apt step added without the guard fails there.

A green run is not evidence here — the upstream inconsistency is intermittent by
edge. The guard was proven in `ubuntu:24.04` against a deliberately broken
third-party source (a locally served repo whose `Release` digest disagrees with
the `Packages.gz` it serves, reproducing `E: Failed to fetch ... Hash Sum
mismatch` / exit 100): provisioning fails with the source present and no guard,
succeeds with the guard, and STILL fails when the broken source is one the guard
does not drop. Reproduce it that way, not by rerunning CI. Note that apt does
not hash-verify `file:`/`copy:` transports and treats an unreachable host as a
warning — only a mismatch over HTTP reproduces the hard error.

### Development startup ordering (BST-1168)

Root `pnpm dev` has a two-phase lifecycle: root `predev` synchronously prepares
the complete app dependency graph, then the root `dev` wrapper marks the outer
Turbo graph with `BRAINSTRIKE_DEV_DEPS_PREPARED=1`. Web and desktop `predev`
hooks may skip their standalone preparation only when both `TURBO_HASH` and
that explicit marker are present. A bare `turbo run dev` has no marker and must
fail closed with guidance to use `pnpm dev`; it must never start nested builds
beside persistent watchers. Direct package-level web or desktop `pnpm dev`
invocations have no `TURBO_HASH`, so they still prepare dependencies
synchronously. Do not replace this ordering with sleeps, polling, or `dist`
existence sentinels.

### The package-boundary gate (BST-967)

The `Static` job runs `pnpm run boundaries` as its first substantive step
(right after the secret scan). That script, `scripts/turbo-boundaries.mjs`,
runs the real `turbo boundaries` and then judges only the findings in files
git does not ignore.

**Why the wrapper exists.** The analyzer walks every package directory and its
only exclusion is `node_modules/**`: it reads `dist/` and every other emitted
output, and it does not consult `.gitignore`. There is no way to narrow the
walk — no CLI flag, no `turbo.json` key, no `.turboignore` — verified against
turbo 2.10.8, 2.10.10, and 2.10.11-canary.3 (`--ignore` only offers to WRITE
`@boundaries-ignore` comments into the files it scanned, which is useless for
output regenerated on every build). Recheck that on the next Turbo bump — if
the walk becomes configurable, the wrapper should shrink to that config. So
the raw command is not idempotent on a developer machine: green on a clean
tree, then red on the identical tree once anything has built, over files
nobody wrote — `dist/turso/*` from an unmerged branch flagging a dependency no
source on `main` imports; `apps/web/dist/assets/chunking.worker-*.ts` flagged
for `@brainstrike/tokenization`. CI never saw it (fresh checkout, and the
ordering below), which is exactly what let it sit.

**Why git decides.** A hardcoded list of output directories would drift, and
turbo's own `outputs` cannot serve as one: `packages/config` declares
`tsconfig/**`, `biome/**`, and `tailwind/**` as build outputs and those are
SOURCE. `git check-ignore` is index-aware, so a checked-in file is judged even
if it matches an ignore pattern, and an uncommitted source file is judged too.
That index-awareness is also what keeps this safe as a CI gate: on the fresh
checkout Static runs against, every file a PR touches is TRACKED, so no
contributor can suppress a finding by adding a `.gitignore` entry — the gate
filters generated output, never repository content.
Suppression applies ONLY to a finding whose file git confirms is ignored;
everything else fails the gate, including a diagnostic with no file location, a
turbo issue count the parser cannot account for, and git itself erroring. One
stated local-vs-CI difference: personal excludes (`~/.config/git/ignore`,
`.git/info/exclude`) count as ignored locally, so CI stays the stricter side.

**The ordering is now about cost, not correctness.** Keep the step ahead of
anything that materializes `dist/` — `type-check` (whose turbo task
`dependsOn: ["build"]`), any `pnpm build`, or a cache restore of real build
outputs — because a clean tree is roughly half the files to scan (~4,000 vs
~8,000 here). It is no longer what makes the verdict trustworthy.

Deliberate crossings carry inline `// @boundaries-ignore <reason>` comments at
the import site. The contract tests in
`scripts/__tests__/turbo-boundaries-gate.test.mjs` keep all of this honest:
they prove the gate can fail (fixture workspace with a violation → non-zero
exit, clean fixture → zero), that a violation living only in git-ignored build
output passes while raw `turbo boundaries` on the same fixture fails, that
build output cannot MASK a source violation, that a TRACKED file under `dist/`
is still judged, assert the Static step stays ordered before any dist-producing
step, and require every ignore comment to carry a substantive reason. Division
of labor with the custom checker:
`architecture-domain-boundaries.mjs` owns cross-DOMAIN direction rules; `turbo
boundaries` owns package-escaping imports and undeclared dependencies. Known
blind spots (tracked, not solved here): CLI-flag dependencies such as the
coverage provider (BST-1017) and non-import reaches via `fileURLToPath` are
invisible to the analyzer.

The analyzer's reach widens across Turbo patch releases, so a Turbo bump can
surface a pre-existing crossing with no source change: 2.10.8 reports
`packages/chunking-worker/bench/tree-sitter-cost.mjs`'s relative
`../../text-splitter/src/index.ts` dynamic import, which 2.10.5 did not (same
tree, same 3705 files / 50 packages — 2.10.5 clean, 2.10.8 one issue). That one
is annotated, not rewritten: the bench must measure current text-splitter
SOURCE, and `@brainstrike/text-splitter` exports only `./dist`, so the package
specifier would silently benchmark a stale build. Expect to triage new findings
this way on the next bump rather than assuming the tree regressed.

### App test-tsconfig programs (`tsconfig.test.json`)

`apps/web` and `apps/desktop` type-check their test files through a dedicated
`tsconfig.test.json` in the `type-check` chain. Both set `"paths": {}` so
workspace deps resolve to built `dist` declarations (each produced under its
own package's tsconfig) instead of recompiling foreign sources under the app's
ambient shims. Two consequences to keep in mind:

- `type-check:test` needs deps built first. Turbo's `type-check` task
  (`dependsOn: ["build"]`) covers CI and `pnpm type-check`; a bare
  `pnpm --filter <app> type-check` in a fresh clone will not have `dist/`.
- The app's production `src` files reached from tests are checked TWICE under
  two different resolution graphs (src-paths in the main program, dist in the
  test program), so `type-check:main` passing does not imply `type-check:test`
  passes on the same file. Desktop additionally excludes its renderer-only
  PGlite shims (`src/types/pglite*.d.ts`) from the test program — an ambient
  `declare module` would otherwise shadow the real `@electric-sql/pglite`
  types for everything the tests pull in. The test programs also set
  `declaration: false`: a `noEmit` program never emits d.ts, and inheriting
  `declaration: true` makes exported `vi.fn()` mocks fail TS2883 portability
  checks that vary with pnpm store layout.

Desktop's `type-check:test` runs `scripts/verify-test-tsconfig-program.mjs`
instead of invoking `tsc` directly. The wrapper asks the pinned compiler for
the actual program through `--listFilesOnly`, requires at least 400 desktop
test roots, and then runs the unchanged `tsc --noEmit` diagnostic pass. The
floor is an anti-vacuity contract: `tsconfig.test.json` currently selects 419
test files, and an inherited/excluded test glob must fail before a zero-file
type-check can look green again. Its script tests include an empty-root
control, a broken test-only import that must surface TS2307, and manifest/cache
wiring assertions. `scripts/ts7-parity-check.mjs` unwraps the verifier command
back to its `--project` so the desktop test program remains in TS6↔TS7 parity
coverage. Because the verifier lives outside `apps/desktop`,
`apps/desktop/turbo.json` explicitly includes it in the desktop `type-check`
task inputs alongside `$TURBO_DEFAULT$`; changing the anti-vacuity or
diagnostic logic must invalidate Turbo's cached result.

### Vercel Preview is advisory

The Vercel GitHub integration reports a `Vercel` commit status on pull
requests, but it is intentionally absent from the default-branch ruleset's
required checks. The merge gate is the five always-present `test.yml` checks
listed above. This separation prevents provider capacity from being confused
with a code-quality result while keeping real Preview failures visible.

When `Vercel` is red:

1. Inspect the status description and target deployment before classifying it.
   A provider-capacity description (rather than a build or deployment failure
   log) means no build was evaluated; an actual failed deployment or build log
   is a product failure and remains blocking. Do not depend on a specific
   provider URL slug because integration URLs can change.
2. Verify the current repository ruleset rather than relying on an old PR or
   this prose. `gh api repos/seandearnaley/brainstrike/rulesets/4797672`
   should match the required checks listed above under
   `required_status_checks`.
3. For capacity-only failures, do not push a no-op commit or restart the
   45-minute GitHub Actions pipeline. Once the exact-head required checks and
   reviews are clean, the PR may merge with the advisory capacity status red.
4. Do not claim Preview QA occurred when capacity prevented a deployment. If
   the change specifically requires a live Preview acceptance check, restore
   capacity and perform that check before merge.

This is not a silent-success fallback: the original Vercel status stays red
and visible. Repeated quota exhaustion is an account-capacity problem to
provision, not a reason to weaken or rewrite the integration. Vercel documents
deployment and concurrency quotas in its
[platform limits](https://vercel.com/docs/limits); GitHub documents that only
[status checks selected by a ruleset are required to pass](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/available-rules-for-rulesets#require-status-checks-to-pass-before-merging).

### Deterministic agent-behavior evals (BST-589)

`packages/agent/src/__tests__/agent-behavior-eval.spec.ts` runs Mastra
`runEvals` through the real BrainStrike agent runtime with scripted
`LanguageModelV2` fixtures. It is a zero-network, zero-LLM-cost unit-lane gate
covering tool selection, error-free tool execution, and plan-mode omission of
mutation tools. Every deterministic gate must average exactly `1.0`; a Mastra
`failed` verdict fails Vitest. The suite also keeps a deliberately misbehaving
control so a gate that can no longer detect its target cannot pass silently.

The same spec demonstrates scored quality tracking with a deterministic
threshold miss. Its expected Mastra verdict is `scored`, not `failed`, so it is
advisory evidence and never weakens or replaces the merge-blocking gates. Real
provider/model evals remain outside the merge gate and must use the package's
`*.integration.spec.ts` lane if added later.

### Quiet-head admission before PR fan-out (BST-597)

Every `pull_request` run of `test.yml` first enters the `Quiet-head admission`
job on `ubuntu-slim`, GitHub's 1-core $0.002/min runner. The gate waits 120
seconds, then reads the PR through the GitHub API and compares its current head
SHA with the immutable head SHA in this run's event payload. If they match, it
releases the complete existing job graph. If the PR advanced, the gate succeeds
with a visible notice and `admitted=false`, so the superseded SHA's seven
expensive jobs never start. Workflow-level `cancel-in-progress` remains the
first line of defense: a new `synchronize` event normally cancels the old gate
during its cheap sleep; the API comparison closes the remaining ordering race.

This is an admission delay, not CI routing. It uses no labels and never selects
a reduced test plan. The latest quiet PR head always runs the full graph,
including all five stable required contexts (`Static`, `Unit`, `Build`,
`Web E2E`, `Desktop E2E`) plus both native jobs and the non-required
`Browser tests` lane (BST-994 — Vitest browser-mode suites for
db/ui/storage/assistant-ui/embedding-worker in the pinned Playwright container;
expensive enough that it keeps the same
quiet-head gate, and `quiet-head-admission-contract.test.mjs` verifies it).
Browser artifact uploads explicitly include hidden files and the resolved
attachment directories for all six browser packages; the paired screenshot
contract checks the installed Vitest configuration against the upload paths.
Vitest generated failure captures stay in ignored package-local
`.vitest/attachments/failure-screenshots` directories. Intentional `toMatchScreenshot` references are
rerouted by `@brainstrike/config` to trackable `__image_snapshots__`
directories; the db and storage projects that construct browser options
directly use the same resolver. Keep those paths separate so failure debris
cannot be committed and a new visual baseline cannot disappear from git.
Web and desktop E2E retain their `build` dependency. Push and
`workflow_dispatch` events are admitted immediately, so their behavior is
unchanged apart from the dependency edge.

The gate is deliberately fail-closed: `pull-requests: read` is its only added
permission, and a missing event SHA, missing API SHA, or API error fails the
admission job visibly instead of guessing that the run is current. Do not add a
fallback that releases work when currency cannot be established. Each of the
five required jobs uses `always()` plus an explicit first-step failure when the
admission job itself fails. This is required because GitHub otherwise skips a
job whose dependency failed, and a skipped required check can satisfy branch
protection. A normal superseded-head decision keeps the admission job successful
with `admitted=false`, so those same jobs remain skipped without allocating
their runners. Contract coverage lives in
`scripts/__tests__/quiet-head-admission-contract.test.mjs` and runs in the
Static job through `pnpm test:scripts`.

Why this exists: the measured GitHub Actions sample for 2026-07-15..19 reached
44 concurrent Linux jobs, and 513 of 1,641 `Test` workflow runs (31.3%) were
cancelled. `Test` represented roughly 92% of the modeled Actions bill. Paying
about $0.004 to hold a PR head for two minutes is materially cheaper than
starting the full fan-out during edit/push bursts.

### A red `main` announces itself (BST-1301)

`main` broke twice on 2026-08-15, and both times the only reason anyone found
out was an unrelated PR tripping over it hours later:

| Run | Failing step | Cause |
| --- | --- | --- |
| `31872259629`, `31872457744` | `Static` › `Lint` | `noUnsafeOptionalChaining` in `packages/app-shell/.../workspace-snapshot-io.test.ts` (#2437) |
| `31894054632` | `Static` › `Lint` | formatter drift on `it.each` in `packages/file-system/src/__tests__/path-validation.test.ts` (#2440), fixed by #2452 |

**The gate was never missing.** `test.yml` has always subscribed to
`push: branches: [main]`, so Static/Unit/Build evaluate every merged commit,
and all three runs above failed correctly. What did not exist was anyone being
told — the red run sat in the Actions tab while every branch inherited the
breakage.

The mechanism is toolchain drift. A PR's CI judges it under the
linter/formatter **on its base at the time that run happened**. Both PRs above
were authored and went green under Biome 2.5.2, then merged after #2447 landed
2.5.8, which narrowed one rule and changed one formatting decision. Nothing
re-checks an already-approved PR against the post-merge toolchain, so the
verdict goes quietly stale and the failure materialises for the first time on
`main` — where it blocks every branch and looks unrelated to whoever hits it
next. The same shape applies to any bump that can change a verdict: Biome,
ESLint, TypeScript, or a lint-rule guard script.

`test.yml`'s `notify-main-failure` job closes the reporting half. It fans in
from `static`, `unit` and `build`; when any of them reports `failure` on a
`push`, it opens (or comments on) a single `main-broken` tracking issue naming
the failed checks, the commit, the run, and the toolchain-drift hypothesis to
check first. Its sibling `notify-main-recovery` closes that issue on the next
push where all three are green.

#### The scope line is required-check status, not "important lanes"

The ruleset requires exactly **Static, Unit, Build, Web E2E and Desktop E2E**.
Those five are the only checks that can block *every* branch, which is the
everyone-trips-over-it breakage class this job targets — so required-check
status, not perceived importance, is where the line is drawn. The two E2E lanes
are then excluded on a **second, independent** ground: they are the documented
flaky-headless class, and a canary that cries wolf gets muted, which is the
exact failure this job exists to prevent. Persistent E2E breakage is still
caught within 24h by the scheduled notifiers in `web-e2e.yml` /
`desktop-e2e.yml`.

That leaves `Browser tests`, affected `Native Windows`, and
`Native Electron Package`, which also run on pushes to `main` and are also
**not** notified. Not on
flakiness grounds — `browser-tests` "must first prove itself deterministic"
per its own header, which makes it *pending*, not excluded — but because none
of them is a required check. A red one does not block anyone else's branch, so
it is not this job's class of problem. If any of them is ever promoted into the
ruleset, it belongs in the notifier's `needs:` at the same time.

#### `== 'failure'` is necessary but NOT sufficient — `!cancelled()` is what makes cancelled runs silent

This was previously documented the other way round, and the claim was wrong.
`needs.<job>.result == 'failure'` does **not** by itself mean "the code
failed", because neither watched job is a leaf verdict:

- every admission-gated job (`static`, `build`, `unit-shard`, …) opens with a
  `Require successful admission` step that `exit 1`s whenever
  `needs.admission.result != 'success'`; and
- `unit` is a ~5-minute fan-in over the `unit-shard` matrix whose check is
  `[ "$SHARD_RESULT" != "success" ] && exit 1` — the very `!= 'success'` shape
  the notifier's own condition avoids.

Both therefore **launder a cancelled upstream into a `failure` result**. This
is observed, not theoretical: on runs `31903009051`, `31900478128` and
`31900226011` (all 2026-08-15) a cancel landed while `admission` was in its
120-second sleep, `always()` still dispatched the downstream jobs, and Static,
Unit **and** Build all reported `failure` on a run that tested nothing. Under
`always()` the notifier would have filed *"main is red: Static, Unit, Build
failed"* for a cancellation. (Those three were `pull_request` events that the
push guard would also have caught — but the mechanism is not PR-specific, and
leaning on the push guard for it would be an accident rather than a design.)

The actual guard is therefore **`if: !cancelled()`**, not `always()`: it still
runs when a need *failed*, which is the whole point, but never when the run was
cancelled. `== 'failure'` is retained as the necessary half.

Two related properties worth knowing:

- `unit`'s `!= 'success'` check is **deliberately left alone**. Its shape is a
  branch-protection contract (`test.yml`'s fan-in comment): anything but
  success must fail the required `Unit` check *loudly* rather than grey out the
  merge box. Compensating in the notifier is the change that does not alter
  what a required check reports.
- Residual, accepted, and deliberately not suppressed: if `admission` ever
  genuinely **fails** on a push (never yet observed), all three gated jobs
  report `failure` and the issue body blames the code. That is loud rather than
  silent, "all three at once" is itself the tell, and the linked run shows the
  real cause. Gating the notifier on admission success would trade a rare
  wrong-hypothesis issue for a silent `main` with no verdict at all.

#### Green `main` closes the issue

Label-keyed de-duplication was copied from the nightly notifiers, but the
**lifecycles differ**. For `web-e2e` / `nightly-coverage` the failure recurs on
a 24h cadence and the issue closes when fixed, so the de-duplication window is
roughly the incident window. A red `main` is the opposite: the incident is
typically over within the hour (force-fix or revert) while the issue stays open
until a human closes it.

Left alone, that degrades into a stale-issue trap. Incident #1 leaves an open
issue titled `main is red: Static failed (2026-08-15)`; incident #2 three weeks
later — a Build failure, say — would open nothing and instead append a comment
to that mistitled, wrong-dated issue. It would never surface in triage, and
anyone who unsubscribed from the first would hear nothing. That is the canary
getting muted: the same failure mode the E2E exclusion above argues against.

`notify-main-recovery` closes the loop, so the de-duplication window equals the
incident window and each incident gets its own correctly-titled issue. It
closes *every* open `main-broken` issue rather than the first, so the
"at most one open" invariant is self-healing. Push runs on `main` share the
concurrency group `Test-refs/heads/main` with `cancel-in-progress: false` and
are therefore serialized, so recovery cannot race the notifier.

#### Prevention is out of scope

This is detection only. Requiring branches to be up to date before merge would
stop a stale-based PR from landing in the first place, but that is a
branch-protection setting and therefore the repo owner's call, not a workflow's.

#### Constraints any change must preserve

It adds **no new trigger** to `test.yml` (see `coverage.yml`'s header for why a
new trigger here greys out the merge box), neither job is a **required status
check**, and both stay on GitHub `ubuntu-latest`. These five-second reporting
jobs do not justify an additional managed-runner allocation; the notifier
contract rejects Ubicloud assignments. The `gh`
steps are reporting rather than gating, so they are listed in
`check-ci-parity.test.mjs`'s `PROVISIONING_STEPS` — `pnpm check` must not
mirror them, because running them locally would file and close GitHub issues.

Every tracking notifier's label step uses `gh label create --force` and **no**
`2>/dev/null || true`. That idiom absorbs the expected "label
already exists" and a genuine failure (token not elevated, API 5xx, org label
restrictions) indistinguishably; since the label does not exist until the first
red `main`, a swallowed failure on that very first run makes the next step's
`gh issue create --label` hard-fail and nothing gets filed — reproducing the
"red run sits unseen in the Actions tab" outcome one level up. `--force`
PATCHes an existing label instead of erroring, so a non-zero exit means only a
genuine failure. Each label step annotates that the tracking issue cannot be
filed or de-duplicated, then fails before any unlabelled issue can be created.

The scheduled web, desktop, coverage, and performance notifiers deliberately
retain their existing human-closed lifecycle: while an incident's issue remains
open, another red run comments on it; after a human closes it on recovery, a
later incident creates a fresh issue. Their issue bodies explicitly assign that
close-on-green action to a human; this label-reliability fix does not redesign
that established lifecycle or add automatic recovery jobs.

Contract coverage lives in
`scripts/__tests__/main-failure-notifier-contract.test.mjs` and runs in the
Static job through `pnpm test:scripts`. Its control tests pin all four
properties above: dropping a watched job, reverting `!cancelled()` to
`always()`, restoring the `|| true` suppression, or deleting the recovery job
each make the contract fail. The four scheduled notifier variants are covered
by `scripts/__tests__/nightly-notifier-label-contract.test.mjs`, including their
fail-visible label path and unchanged manual-close de-duplication lifecycle.

### Biome 2.5.8 cleared the 2.5.3/2.5.4 module-graph hold (2026-08-15, BST-1273)

`@biomejs/biome` is pinned to exactly 2.5.8 (root + `apps/web`; the two must
stay in lockstep). History: Biome 2.5.3/2.5.4 hit a module-graph panic
(`module_resolver.rs:500:33`, "index out of bounds") **deterministically 39
times** on this codebase — triggered by `nursery/noFloatingPromises` resolving
cross-module callback return types (upstream biomejs/biome#10963, same class as
#10885/#10940). 2.5.2 contained the same panic site but only hit it via a rare
scheduling-dependent race (#10953). The fix is upstream commit `e62f6b6`
(2026-07-16), released after 2.5.4.

The old hold required a release containing `e62f6b6` and a full
`pnpm exec biome check .` with zero "Biome encountered an unexpected error" /
panic output. The 2.5.2 → 2.5.8 bump satisfied both conditions: repeated full
runs over all 4376 files produced zero panic output. No live release condition
gates future Biome bumps. Keep the root and `apps/web` pins in lockstep and
repeat the full panic-free check for every bump; those are verification
guardrails, not a hold at 2.5.8.

Two things the 2.5.3–2.5.8 window changed on this repo, both already absorbed:
- **Formatter.** `it.each([...])('title', fn)` no longer hugs the callback when
  the call head overflows `lineWidth`, so it breaks the arguments instead. This
  is a test-only pattern; 76 test files reformatted, net −65 lines. Two files
  that sat exactly at the 1000-line `noExcessiveLinesPerFile` cap
  (`packages/embedding-worker/test/streaming-worker-client.spec.ts`,
  `packages/queue/src/__tests__/browser-workerpool.test.ts`) were pushed over
  and were shrunk by collapsing verbose literals — the cap was NOT raised and
  neither file was added to the `noExcessiveLinesPerFile` override list.
- **`lint/performance/noDelete` narrowed.** It no longer fires on
  `delete process.env['X']`, so 11 `biome-ignore` directives for it went dead
  and were demoted to plain rationale comments. 7 other `noDelete` suppressions
  in the repo still fire — do not bulk-remove them.

`nursery/noFloatingPromises` (the repo's only error-level nursery rule)
surfaced **no** new violations at 2.5.8.

### Static runs on arm64; the Unit fan-in runs on slim (Series C R9b/R10)

`static` in `test.yml` runs on `ubuntu-24.04-arm`, not `ubuntu-latest` (x64).
arm64 runners became available
for private repos on 2026-01-29 and cost 37% less per minute than x64. Probe P1
measured this specific: `pnpm install --frozen-lockfile` (the native-deps/node-gyp set,
the main risk), lint, script tests, secret scan, and the 6 `cache: false`
`test:integration` suites (real PGlite, embeddings — the heaviest,
native-dependent work in the workflow) all genuinely ran and passed on
arm64. Wall-clock was AT PARITY with x64 (~3.0m either arch) — arm64 is
**not** faster here, only cheaper per minute; do not claim a speedup.

The `unit` fan-in performs no install, build, or test: it reads the matrix
result and normally completes in about three seconds. The 2026-08-21..28 cost
audit found 609 rounded ARM minutes ($3.05 list price) for that result check.
It now runs on GitHub `ubuntu-slim`, preserving the exact required `Unit` check
while lowering the one-minute rounding rate to $0.002. `native-windows` stays
on GitHub's `windows-latest` runner and is allocated only after the affected
gate described below.

### Performance lane (performance.yml) — calibrated budgets only (BST-1038)

The nightly performance lane (`performance.yml`, cron 07:23 UTC + dispatch)
gates on the budget assertions inside `apps/web/e2e/performance/*.test.ts` —
there is no separate diff step. Its contract, written after the lane spent
three months permanently red (zero green runs in 1,000 retained; budgets
were local-dev constants x a flat 2.0 multiplier with no CI-derived floors):

- **Every CI budget that has breached under controlled measurement carries a
  calibrated `GITHUB_ACTIONS_MINIMUMS` floor** in
  `apps/web/e2e/utils/performance-config.ts`, with provenance (run ids, date,
  runner class, observed range) in the adjacent comment. Metrics that have
  never breached stay on the multiplier budgets and are calibrated from
  observed data on their FIRST breach — never floor-bumped reactively, and
  never tightened or introduced from a local measurement (local is an order
  of magnitude faster than the shared runner — the "~62ms" incident).
- **Recalibrate by controlled dispatch**: N `workflow_dispatch` runs of
  `performance.yml` on ONE SHA (sequentially — the concurrency group cancels
  parallel dispatches), floor = observed worst x ~1.5 headroom.
- **No `--max-failures` truncation**: the lane must report its full breach
  surface, or its scope cannot be measured.
- A calibrated-lane breach is a REAL signal: file it as a regression ticket
  with the measured values, do not bump the floor to silence it.
- Browser interaction helpers keep their complete sample inside the page. The
  default `measureLocatorInteractionFrames` contract retains each element and
  fails if React detaches it. Recursive folder selection deliberately uses the
  narrower `measureNamedCheckboxInteractionFrame` boundary: it resolves one
  checkbox by exact `aria-label` before the click and again after two animation
  frames, then verifies the replacement's checked state. This permits the
  folder row's expected replacement without admitting Playwright transport
  time or weakening detach detection for stable rows. Its single sample is the
  same interaction-to-paint quantity as `CHECKBOX_FRAME_MAX_MS`; the paired
  `performance-benchmark-contract.vitest.ts` test pins the named benchmark,
  known fixture count, and calibrated sibling budget.

BST-369 adds a worker-memory **structural bound**, not a locally invented CI
latency floor. On runtime-calibration head `156c0b052`, this command ran three
repetitions sequentially against one built app and one configured Chromium version:

```bash
cd apps/web
pnpm exec playwright test e2e/performance/embedding-model-switch-memory.test.ts \
  --project=performance --workers=1 --retries=0 --repeat-each=3
```

| Run | Baseline total | Warm worker | Window A worker | Window B worker | B - A | After worker |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 1 | 278,926,311 | 44,397,878 | 44,446,090 | 44,446,626 | +536 | 0 |
| 2 | 277,774,586 | 44,398,290 | 44,446,558 | 44,446,634 | +76 | 0 |
| 3 | 277,832,659 | 44,398,290 | 44,446,542 | 44,446,634 | +92 | 0 |

The later production hardening at `7d2ba303d` validates the cache clock before
eviction or loader allocation. It leaves the valid switching allocation,
disposal, and structural-memory behavior unchanged. An exact-branch rerun at
`2a75942da` recorded baseline total 278,085,035, warm
worker 44,397,896, window A 44,446,108, window B 44,446,628 (+520), and zero
worker attribution after teardown, confirming the valid switching path retained
the same structural signal.

Two reversible, uncommitted mutations proved the browser assertion's teeth. Doubling each
allocated backing store failed at the warm barrier with 80 MiB physically live against the
40 MiB cap. Skipping the asynchronous-disposal prerequisite failed with five resources and
56 MiB live before the delayed GPU-class victim release completed. Both mutations were
restored before the three-run table above.

The three local repetitions qualify the measurement signal; they do not set a
CI floor. The 4 MiB later-window ceiling is instead a structural bound: half
the smallest retained 8 MiB synthetic model store, so a single leaked store
cannot hide inside it while JIT/runtime bookkeeping has implementation-level
headroom. If the pinned CI environment first breaches, use the controlled
same-SHA dispatch procedure above before changing any budget.

The web unit-coverage census exact-excludes only the browser page probe and its
wrapper worker. Those modules require a production Vite worker bundle,
cross-origin isolation, workerpool, and Chromium's
`measureUserAgentSpecificMemory()`; their executable owner is the scheduled and
dispatchable `performance.yml` Playwright project above. The paired
`performance-benchmark-contract.vitest.ts` test pins the exact two exclusions,
the webdriver-gated lazy hook, the page-probe-to-worker-to-production-worker
route, and the scheduled workflow selection. The platform-neutral memory
measurement and worker-message validation modules remain in unit coverage, and
the web L98/F85/B73/S89 thresholds are unchanged. Do not broaden this exception
or replace it with a wildcard.

### Claude review coverage and orchestration (BST-1412, BST-1640)

Claude Auto Review runs on `pull_request` (`opened`, `ready_for_review`,
`reopened`; never `synchronize`) and on targeted `workflow_dispatch`. The
`pull_request` trigger is deliberate and settled (2026-09-05):

- It executes the workflow at the PR's own merge ref for **any base branch**,
  so each layer of a stack is reviewed against its parent — `gh pr diff` is
  already per-layer. `pull_request_target` cannot do this: for a stacked layer
  it would execute the *intermediate branch's* workflow copy with base-repo
  credentials, and Anthropic's App token exchange rejects its OIDC token
  regardless (anthropics/claude-code-action#713; it blacked out 7/7 automatic
  reviews on 2026-09-05 and every stacked layer). Do not switch back.
- Drafts are reviewed at `ready_for_review`; the job condition skips
  `opened`/`reopened` while `draft == true`. This matches Codex, which also
  ignores drafts, and removes the draft-open-then-ready double review. A PR
  opened ready, converted to draft, and marked ready again is reviewed twice;
  that round trip is rare and not worth guarding.
- There is no App-token exchange to depend on, because there is no action: the
  job installs the pinned Claude Code CLI and runs it directly. That removes
  the OIDC allowlist question (claude-code-action#713) structurally rather than
  routing around it with `github_token`. `secrets.CLAUDE_CODE_OAUTH_TOKEN` is
  the only secret in scope and reaches the CLI as its own credential; the job
  carries no `id-token` grant; the trusted reporter publishes with
  `github.token`. Losing the action also loses its write-permission check, so
  preparation's same-repository head guard is now load-bearing rather than
  belt-and-braces.

**Trust model, stated honestly.** Under `pull_request`, this workflow file and
`scripts/claude-review.mjs` execute from the PR's merge commit — PR-author
code — with `secrets.CLAUDE_CODE_OAUTH_TOKEN` injected and a `pull-requests:
write` token in scope. That is the exposure: a same-repository PR can rewrite
these steps to do anything with that secret and token, and since PRs here are
agent-authored, a prompt-injected agent reaches a credential by this path.
`pull_request_target` prevented it structurally and was given up for stack
coverage. "The model has no tools" and "the reporter emits text" constrain
only the model and the reporter, not PR-authored YAML. Accepted because every
PR is the owner's or their agents', and the owner reads workflow diffs; there
is no CODEOWNERS enforcement and none would be satisfiable in a one-human repo.
Mitigations available if the exposure is judged too large: rotate
`CLAUDE_CODE_OAUTH_TOKEN` on a cadence, or move the action step behind a
protected `environment:` (a GitHub setting, not repository code). The
`workflow_dispatch` path (`--ref main`) remains the trusted way to review a PR
that touches the reviewer itself.

Preparation pins the checkout to `GITHUB_SHA` and requires the event's ref
(`refs/heads/<default>` for dispatch, `refs/pull/<N>/merge` for
`pull_request`); for `pull_request` the expected ref derives from the same
payload as `GITHUB_REF`, so the checkout equality is the load-bearing check.
Any branch of this repository is an acceptable base — stacked layers pass; the
base-repository comparison is a malformed-response tripwire, since GitHub
cannot return a base outside the host repository. Automatic runs require a
same-repository head. A fork-head `pull_request` run holds a read-only token
regardless of the `permissions:` block, so its skipped disposition lands in the
job summary and the job goes red, but the PR comment cannot post; the dispatch
command in that summary still works from `main`. The repository takes no fork
PRs, so this is accepted rather than engineered around.

**Both reviewers, one budget.** Claude: one automatic review per lifecycle
event above, plus one targeted dispatch after the fix batch. Codex: one
automatic review at open/ready, plus at most one `@codex review` after the
batch. Review energy is front-loaded; later rounds trend nitpicky. Restacking
(force-push after rebase) triggers neither reviewer; a base merge that
retargets a child to `main` fires `edited`, which triggers nothing — correct,
there is nothing new to review.

**Size ceiling.** There is no environment ceiling, because nothing about the
prompt enters the environment. The review does not use
`anthropics/claude-code-action`: its only prompt input is `prompt`, which
`action.yml` carries into the runner through environment variables — `PROMPT`,
and again JSON-escaped inside `ALL_INPUTS` — where Linux caps a single variable
at 128 KiB (`MAX_ARG_STRLEN`). Above it the step died at spawn with `Argument
list too long` and no disposition (observed at 131 KiB and 188 KiB; 84 KiB
passed). There is no file input either: `run.ts` writes the prompt to
`$RUNNER_TEMP/claude-prompts/`, and `create-prompt` `rm -rf`s that directory
first, so pre-populating it is defeated by design; `execution_file` is an
output. That cap once bounded the review at a 100 KiB prompt budget, which a
dependency PR reached on lockfile churn alone — #3029 was refused at 410 KiB
with 9 KiB of non-lockfile content.

Preparation writes the whole prompt, diff included, to
`$RUNNER_TEMP/claude-review-capture/prompt.txt`, and `runReview` opens that file
and hands the descriptor to the CLI as stdin. A pipe has no size limit, so the
prompt is never measured against an argument or environment bound, and
`PROMPT_BYTE_BUDGET` is gone rather than raised. Do not reintroduce the action
to "simplify" this; it would silently restore the ceiling. The contract test
asserts the absence of `uses: …claude-code-action`, of any `prompt:` input, and
of any `structured_output` round trip, and a unit test asserts the CLI's stdin
is a file descriptor whose content is the prompt while no argument carries diff
text.

**The diff is delimited, not encoded.** It is embedded raw between a
`BEGIN`/`END` pair carrying a `CAPTURED-DIFF-<uuid>` marker generated for that
run, and the reviewer is told the text is unescaped and that a run of
backslashes is exactly what the source file contains.

It was previously embedded as `JSON.stringify(diff)` under a `CAPTURED DIFF
(JSON STRING):` header. That was load-bearing when the prompt travelled through
`GITHUB_OUTPUT`, whose heredoc framing is line-sensitive: collapsing the diff to
a single escaped line made a delimiter collision impossible. Delivering the
prompt on stdin removed that transport — the only values reaching
`GITHUB_OUTPUT` now are the literals `true` and `false` — and the encoding then
only cost fidelity. JSON doubles every backslash, so escape-dense source reaches
the reviewer as runs it must halve exactly once by inspection. On #3054 a review
halved them twice and reported a confident, detailed, entirely wrong finding:
that a regex had lost two escapes, making `[^:'(\s]` exclude the letter `s`.
The source was correct and the reasoning was sound about the text it was shown;
the transport had mangled it. Cost is not the argument — the encoding adds only
about 2% to an ordinary diff. Fidelity is. This is the same class as
`PROMPT_BYTE_BUDGET`: a mechanism kept past the constraint that justified it.

The boundary stays unforgeable because the diff is untrusted. Diff content
cannot predict the run's UUID, and `prepareReview` enforces that rather than
assuming it: a diff containing the generated marker is refused with an
**incomplete** disposition instead of being framed ambiguously. The UUID is
injectable so the refusal is exercised by a test rather than argued from
probability. A forged `END CAPTURED-DIFF-…` line inside a diff is content, and
a test asserts the real marker still appears exactly twice and closes the
prompt. Do not restore JSON encoding, and do not replace the fence with a fixed
string: a constant marker is forgeable by any diff that contains it. Tests in
`scripts/__tests__/claude-review.test.mjs` pin byte-for-byte delivery of
backslash-dense content, the forgery attempt, the delimiter-collision refusal,
and a diff with no trailing newline; every one was mutation-verified.

**Generated files are summarized, and it is said out loud.** Before anything is
measured, `scripts/lockfile-diff-summary.mjs` replaces `pnpm-lock.yaml` hunks in
the captured diff with a derived summary: packages added, removed, and
version-changed; packages left on more than one version among the entries the
diff adds; and any introduced `resolution:` that is not an `{integrity: ...}`
hash, which would mean a tarball, git, or directory source and is currently zero
in this tree. Measured on #3029, 401 KiB of lockfile becomes 13 KiB, and the
whole diff 410 KiB becomes 22 KiB. The summary carries more signal than the
hunks it replaces: it named 22 packages sitting on multiple resolved versions,
which is the `@codemirror/state` duplicate-resolution class that survived two
rebases in #3036 and needed a hand-written guard test.

**A repointed edge is reported, because the entry lists structurally cannot show
one.** A dedupe or a security lift leaves both versions already present and only
moves a parent's `dependencies:` at one of them, so neither end is an added or
removed entry. #3053 lifted `@ai-sdk/openai > @ai-sdk/provider-utils > undici`
from 7.28.0 to an already-present 7.29.1, and the entry lists could report only
`undici: 7.28.0 -> 6.28.1, 8.10.2` — unrelated additions that read as the
subtree leaving the 7.x line altogether. The reviewer flagged the apparent
contradiction of the PR's stated remediation and had to ask for `pnpm why
undici` to be pasted in, because the summary could not answer it. A
`dependency edges repointed:` section now does: on that PR it reports
`undici: 7.28.0 => 7.29.1 (4 edges)` and settles the question.

Resolved edges sit at six spaces inside `snapshots:`, and the **section** scopes
them rather than the enclosing `dependencies:` key. Under `-U3` a block key four
lines above a changed edge falls outside the hunk — #3053's flagship hunk
carried neither its key nor its `dependencies:` line — while the section
survives, because git's funcname trailer names the nearest column-0 line and a
lockfile's are exactly its section markers. Section scoping is sufficient, since
inside `snapshots:` every six-space `name: value` line is a resolved edge and
`transitivePeerDependencies` emits only `- item` entries; it is also necessary,
since `packages:` `peerDependencies:` sit at the same depth but hold ranges, not
resolutions. A parent is named only where the diff shows its block key and is
never carried across a hunk boundary, because a parent from the previous hunk is
worse than none: it is confidently wrong. Pairing is by dependency name, never
by position. Parents are split with `splitPackageKey`, so a peer suffix never
steals the version. Edges are grouped by the transition they make rather than
listed one per line, which is both the reviewer's actual question and the
tighter bound: a dedupe repointing hundreds of edges still costs a handful of
lines, because the section is bounded by distinct transitions rather than by
edge count. Both axes are capped anyway (`TRANSITIONS_LISTED`, `PARENTS_LISTED`)
since a wide update widens the transition list too, and the cut is by sort
order, so re-reading a re-pushed PR yields the same list rather than an
accident of hunk order — compared by code unit rather than `localeCompare`,
whose collation follows the runtime's ICU data.

Two things this deliberately does not report, both consequences of flushing at
every hunk boundary. A removal and an addition of the same dependency that land
in *different* hunks are never paired, so a line that both moved far and changed
version is missed; pairing across that gap would cost the attribution guarantee,
which is the worse trade. And a hunk whose header names no section cannot be
classified at all — that shape is not expected, since `gh pr diff` derives the
trailer from the nearest column-0 line and this file's line 1 is
`lockfileVersion:` — but if it occurs, the changed dependency lines are counted
and stated rather than dropped behind a confident total. With no repointed edges
the section costs two lines — the count and its blank separator — because it is
emitted on every summary and a
summary only replaces hunks it shrinks: standing prose here would narrow what
gets summarized at all. Every one of those guards is mutation-verified: each was
confirmed to fail against a deliberate regression before being trusted.

Every other file passes through byte for byte, and a header the splitter cannot
parse falls through as "not summarized" rather than being summarized against the
wrong path. Matching is on basename, so `docs/pnpm-lock.yaml.md` is untouched. A
lockfile change smaller than its own summary keeps its exact hunks. Importer
`specifier:` changes are not lost, because they mirror each `package.json`,
whose diffs are complete.

This is the one place the review is shown something other than `gh pr diff`, so
it is never silent: preparation states the substitution and its byte counts in
the prompt and tells the model not to claim line-level coverage of the replaced
hunks, and the trusted reporter repeats it in the published disposition so a
human reading the review knows what the reviewer was given. The prompt names at
most `SUBSTITUTIONS_LISTED` files and aggregates the rest: the prompt has no
size limit any more, but a per-file list would still spend context on paths
rather than on the summaries. Nothing else is ever substituted, and no partial
review is published in place of a refused one.

What bounds the diff now is the model's context window alone, at a
`DIFF_BYTE_CEILING` of 512 KiB. Unlike `MAX_ARG_STRLEN` this is a chosen margin
rather than a measured cliff: roughly 145k tokens at the ~3.5 bytes/token that
diff text runs, leaving a 200k window room for the system prompt and the
structured output. Over it, preparation refuses with an **incomplete**
disposition stating both numbers. No narrower diff is ever substituted and no
partial review is published; a PR that size needs splitting, not a shorter
review.

The result comes back the same way. `runReview` records the CLI's structured
output to `$RUNNER_TEMP/claude-review-result.json` and the reporter reads it
from disk; only the step's own `outcome` travels as an environment variable.
Carrying the review text back through one would reintroduce the same class of
limit in the other direction.

**The published body reaches `gh` on stdin too (BST-1743).** The reporter
posts with `gh pr comment --body-file -` and hands the body to `execFileSync`
as `input`, never as a `--body` argument. Node refuses any argv element that
contains a NUL byte (`ERR_INVALID_ARG_VALUE: The argument 'args[6]' must be a
string without null bytes`), and a reviewer that faithfully quotes the diff
will produce one: twice on #3119 the review had completed and validated at the
exact head, then destroyed itself by reproducing the PR's own `\u0000` latch
separator in its prose. Any control character in reviewed code can do this,
and reviewing such code is normal. A pipe carries every byte sequence, so the
reviewer's text is published exactly as written — do not "fix" this by
stripping or escaping, which would alter the review, and do not move the body
back to argv. It is the same lesson as the prompt's 128 KiB `MAX_ARG_STRLEN`
ceiling (BST-1666) at a different limit; `gh` 2.91.0 documents `-F,
--body-file file … (use "-" to read from standard input)`. The unit test's
`gh` mock mirrors Node's argv contract and refuses NUL, so reverting to
`--body` fails the suite with the production error text. When publication
does fail, the reporter writes the cause to **stderr** with the stable prefix
`CLAUDE_REVIEW_PUBLICATION_FAILED:` as well as to the step summary — grep the
job log for that prefix; before this the log showed only a bare exit code and
the reason lived in the summary alone. The exit code is unchanged: nothing
published is still **incomplete** and red.

Automatic review retains the `opened`, `ready_for_review`, and `reopened`
lifecycle and omits `synchronize`. Changes to the workflow or its orchestration
script receive an explicit **skipped** disposition; a maintainer can request
coverage with the trusted default-branch workflow:

```bash
gh workflow run claude-code-review.yml --repo seandearnaley/brainstrike --ref main \
  -f pr_number=123 -f expected_head=<40-character-current-head> \
  -f 'focus=Verify the specific workflow trust boundary or previously reported findings'
```

This is a targeted review, not another automatic whole-PR round. Follow the
initial review plus one batched re-review budget above; a third whole-PR round
needs user approval. Never close/reopen a PR, toggle its draft status, push an
empty commit, or restart the full Test pipeline merely to request Claude review.
A newly introduced workflow cannot be dispatched from the default branch until
an approved merge makes it available there. A PR that changes this workflow or
its script is self-change-skipped, so its own automatic review never runs; use
the trusted dispatch above for coverage and obtain human review. Local contract
fixtures are not proof that a live Claude review completed.

`scripts/claude-review.mjs` captures `gh pr diff`, checking the live head and
base before and after capture, then writes that snapshot to a file under
`$RUNNER_TEMP` and streams it to the CLI on stdin. Orchestration keeps the
fetch, which is what makes the exact-head guarantee possible: a model running
`gh pr diff` itself — the vendor's documented review pattern — would leave
nothing able to attest what was reviewed, and the pinned `head_sha` would
become a claim the model echoes rather than a fact. Only the delivery mechanism
departs from the reference architecture; the trust boundary is unchanged.

Claude has no file, shell, network, or GitHub tools: `--tools=` empties the
built-in set and ignores user, project, and local settings, so it is the hard
cap and no permission rule can widen it; `--disallowedTools "mcp__*"` denies MCP
tools, strict empty MCP configuration prevents other servers loading, and slash
commands are disabled. Only the schema's `StructuredOutput` tool remains. Do not
replace this with `allowedTools` plus `dontAsk`: that restores the whole
built-in set and read-only commands remain available under that permission mode.
The model and 80-turn ceiling remain unchanged.

An earlier revision of this change granted `Read` so the model could open a
diff file, because the prompt could not carry one. Delivering the prompt on
stdin removed the reason, and the grant with it: there is no `--add-dir`, no
capture file for the model to open, and no widening of what it can reach. Prefer
this ordering generally — when a limit forces a capability grant, check whether
the limit is real before accepting the grant.

`scripts/probe-claude-review-tools.mjs` verifies the boundary behaviorally
against the exact CLI version the workflow installs, delivering its prompt on
stdin the way production does: `Bash` rejected as an unavailable tool, a private
file left unread, only `StructuredOutput` exposed. A contract test pins the
probe's asserted version to the workflow's install pin, so the probe cannot
certify a build CI never runs. Update the probe with any change to the tool
arguments.

Claude returns completed/head/base/scope fields and review text. Trusted
orchestration validates the exact request, rechecks live head/base, and posts
that text with an explicit **Claude-generated review** attribution. Both
invocation paths use top-level file/line findings; the model cannot post inline
comments or execute untrusted diff content. Missing, partial, malformed,
wrong-head/base/scope, oversized, or unpublishable output stays incomplete.
Reviews are never truncated to fit GitHub's comment-body limit. A diff that
exceeds the runner/action's input limit also fails visibly; no narrower diff is
substituted.

The final handler records a disposition in the workflow summary and publishes
it on the PR, tied to the requested head, scope, and run attempt. Publication
failures remain incomplete in the summary and fail the job:

- **Skipped:** the automatic self-change or untrusted-head guard withheld
  Claude execution; the disposition carries the dispatch command whose focus
  matches what was withheld.
- **Incomplete:** preparation/action failure, an oversized diff, the 80-turn
  cap, cancellation, missing exact-run structured review output, publication
  failure, or a changed/closed PR invalidates coverage. The reporter's message
  still names an upstream OIDC skip; that is residual defense only — no OIDC
  path is live while `github_token` is supplied.
- **Completed:** the action explicitly concluded successfully, the
  complete structured output matches the requested head/base/scope, live
  head/base checks still match, and the trusted reporter publishes the actual
  review text. It is coverage, not approval; inspect and close its findings.

Skipped and incomplete dispositions fail the review job. `continue-on-error`
only allows this final reporting step to run; it preserves BST-1412's red
failure disposition. Hard runner loss or checkout failure can prevent final
reporting; a missing disposition never counts as completion. The required Test
checks remain separate. Any later push invalidates an older head's coverage.
Contracts execute normal, failure, self-change, targeted, moving-head, missing
content, and trust rejection paths in `scripts/__tests__/claude-review.test.mjs`
and pin the workflow wiring in `claude-auto-review-contract.test.mjs`.
The opt-in CLI boundary check uses a fake localhost Anthropic API and no real
credentials:

```bash
node scripts/probe-claude-review-tools.mjs /absolute/path/to/claude
```

Use CLI 2.1.261, the version installed by the pinned action. The fixture injects
an unsolicited Bash file-read tool call: it must be rejected, the private
fixture content must remain unread, and structured output must still succeed.
This validates model tool isolation, not live OIDC or semantic review quality.

Primary trust evidence: [Anthropic action security guidance](https://github.com/anthropics/claude-code-action/blob/d75b94d5ad426cb8546e6628b6f5f19b84e5cce1/docs/security.md),
[manual dispatch example](https://github.com/anthropics/claude-code-action/blob/d75b94d5ad426cb8546e6628b6f5f19b84e5cce1/examples/manual-code-analysis.yml),
[OIDC skip and conclusion implementation](https://github.com/anthropics/claude-code-action/blob/d75b94d5ad426cb8546e6628b6f5f19b84e5cce1/src/entrypoints/run.ts),
[Claude CLI tool controls](https://code.claude.com/docs/en/cli-reference),
and [GitHub's trusted-event security guidance](https://docs.github.com/en/actions/reference/security/secure-use).

### Cost-ranked Linux x64 jobs run on Ubicloud (BST-765)

`unit-shard`, `build`, `native-electron`, `browser-tests`, `web-e2e`, and
`desktop-e2e` in `test.yml` run on `ubicloud-standard-4`. That runner preserves the
4-vCPU/16-GB class used for the x64 work while moving the measured, dominant
Linux x64 lanes to the connected Ubicloud runner fleet. PR Coverage, React
Doctor, Claude Auto Review, and `@claude` handling use
`ubicloud-standard-2`, preserving the previous private `ubuntu-latest`
2-vCPU/8-GB shape at the lower managed-runner rate. The boundary is deliberate:

- quiet-head admission remains on GitHub `ubuntu-slim`
- the lightweight Unit fan-in also uses GitHub `ubuntu-slim`
- Static remains on the measured GitHub ARM lane
- all nine physical Unit rows use one fixed Ubicloud runner class (two DB
  shards, two Agent shards, three desktop shards, and the heavy and rest rows)
- Native Windows remains on GitHub Windows behind its affected gate
- scheduled regression/coverage jobs remain GitHub-hosted until their existing
  baselines are green enough to support a runner comparison
- main-failure/recovery and scheduled-failure notifiers remain GitHub-hosted

The Unit matrix moved as a whole after GitHub's ARM pool terminated the
`rest` shard without a failing test assertion on five consecutive attempts
across two exact PR heads (runs 30158896583 and 30175303301 on 2026-07-25).
Do not route individual shards to different providers: keeping one fixed
runner contract avoids a provider-selection layer while preserving the exact
partition, integration concurrency, and required `Unit` fan-in.

The nine physical rows form five logical package partitions: `db`, `agent`,
`desktop`, `heavy` (UI packages), and `rest`. DB uses `DB_TEST_SHARD=1/2`
and `2/2`; Agent uses `AGENT_TEST_SHARD=1/2` and `2/2`; desktop uses
`DESKTOP_TEST_SHARD=1/3`, `2/3`, and `3/3` for both unit and integration.
Each variable is scoped to its owning package's Turbo tasks, and each native
shard runs files from one package only. Turbo CLI
passthrough is forbidden because it also reaches dependency/transit tasks.
`scripts/unit-shard-partition.mjs` rejects missing, duplicate, mixed-count,
or divergent-filter rows. Agent and Desktop configs reject a missing required
shard; each environment participates in its package task's cache key, so one
shard cannot replay an unsharded or different-shard result.

Do not add a provider-selection layer or an automatic GitHub fallback. An
Ubicloud provisioning failure must queue or fail visibly; rollback is an
explicit revert of the runner-label change. Existing cache and setup actions
stay unchanged because Ubicloud's transparent cache supports the standard
GitHub cache actions. The cost audit and service evidence live in
`docs/superpowers/research/2026-08-28-ubicloud-github-actions-runners.md`.
Contract coverage lives in
`scripts/__tests__/ubicloud-runner-contract.test.mjs`.

The Static job caps the monorepo type-check with Turbo's official
`TURBO_CONCURRENCY=4` environment variable.
Unbounded scheduling repeatedly exhausted the arm64 runner after the workspace
reached 43 packages: Turbo received a shutdown signal while launching more than
30 type-check tasks and the shell exited 137 without a TypeScript diagnostic.
Keep the cap on the CI invocation rather than weakening package coverage or
changing local developer defaults. The exact workflow command is guarded by
`scripts/__tests__/quiet-head-admission-contract.test.mjs`.

**Non-obvious trap for future maintainers:** the turbo *remote* cache
(`TURBO_TOKEN`/`TURBO_TEAM`) is arch-agnostic — turbo's cache hash does not
include CPU architecture, and `runner.os` reports `"Linux"` on both x64 and
arm64 GitHub-hosted runners. So an arm64 lane will mostly **replay**
x64-produced remote-cache entries rather than independently validate on
arm64 (benign for this repo's JS/dts/log outputs, which are
arch-independent, but worth knowing before treating a green arm64 run as
proof of arch-independent correctness for something that isn't). Whichever
arch runs first populates the shared remote cache for both. The *local*
`.turbo` `actions/cache` layer (`setup-workspace/action.yml`) is correctly
arch-namespaced (`${{ runner.os }}-${{ runner.arch }}-turbo-...`, added in
C2/#1668) so it cannot cross-restore an incompatible entry — that guard
just doesn't extend to the remote cache.

**Native (node-gyp) build outputs are the exception to "arch-independent"
and MUST NOT be turbo-cached.** `@brainstrike/secure-fs-native` compiles an
arch/ABI-specific `.node` into `build/**`. When its turbo `build` task cached
that output, the arch-blind remote cache let the arm64 Static/Unit jobs
populate an entry that the x64 Coverage job (`ubicloud-standard-2`) then replayed —
so `apps/desktop`'s coverage lane, which loads the real addon via its
`*.integration.test.*` files, died with `secure_fs_native.node: cannot open
shared object file` on every PR touching `apps/desktop` (PR #1749 shipped a
runner-side rebuild; the follow-up made the fix structural). Its `build` task
is now `cache: false` (`packages/secure-fs-native/turbo.json`), matching the
same package's long-standing `test` policy, so every runner node-gyp-rebuilds
the addon for its own ABI. Any future native/node-gyp package added to the
monorepo must do the same — never cache a compiled binary on turbo's
source-only, arch-blind hash.

**Native Windows stays always-on after quiet-head admission (R10).** The
non-required job consumed 2,440 rounded Windows minutes ($24.40 list price) in
the 2026-08-21..28 audit, but GitHub Actions has no native job-level changed-path
filter. Do not add a repository diff classifier, planner, or routing registry to
avoid that allocation: the root workflow contract explicitly prohibits custom
CI routing machinery. `native-windows` therefore depends directly on
`admission` and runs for every admitted PR, push to `main`, and manual dispatch.
`scripts/__tests__/ubicloud-runner-contract.test.mjs` guards both the always-on
dependency and the absence of a `native-windows-impact` planner.

**node-gyp's HEADERS are the opposite case and ARE cached, for `native-windows`
only (BST-1375).** Compiled output is arch-specific and must never be shared;
the Node headers tarball is an input, and downloading it is what flaked. That
job installs two packages with native addons — `secure-fs-native` (implicit
`node-gyp rebuild` from `gypfile: true`) and `windows-job-native` (an explicit
install script that shells out to node-gyp on win32) — and pnpm runs workspace
install scripts CONCURRENTLY, so a cold `pnpm install` has both processes
fetching the same ~30MB `node-vX-headers.tar.gz` in the same second. Twice in
290 attempts one of those streams returned HTTP 200 and then had its body
aborted ~80s later (`TypeError: terminated`, undici `Fetch.onAborted`), failing
`Setup workspace` before anything compiled.

Read the log carefully if this recurs: the visible error is a wall of
`TAR_ENTRY_ERROR ENOENT` against a `node-gyp-tmp-*` path, which is downstream
NOISE — node-gyp's rollback deletes the temp dir while tar is still writing into
it. Two intuitive fixes are ruled out by measurement, not argument: the failing
path was 133 characters (a second occurrence died at ~62), so MAX_PATH and
Windows long-path settings are irrelevant; and node-gyp 13.0.1 extracts into
`os.tmpdir()` and copies to the dev dir afterwards, so a shorter
`npm_config_devdir` cannot move the path that failed. There is no prebuilt
path to pin — both addons are C++ sources built from this repo.

The wiring has four load-bearing parts, each of which silently un-does the fix
on its own, and `scripts/__tests__/native-windows-node-gyp-cache-contract.test.mjs`
pins all four (with a mutation CONTROL per assertion):

1. the job pins `npm_config_devdir` — node-gyp's default lives under
   `%LOCALAPPDATA%` and no cache step can name it portably;
2. the restore runs **before** `Setup workspace`, because the download happens
   inside that composite's `pnpm install`. A restore after it prevents nothing;
3. the save key carries the Node version `setup-workspace` now exports as an
   output. `.nvmrc` pins a MAJOR, so a key built from `.nvmrc` alone keeps
   hitting after a patch bump, never re-saves, and quietly stops covering the
   version in use. Restore is therefore prefix-keyed with `restore-keys`;
4. the save is guarded on that output being non-empty. An entry written under
   the bare prefix EXACT-matches later restores and shadows the good
   version-keyed entry that `restore-keys` would have found.

A warm dev dir makes node-gyp's `--ensure` stat the dir, read `installVersion`,
re-check `<arch>/node.lib` on Windows, and report `version is good` with no HTTP
request at all. A COLD cache still downloads twice and keeps the original
exposure: this narrows the window to roughly one run per Node patch bump, it
does not make the fetch robust. Serializing the two installs would also work,
but pnpm honours `--child-concurrency` only as a CLI flag (the
`npm_config_child_concurrency` env form is ignored — measured), and that would
mean parameterizing the shared composite's install command, which
`setup-workspace/action.yml`'s own header rules out.

### Coverage is a separate workflow (`.github/workflows/coverage.yml`)

Coverage used to be a job inside `test.yml` running on every `synchronize` —
11-14 min of re-instrumentation on EVERY push. Series C R7 demoted it to once
per PR lifecycle: it runs on non-draft `opened`, `ready_for_review`, non-draft
`reopened`, or an explicit `coverage` label add. It does NOT run on
`synchronize`. `nightly-coverage.yml` remains the authoritative threshold gate;
per-PR coverage is advisory Codecov patch signal only.

When DB is directly changed, the advisory workflow isolates its coverage from
the recursive package runner. It executes the same native Vitest `1/2` + `2/2`
shard set as required Unit and nightly coverage, sequentially on the single
2-vCPU host, then uses `--merge-reports=.vitest/blob`.
Vitest 5 blob output, cleanup, counting and upload/download paths all use
`packages/db/.vitest/blob`; keep the two-blob assertion and hidden uploads.
Paired: `scripts/__tests__/nightly-coverage-sharding-contract.test.mjs`. Other affected packages retain
`--workspace-concurrency=4` and explicitly exclude DB. This boundary is
load-bearing: run 30704747207 let DB share the host with another package and a
10-second type-contract test timed out after 24 minutes. Do not widen that test
or serialize every package; keep only the PGlite-heavy DB task isolated.

#### The embeddings integration lane is serialized (BST-1072, settled 2026-08-01)

`packages/embeddings`'s `test:integration` runs
`--maxWorkers=1 --no-file-parallelism`, following the `apps/desktop` precedent.
It is NOT an instance of the "don't serialize every package" rule above: that
rule is about CPU contention, this is about **memory**.

The before-state, corrected (the first version of this section claimed the lane
ran with "no cap of any kind" on "the 2-vCPU runner"; review caught both): the
integration config inherits `pool: 'forks'` and `maxWorkers: '50%'` from
`vitest.config.mts`, and `Unit (rest)` runs on the 4-vCPU/16-GB Ubicloud class
(see the `unit-shard` comment in `test.yml`), so the lane ran **2 workers** and
the serialization is 2 → 1. The 2-vCPU figure belongs to `coverage.yml`'s
`ubicloud-standard-2` host in the section above, a different workflow.

The in-lane flag is also not the only concurrency knob: `test.yml` invokes
`pnpm turbo run test:integration … --concurrency=2`, so a SECOND integration
lane from the SAME `rest` partition (agent, web, file-import…) can share the
box with embeddings — desktop/ui/file-explorer-ui/app-shell cannot, they run
in the separate `heavy` matrix row. The memory accounting is therefore 2 × the
measured **~1.9 GB RSS per worker** (real PGlite plus WASM embedding heaps)
PLUS the co-scheduled rest-partition lane's peak, against 16 GB. Anyone
re-measuring must hold that cross-package factor constant.

**What is proven vs. plausible.** Proven: the crash is concurrency-dependent
and not a bug in one test — the victim VARIES (across two failing runs on
PR #2213 the file that never reported was `embedding-worker-model-resolution`
once and `embedding-worker-batch` the other time), and the serialized lane
passes. The worker died with `[vitest-pool]: Worker exited unexpectedly` and
the job reported `Test Files 11 passed (12)` — the twelfth file never reported
at all. Supporting the MEMORY account specifically: the crash never reproduced
on a developer Mac (74/74) even though a Mac runs `maxWorkers: '100%'` —
strictly MORE concurrent workers than CI's 2 — with far more RAM, so worker
count alone does not produce the crash; available memory does. NOT directly
observed: the precise ceiling that killed the worker. Memory pressure from two
workers plus a co-scheduled lane is the best-supported account, not a captured
OOM kill.

It surfaced on any PR marking embeddings as AFFECTED — which includes editing a
widely-depended-on package such as `assistant-contract`, not just root config —
so it repeatedly failed the required `Unit` check for changes that touch no
embeddings code (5 of 6 observed runs).

Do not remove these flags to speed the lane up without first re-measuring peak
RSS against the runner's 16 GB with the turbo `--concurrency=2` co-lane held
constant.

#### A worker with a blocked event loop is killed and named (BST-1221)

`LostTestFileReporter` below needs the worker to DIE. The PGlite wedge does
the opposite: PGlite 0.5.8's synchronous protocol loop retries
`_PostgresMainLoopOnce` forever after a WASM trap (`function signature
mismatch` in `$palloc`), so the worker spins at 100% CPU with its event loop
blocked. (The trap that reached that loop was the BST-1320 close race — a
Mastra statement floating into `close()` — not a Node or V8 defect; see
`docs/agents/assistant-persistence.md`. The watchdog stays because any blocked
loop, whatever reaches it, must fail by name.) `testTimeout` is a timer in
that loop and never fires, the worker never reports, turbo prints nothing,
and the job is cancelled at its 30-minute limit
with no verdict (`Unit (rest)`, run 34653237231, PR #3141).

Every lane that hosts real PGlite (`agent`, `app-shell`, `assistant-data`,
`assistant-service`, `db`, `db-explorer` unit and integration, `desktop`,
`embeddings`, `file-import`) lists
`@brainstrike/test-utils/vitest.event-loop-watchdog.setup` FIRST in
`setupFiles` (`packages/test-utils/vitest-event-loop-watchdog.mjs`). First,
because its heartbeat interval is captured at module evaluation and must be a
real timer, ahead of any setup that could install fake timers. It runs a
`worker_threads` watchdog with its own event loop; the main thread heartbeats
every second, `beforeEach` labels the running test, and after
`BRAINSTRIKE_VITEST_EVENT_LOOP_STALL_MS` (default 60 s — at or above every
lane's `testTimeout`; `db-explorer` integration ties at 60 s, which is
harmless because a slow-but-async test keeps heartbeating and only a genuinely
blocked loop can reach the stall) of silence the watchdog writes one stderr
line naming the test and SIGKILLs the worker. The lane list is enforced:
`scripts/verify-event-loop-watchdog.mjs` (paired test in `scripts/__tests__`,
run by `pnpm test:scripts` in the Static job) loads all 16 listed configs,
including the actual `test:integration` configs independently of their base,
and requires the setup to be the FIRST effective `setupFiles` entry (or the
sole string value). Override/reordering fixtures prove that the guard rejects an
integration config that removes the inherited watchdog. A config declaring
projects requires an explicit project in the lane contract; top-level setup
cannot stand in for the setup that its project files run. Load failures are reported by
config path alongside every other failing lane. A new
PGlite-hosting lane is added to that list, and a second-position or missing
entry fails Static rather than silently reintroducing the hang.

Outcome by pool: in a `forks` lane (`agent`, `db`, `embeddings`, `db-explorer`
integration) the child worker dies, the vitest process survives, and the
lost-file reporter fails the run naming the file. In a `threads` lane
(`assistant-data`, `app-shell`, `file-import`, `db-explorer` unit) the vitest
worker is a thread of the vitest process, so SIGKILL takes the whole run and
the stderr line is the only attribution. Both replace a silent 30-minute hang
with a named failure in about a minute. This is not a retry, timeout increase
or suppression: the wedge still fails the lane.

Debugging: the watchdog does not start when the process was launched with
`--inspect*` (execArgv or `NODE_OPTIONS`) and says so once on stderr, so
`vitest --inspect-brk` keeps working on these lanes.

Paired tests: `packages/test-utils/__tests__/vitest-event-loop-watchdog.test.ts`
(blocked loop killed and labelled; responsive worker exits on its own; inspector
opt-out — `inspector.url()` first, then the `--inspect`/`--inspect-brk` flags;
impossible heartbeat budget and non-integer budgets refused, under a debugger
too) and its vitest fixture runs: two healthy files under isolated forks and
under a REUSED worker (`isolate: false`, the registry-reuse path) with no
spurious kill, and a named kill of a blocking file under both `forks` and
`threads`. Proof against the real wedge is on BST-1221.

#### A test file with no verdict fails the lane (BST-1221)

Every package/app `vitest.config.mts` registers `LostTestFileReporter`
(`packages/test-utils/vitest-lost-file-reporter.mjs`), enforced across the
workspace by `scripts/verify-lost-file-reporter.mjs` and its paired test. A new
package's config is a violation until it opts in — the guarantee is per-config
and would otherwise be lost silently by omission.

**What it defends against.** A worker can die mid-run without unwinding: a V8
fatal (`Check failed: jit_page_->allocations_.erase(addr)` →
`ThreadIsolation::UnregisterWasmAllocation` → `V8_Fatal`) or an OOM kill. The
file that worker held reports nothing. Measured on vitest 4.1.10:

- the lost module IS present at `onTestRunEnd`, with `state() === 'pending'`;
- the run's own verdict is **`reason: 'passed'`**;
- the summary reads `Test Files 2 passed (3)` — PASS phrasing whose only tell is
  a parenthesised total that does not match;
- the process exits non-zero ONLY via the separate unhandled-errors channel
  (`[vitest-pool]: Worker exited unexpectedly`).

That last point is why the reporter exists rather than trusting the exit code.
The non-zero exit is not a property of the results; it is a side effect of an
error channel that `dangerouslyIgnoreUnhandledErrors: true` switches off.
Control-tested: with that one flag set, a run that dropped an entire test file
exits **0** and reads fully green. With the reporter registered the same run
exits **1** and names the file. `--reporter` on the CLI OVERRIDES config
`reporters`, so a lane that passes its own `--reporter` (e.g. the nightly
`--reporter=blob` coverage shards) drops this guard — add the reporter
explicitly there if that lane ever needs to gate.

**Concurrency tuning is NOT a mitigation for this one.** Unlike BST-1072 above,
which was memory pressure and was genuinely fixed by serialization, two of the
observed BST-1221 hits landed in lanes that were ALREADY serialized to a single
worker — `@brainstrike/embeddings#test:integration` (`--maxWorkers=1
--no-file-parallelism`, 2026-08-16, red main) and the desktop unit lane (same
flags, 2026-08-18). Do not "fix" BST-1221 by lowering worker counts; the
evidence disproves worker-count reduction as a fix. The reporter detects the
failure; it does not correct the runtime defect or permit merging with it.

**Runtime correction and qualification (BST-1221, 2026-09-11).**
The Node 24.20.0 Linux x64 stack from PR #3137 resolves through
`WasmImportWrapperCache::Free`, `WasmCodeRefScope::~WasmCodeRefScope`, and
`Runtime_TierUpWasmToJSWrapper`. V8's
[dying-wrapper reference fix](https://github.com/v8/v8/commit/9b8ca54d5a6b6c615eb7ad6d9e2bdca7f8cb1a81)
replaces reference acquisition before the dying-state check with atomic
`AddRefIfNotDying`. Node 24.20.0 and 24.21.0 retain the unsafe order; Node
26.8.2 contains the corrected reference handling and subsequent wrapper
ownership changes. The repository pins Node 26.8.2 for development and CI.
The matching `devEngines.runtime` declaration makes pnpm scripts use that
checksum-locked executable even when invoked by a hosted builder's older Node.
Root/web and MCP package installation ranges admit the bounded Node 24 application/hosting
major and Node 26 tooling major; the managed script runtime remains exactly 26.
Vercel Functions currently supports Node 24, not 26. Its separate stateless
hosted-web entrypoint excludes PGlite and browser-local model inference; validate
the generated function runtime and deployed routes when changing this boundary.
Browser-local WASM executes in the browser engine, not the function runtime.
Electron retains its own bundled Node/V8; changing `.nvmrc` does not upgrade
Electron's runtime. Shared production code keeps Node 24 declarations matching
Electron's Node API surface, while the build and test executable uses Node 26.
The MCP packages also run inside that application and retain the bounded Node 24
consumer arm. Tooling-only source uses the same conservative types catalog;
new tooling APIs require an explicit compatible design, not a cast around it.
`apps/desktop/package.json#config.nodeRuntimeMajor` declares that API floor;
the required real Electron native smoke test compares both the declaration and
the installed typings with `process.versions.node`. The static alignment guard
checks the toolchain and production API floor separately, preventing Node
26-only APIs from compiling into the Node 24 application runtime.

The exact toolchain patch is intentional: local and CI qualification must name
the same executable. React Doctor also receives this explicit Node version:
its composite action otherwise installs Node 24, whose npm rejects the managed
Node 26 declaration before scanning. The paired action-version contract guards
that input against `.nvmrc`. Any added composite action that runs npm/npx
from the workspace must select the managed Node version too; its private
default does not inherit the surrounding job setup. Updating the pin requires qualifying the replacement;
future patch releases must not be assumed to have passed this evidence.
The DB unit project explicitly includes `__tests__/**/*.test.ts` without an
integration-suffix exclusion (unlike some other package scripts). It runs
100 startup/query/close cycles as a persistent
runtime canary. Its existing 10-second per-case timeout and two-worker CI cap
remain unchanged. A lost file fails; only the complete three-marker signature
below is classified as the V8 fatal, so an ordinary OOM is not mislabeled.

Source correspondence identifies a correction candidate, not proof that an
intermittent crash has disappeared. Qualification requires repeated affected
workloads on the affected Linux x64 platform, preservation of every outcome,
exact-head required checks, and replacement-main verification. A single passing
run, passing rerun, or macOS ARM64-only test is insufficient. Any recurrence
blocks completion and requires investigation; no quarantine, skip, or accepted
runtime-defect exception applies.

**Historical fixture changes, not a runtime fix (2026-08-26).**
Sharing a PGlite instance reduced instantiate/teardown churn in
`embedding-queue-load.integration.test.ts`; later crashes, including #3137,
disproved this as a complete correction. Earlier claims that this isolated the
dominant trigger or proved a PKU-specific cause exceeded the evidence.
`--no-memory-protection-keys` was tried and disproven (2026-08-22). Preserve
correct fixture ownership, but do not substitute reduced workload for fixing
the runtime.

**In-memory fixture ownership (BST-1221, 2026-09-05).**
`wasmLoader.createPGlite('memory://...')` returns an uncached handle;
`closeCached(dataDir)` cannot close it. Assistant-data fixtures must use
`src/__tests__/helpers/test-pglite.ts`, which registers direct handle cleanup
with Vitest's `onTestFinished`. It also respects a handle explicitly closed by
a migration test's `finally` block. The real runner regression in
`test-pglite-lifecycle.integration.test.ts` observes both owned databases after
cleanup and fails if either remains open. The fixture keeps a fresh database
per test; it does not share mutable state, lower concurrency, or suppress the
native-fatal/lost-file guards. The app-shell analytics and desktop live-usage
fixtures likewise close their returned handles directly. The prior teardown leaked the in-memory handles
and relied on process/GC cleanup under repeated WASM initialization pressure.

The required Unit test and integration steps additionally run through
`scripts/run-test-command.mjs`. The wrapper streams stdout/stderr unchanged,
preserves the command's exit status except that a classified fatal fails the
lane even if the wrapped command exited zero, and recognizes only the complete
three-marker native signature in one bounded output region: the exact
`jit_page_` allocation assertion, `V8_Fatal`, and
`ThreadIsolation::UnregisterWasmAllocation`. When all three are
present it emits the machine-readable
`BRAINSTRIKE_CI_VERDICT=V8_WASM_JIT_TEARDOWN_FATAL` verdict with explicit
BST-1221 guidance. A generic worker exit, lost file, assertion failure, or
partial V8 text is not classified as this defect. This is deliberately not a
retry or suppression: the required lane stays red, but the native fatal can no
longer be mistaken for an ordinary test assertion or a resolved rerun.

#### Codecov statuses are non-gating (settled 2026-07-26 — do not relitigate)

The ruleset requires exactly five contexts — `Static`, `Unit`, `Build`,
`Web E2E`, `Desktop E2E` — all produced by `test.yml`. `codecov/patch` and
`codecov/project` are NOT among them, so a failing Codecov status can never
block a merge; it only renders a red X and an `UNSTABLE` merge box.

`codecov.yml` nonetheless carried the comment *"Keep patch coverage blocking
instead"*, contradicting both `test.yml` and this document. Two sources plus the
ruleset agreed; `codecov.yml` was the outlier and was simply wrong. Resolved by
making the config match reality in Codecov's own documented way:
`coverage.status.patch.default.informational: true` — the status still posts and
still shows the percentage, it just never fails
(<https://docs.codecov.com/docs/commit-status>). `target`/`threshold` are kept
deliberately so the number remains visible.

Two independent reasons patch coverage must not gate here, both measured:

- **PR uploads are affected-only**, so patch % is systematically understated. On
  PR #2024 Codecov reported **27.86%** while the three changed source files
  measured **97.5% / 98.07% / 98.21%** locally.
- **A stacked PR has no BASE report**, so Codecov cannot compare at all and says
  so: *"Please upload report for BASE"*. `codecov.allow_pseudo_compare` (default
  true) does not rescue this — it substitutes a parent commit for skipped-CI and
  merge-commit bases, not for a branch that never uploaded a report.

The authoritative gate is unchanged: `nightly-coverage.yml` →
`pnpm coverage:enforce` (`scripts/enforce-coverage.mjs`), full unfiltered
coverage with ratcheted per-package thresholds, which opens an issue on failure.

`scripts/verify-codecov-status-contract.mjs` (run by `pnpm test:scripts` in the
Static job) enforces this. Two properties it must hold, and the first review of
it found six violations of the first:

- **Never pass vacuously.** Codecov reads `coverage.status.<type>` as a MAP OF
  CONTEXTS, so every child of an enabled status must itself be disabled or
  explicitly `informational: true`. That single rule covers the shapes that
  previously slipped through: an empty or array status block, settings written
  flat without a `default:` wrapper, a scalar context (`default: true`), an
  empty mapping, and a status-level `informational:` shorthand that is not
  documented and would have waved through a still-gating `default`.
- **Never fail a valid config.** `pnpm test:scripts` runs in the REQUIRED Static
  check, so a false positive blocks every merge — worse than the red X this
  removed. Hence `off` is matched case-insensitively (`yaml` v2 uses the YAML
  1.2 core schema, where bare `off` is the STRING `'off'`, not a boolean), and
  unknown keys under `coverage.status` are REPORTED, not fatal: Codecov
  publishes exactly `codecov/project`, `codecov/patch` and `codecov/changes`, so
  nothing else there can gate.

It also searches every location Codecov reads config from — root, `dev/`,
`.github/`, as `codecov.yml` or `.codecov.yml` — and fails if two exist, since
which one wins is undocumented and a second file could silently change the
effective config.

**Re-gating is a two-part change**: PR uploads must become complete AND the
context must be added to the ruleset. Doing one without the other re-creates the
contradiction.

Nightly package coverage uses six static GitHub Actions matrix shards plus two
native Vitest DB shards and a DB merge job. Five package shards isolate the
measured heavyweight lanes; the sixth is a negative-filter remainder, so a new
package with a `test:coverage` task is covered automatically instead of
requiring registry maintenance. Each DB row uploads Vitest's blob report under
its native `1/2` or `2/2` identity. The merge job requires exactly two blobs,
runs Vitest's own `--merge-reports` coverage union, and uploads one DB JSON tar
archive. The final `coverage` job still fails closed unless all seven package
archives (six general plus the one natively merged DB archive) are present,
restores them into one workspace, and is the only job that runs
`coverage:prepare-workspace`, `coverage:enforce`, the merged report, and
Codecov. Each shard emits its blob plus a text summary; it does not render the
unused HTML/Clover report tree. Do not replace this with a generated planner
or raise the original shared timeout: the split preserves one authoritative
threshold decision while giving slow packages independent failure and timeout
domains.

Native packages may retain a `test:coverage` alias that deliberately runs their
real addon tests without instrumentation. The artifact-completeness check
requires JSON only from coverage-producing scripts (those invoking
`--coverage`); it still fails when any instrumented package omits its artifact.
This distinction does not exempt instrumented code or relax a threshold.

**Why its own file, and why you must not merge it back into `test.yml`:** the
label trigger requires subscribing to the `pull_request` `labeled` action.
`test.yml` is the SOLE producer of all five required status checks, so if it
subscribed to `labeled`, every label add would fire it and each required job
would need an `if:` guard — reporting a `skipped` check run for every required
context. Measured on PR #1664: merges are NOT blocked (`skipped` satisfies a
required check — `gh pr view --json mergeable` returned MERGEABLE), BUT the
merge box renders the LATEST check run per context, so all five required checks
displayed as `skipping` instead of `pass`. The `codex` label is already in use,
so this would hit a real flow. Splitting the file means `test.yml` never fires
on `labeled` and green stays green. It also avoids a footgun: under the guard
design, every NEW job added to `test.yml` would have to remember an `if:` guard
or silently run on label churn.

`coverage.yml` sets `cancel-in-progress: false` deliberately — it subscribes to
`labeled` for ALL labels (GitHub cannot filter label names at the trigger
level), so an unrelated label creates a run whose job is skipped; since
workflow-level concurrency is evaluated before job-level `if:`, that no-op run
would otherwise cancel an in-flight 11-14 min Coverage run.

### Assistant stop/retry verifier (BST-1728)

`apps/web/e2e/assistant-panel-interactions.test.ts` selects the browser-local
model and injects a controlled `LocalLlmBackend` at the web app's existing
backend factory. The explicit fixture is restricted to webdriver automation;
ordinary sessions still lazily load the native Gemma backend. The test asserts
that `window.llmHost` is absent: adding this desktop bridge would exercise an
unreachable hybrid of the web transport and desktop host adapter.

The real browser adapter must supply streaming callbacks and an AbortSignal.
The fixture streams cumulative text snapshots, and Stop must abort the signal
owned by that generation. Regenerate uses the current accessible name
(`Regenerate response`), starts a distinct generation with the original prompt,
and finishes with the complete text (not an appended delta). That completed
generation must never enter the cancelled set. A long response is stopped the
same way. No provider key, model download, conditional action, sleep, retry or
availability skip is needed.

Before weakening these assertions, repeat the manual falsification procedure:
disconnect the adapter's AbortSignal from backend generation, verify failure,
then restore it and verify the test passes. UI visibility alone is insufficient
evidence of cancellation.

### `pnpm check` is a mirror of test.yml, not a second CI definition (BST-1009)

`scripts/check.mjs` is the local gate. It has ZERO workflow references and is
not in `lefthook.yml`, so it is pure human/agent convenience — which is exactly
why a false green there is dangerous: it is the thing people cite as "CI-
equivalent" before pushing.

It was one. The pre-BST-1009 plan ran `lint-all`, `build`, `type-check`,
`test:coverage:split`, `coverage:enforce`, `test:browser`,
`test:e2e:functional`, `test:e2e:desktop` — a second, divergent definition of
CI whose divergences were silent:

- `test:coverage:split` → `test:coverage:base` =
  `pnpm -r --filter '!@brainstrike/db' --filter '!@brainstrike/embeddings' run test:coverage`.
  **A green `pnpm check` had never run `packages/db`** — the largest suite in
  the repo and the one turbo task that can never be replayed from a cache hit.
- It omitted three Static gates: `pnpm secrets:scan`, `pnpm exec turbo
  boundaries`, and **`pnpm test:scripts`** — i.e. the
  gate that runs the guard-script tests did not run in the local gate that
  guard scripts exist to protect (BST-836 again, one level up).
- `lint-all` = `pnpm lint && pnpm format`, which **writes** (`biome check .
  --fix`); CI's `lint:ci` is read-only. A gate must not rewrite the tree it is
  judging.
- It ran whole E2E suites where CI runs the smoke *lanes*.

The rewrite conforms to `test.yml` rather than paraphrasing it. Rules that must
survive future edits:

- **Turbo-native where CI is turbo.** The unit lanes are
  `turbo run test --concurrency=4` then `turbo run test:integration
  --concurrency=2` under `TURBO_TEST_MODE=unit`, unfiltered — CI's three Unit
  shards are an affected-set PARTITION of those same two tasks, and unfiltered
  is their union. Never reintroduce a `pnpm -r` filter list here; that is the
  shape that drifted.
- **Read-only lint by default.** `--fix-lint` is the explicit opt-in to the
  writing chain.
- **The install is `--frozen-lockfile`**, matching
  `.github/actions/setup-workspace`. A plain `pnpm install` silently UPDATES
  `pnpm-lock.yaml` when a workspace manifest has drifted from it and continues
  green, while CI rejects that same input — a false green in the install step
  of the script that exists to stop false greens.
- **The Playwright lanes run under `CI=true`, and nothing else does.** Both
  `playwright.config.ts` files branch on `config.isCI` for `forbidOnly`,
  `fullyParallel`, `globalTimeout`, `retries`, `workers`, `reporter`, the
  Chromium launch args and `trace`, and the `e2e/utils` helpers key their wait
  budgets off `CI` too — so without it a stray `test.only` in an `@web-smoke`
  test passes the lane locally while the required Web E2E job rejects the same
  source. Playwright's `--forbid-only` flag was considered and REJECTED: it
  repairs one of ~10 CI-conditioned divergences. **Do not hoist `CI` to the
  whole run (BST-1050)**: it would change the WORKLOAD of the unit lanes, not
  just their environment — `getTimeoutMultiplier()` returns 2 under `CI`, and
  `packages/vector-management`'s base vitest config switches on a 70% line
  threshold when `CI === 'true'`. It belongs to the four Playwright
  invocations and nowhere else; the parity test asserts both halves.
- **Vitest timeout parity uses `TEST_TIMEOUT_MULTIPLIER=2`, not `CI=true`.** The
  four Unit workflow steps, Nightly Coverage's Turbo steps, root Vitest battery
  scripts (`test`, `test:fast`, browser and coverage), and every Vitest phase of
  `pnpm check` set the dedicated variable explicitly. Turbo declares it in the
  unit, integration, browser and coverage task families' `env` rather than
  `passThroughEnv`: timeouts can change pass/fail, so the value must be part of
  the cache key and must not disappear in strict environment mode. Using `2`
  everywhere preserves cache sharing between official PR and push paths while
  avoiding CI-conditioned coverage changes locally. The cacheable `test` task
  also hashes `CI` itself: CI changes Vitest worker counts and some package
  coverage workloads, so replaying a local green under CI would be unsound even
  with the same timeout multiplier. Direct package/editor invocations
  intentionally retain the unscaled base unless the caller opts into
  `TEST_TIMEOUT_MULTIPLIER=2`; that keeps isolated iteration honest while
  allowing a contention-bearing run to request the gate policy explicitly.
  `getTimeoutMultiplier()` gives the explicit variable precedence, accepts only
  a positive plain decimal no greater than 10, and throws on malformed or
  runaway values; with no explicit value, the existing CI=2 and DEBUG=5
  defaults remain. That validation contract applies where Vitest timeout policy
  is consumed; native `node --test` tasks do not read this setting and are not
  silently choosing a fallback timeout from it.
- **The multiplier also governs `@testing-library/dom`'s async utilities**
  (`waitFor`, `findBy*`), not only explicit Vitest timeouts (BST-1299). That
  budget lives in library module state, so `configure({ asyncUtilTimeout })` is
  the only way to set it and it must run in the test runtime — a Vitest setup
  file, never Vitest config. The base stays the library's own 1000ms, so an
  unscaled lane behaves exactly as before and a genuinely hung `waitFor` still
  fails fast; `getAsyncUtilTimeout()` in `@brainstrike/test-utils` applies the
  multiplier on top. **Every lane whose tests call `waitFor`/`findBy*` must load
  one of the two timeout setups** — there is no lane that legitimately opts out
  and still uses the async utilities. Node lanes on the shared `vitest.setup`
  get it for free (it side-effect-imports `vitest.timeouts.setup`); lanes that
  deliberately run without the shared setup load
  `@brainstrike/test-utils/vitest.timeouts.setup` directly, which is hook-free
  precisely so they can (`packages/settings-ui` and `packages/app-state`, which
  want none of the shared `beforeEach`/`afterEach` hooks, and `packages/db`,
  whose own `vitest.setup.ts` imports it). The browser lane cannot use either
  (`process` does not exist in the page, and the shared setup imports
  `node:buffer`), so `createBrowserProject` takes a REQUIRED `asyncUtilTimeout`,
  publishes it via `test.provide`, and `vitest.browser.setup` `inject`s it —
  required rather than defaulted because a browser project silently inheriting
  an unscalable 1s budget is precisely the defect. `setupFiles` is required and
  caller-owned for the same reason twice over: `@brainstrike/config` is
  `tooling` and may depend on nothing (a hard-coded
  `'@brainstrike/test-utils/…'` string is that dependency, merely invisible to
  the domain-boundary contract because it is not an `import`), and a factory
  default would be silently droppable by the `{ ...browserProject.test }` spread
  every consumer writes. The factory also derives `testTimeout` as 5x that
  budget — the ratio Vitest's and @testing-library's defaults happened to have —
  so a failing `waitFor` always reports its last assertion instead of being cut
  short by a bare Vitest timeout. Browser projects that build their own config
  instead of calling `createBrowserProject` (`packages/db`, `packages/storage`)
  use no @testing-library in their browser suites and are deliberately left out.
  Paired tests:
  `packages/test-utils/src/__tests__/testing-library-timeouts.test.ts`,
  `packages/config/__tests__/vitest-browser.test.ts`, and one
  `async-util-timeout-wiring.browser.test.ts` per browser lane
  (`packages/assistant-ui`, `packages/ui`) built on the shared
  `registerAsyncUtilTimeoutProof`. That proof times a real failing `waitFor`
  against the configured budget — the one assertion a duplicated
  @testing-library/dom instance cannot satisfy — and it is per-lane on purpose:
  the duplicate is created by an individual lane's Vite dependency optimizer, so
  a lane with a hand-curated `optimizeDeps.include` (both of these) must list
  `@testing-library/dom` and prove the result itself.
- **`--full` is additive**, not a swap: the required-check mirror plus
  `nightly-coverage.yml`'s threshold gate and the full E2E regression lanes.
  `--fast` drops only the lanes CI fans out to separate runners (Browser tests,
  E2E) and reports those omissions in the banner. `--fast --full` is rejected
  because it would otherwise request contradictory E2E selections; `--no-coverage`
  is valid only with `--full`. Coverage is deliberately NOT in the default
  plan, because it is not a required check.
- **`--continue=dependencies-successful` (mirroring the Build job) changes
  turbo's scheduling, not its exit code.** `runStep()` rejects on ANY non-zero
  exit and the orchestrator is fail-fast, so a `--continue` run still fails the
  whole command. A test proves this with a real `exit 3`.
- **A CI gate that is not run locally must be DECLARED**, never quietly
  dropped. `CI_GATES_NOT_RUN_LOCALLY` in `check.mjs` names platform exclusions;
  `uncoveredCiGates()` adds any gates omitted by the selected mode flags before
  printing the banner. The static list currently holds exactly the two native
  jobs (`native-windows`: needs a Windows host; `native-electron`:
  electron-builder packaging for the runner's own platform, non-required,
  ~25 min).

`scripts/__tests__/check-ci-parity.test.mjs` (Static job, via
`pnpm test:scripts`) holds the line. It parses every `run:` step in `test.yml`
and requires each to be (a) mapped to a plan step id `buildPlan()` emits,
(b) named in `CI_GATES_NOT_RUN_LOCALLY` with a reason, or (c) listed as runner
plumbing in its `PROVISIONING_STEPS` set. Anything else fails, so a NEW CI gate
cannot be silently missed.

**It compares COMMANDS, not names**, and that distinction is the contract.
`gateInvocations()` reduces both the CI `run:` text and the mapped plan
command(s) to the set of pnpm scripts, turbo tasks and node scripts each
actually invokes (splitting on newlines/`&&`/`;`, seeing through
`pnpm --filter X <script>`, `pnpm turbo run`, this repo's
`run-turbo-command.mjs -- run`, and a `dbus-run-session --` prefix), then
requires the CI set to be a subset of the plan set. Asserting only that a
mapped id still exists was itself the drift class: `pnpm test:scripts` could
become `pnpm test:scripts && pnpm run new-gate` with the contract still green
and the new gate running in CI and nowhere else. A CI step whose token set
comes back EMPTY fails unless it is declared in `SHELL_GATE_STEPS` naming the
test that covers its drift (only `build › Validate CSS bundle` today, covered
by the byte-floor/duplicate-layer comparison).

Per BST-836 every part of that is control-tested — a synthetic `check.mjs` with
a gate deleted from the plan; another with an exclusion entry deleted; a
MUTATED `test.yml` whose `Script tests` step gains `&& pnpm run
new-uncovered-gate`; and the parity assertion run with `SHELL_GATE_STEPS`
emptied — each must make it throw. `gateInvocations` has its own control
asserting it really extracts the shapes both sides are written in, because a
comparator that silently returned nothing would make every command comparison
vacuous. Both mutation helpers fail loudly if their own edit matched nothing:
that already fired once on this branch when `biome check --write` sorted object
keys out from under a literal anchor.

The mapping is exhaustive in BOTH directions: a missing entry surfaces as an
unmapped step, and a STALE entry — one naming a step `test.yml` no longer has —
fails its own test, because otherwise it would quietly shrink what the contract
checks while every test stayed green.

The local CSS validation is `scripts/validate-css-bundle.mjs`, a small Node
script rather than the workflow's POSIX shell snippet, so it makes the same
byte/pattern assertions on Windows as on Unix; its paired controls prove both
failure modes still fail. CI's half of that step is still inline shell, which
is why it remains in `SHELL_GATE_STEPS` — that entry now means "CI's command is
unparseable by the comparator", not "nothing verifies this".

What this deliberately does NOT catch: a mapped CI command that gains or
changes a FLAG the local plan does not mirror (say `lint:ci --max-warnings=0`).
The token model compares which gates run, not their every argument. Snapshotting
each `run:` block verbatim into the test was tried and rejected — it is a
hand-maintained second copy of `test.yml`, the exact shape this section exists
to remove, and its failure mode invites a paste-and-move-on update rather than a
decision. The arguments that actually carry a contract are asserted
individually, read live from the workflow: the Unit lanes' `--concurrency=4`
and `--concurrency=2`, and Build's `--continue=dependencies-successful`.

Local-vs-CI difference that is stated rather than hidden: the boundary gate
(`pnpm run boundaries`) treats git-ignored files as generated rather than
source, and a developer's personal excludes (`~/.config/git/ignore`,
`.git/info/exclude`) count locally while CI's checkout has neither — so CI is
the stricter side. This used to read the other way round, that a stale local
`dist/` could produce a phantom violation the clean CI checkout never saw;
scoping the verdict to non-ignored files removed that difference, and with it
the `pnpm clean`-and-rerun ritual. See the BST-967 section above.

### Guard-script entrypoint contract (BST-836)

Every `scripts/verify-*.mjs` MUST run its check when executed directly and MUST
export `main({ repoRoot })`. Four of them (`verify-catalog-references`,
`verify-config-load-hash-coverage`, `verify-no-vitest-worker-mutation`,
`verify-workspace-src-aliases`) previously shipped as pure libraries with no
`main()` invocation, so `node scripts/verify-catalog-references.mjs` exited 0
while checking nothing. Control-tested: injecting a literal `"typescript":
"6.0.3"` into a package manifest — the exact drift the guard exists to catch —
still produced exit 0.

Enforcement was never missing; each guard's paired test or dedicated lint gate
asserts the real-repo verdict in the Static job. In particular, the ESLint
warning baseline's full-tree owner is `lint:ci` -> `lint:eslint`, after script
tests. The damage was evidentiary — that exit 0 was cited as proof in a PR body,
and a green from a script that cannot go red is indistinguishable from a real
one.

`scripts/__tests__/verify-script-entrypoints.test.mjs` holds the line, and its
MONEY TEST is the load-bearing half: it drives every `main()` against an empty
directory and fails any that report success. A `function main() {}` no-op
satisfies the static "has an entrypoint" check while reproducing the bug exactly,
as does a `main()` that accepts `repoRoot` and ignores it — both are covered.
The real child-process probe also covers direct-execution detection. Expensive
entrypoints may use an explicit bounded invalid root there when the owning gate
already retains the full-repository verdict; that bounded probe must require its
fixture-specific failure output and a nonzero exit.

Consequences when adding a guard: thread `repoRoot` through to the check rather
than closing over a module-level constant, and make the CLI's verdict identical
to the paired test's (e.g. `verify-workspace-src-aliases`'s `main` passes
`appsRoot` explicitly because the CI-wired test does — a CLI checking a narrower
tree than CI is a second, weaker verdict wearing the same name).

`verify-tokenizer-asset-bundle` and `verify-no-cross-chunk-cycles` are the
shape exceptions: each inspects a build artifact, so it takes a bundle
`directory` instead of a repo root.

### Desktop assistant setup promise ownership (BST-1639)

`apps/desktop/e2e/utils/assistant-mock.ts` separates asynchronous credential
persistence from synchronous renderer configuration. The pending write has an
explicit, scoped owner: `evaluateHandle` returns a remote object containing
**both the original write promise and its tagged completion**. Observe rejection
in the same renderer turn as `saveKey`; attaching the first rejection handler in
a later CDP command produces an unhandled-rejection event for an immediately
rejected write. Await the tagged completion, propagate the original rejection
or structured write failure, and dispose the handle in `finally` before
configuring the renderer. A missing write bridge is a visible failure. Never
substitute retries, a global promise pin, or a timeout increase.

The original smoke failure occurred during the second assistant setup, after
the folder fixture's thread-seeding reload. Its trace was created but never
uploaded: the workflow looked in `test-results` while desktop Playwright writes
to `blob-report`. Both required desktop smoke lanes and both nightly desktop
uploads now target `apps/desktop/blob-report/`, matching the already-correct
packaged MCP uploader.
Both Playwright test attachments (`outputDir`) and its blob reporter use that
directory. Uploaders warn if it is missing: `failure()` also covers setup/build
failures before Playwright has run, when no test artifacts exist. This absence
prevents reconstructing the precise GC schedule in that historical execution.

The controlled regression in `assistant-panel.desktop.test.ts` invokes the
public `setupAssistantMock` helper in an isolated Electron renderer, with a
collectible pending writer and explicit `HeapProfiler.collectGarbage`. The
pre-fix helper reproduces `Resulting promise was garbage collected`; the owned
write survives until settlement. Public JSHandle instrumentation verifies that
disposal completes on every outcome and that the released handle is unusable
while its renderer remains responsive; the test does not demand that V8 reclaim
a released object by a deadline. A missing-disposal negative control fails this
contract. It also
covers delayed and immediate rejection, structured failure, and navigation,
including the absence of unhandled renderer errors. The regular assistant and
folder specs continue to exercise the real frozen preload bridge and complete
product workflows. The isolated writer does not replace the production bridge.

Electron 43's V8 inspector holds awaited evaluation results weakly; see
[V8's promise-lifetime fix and regression](https://github.com/v8/v8/commit/5177b10891e65108c1a19dfc56bff4e58d79d216).
Retaining an outer async wrapper alone does not retain the promise it awaits,
so an Electron upgrade is not a substitute for testing this helper's ownership
boundary. The upload pairing is guarded by
`scripts/__tests__/desktop-smoke-artifacts-contract.test.mjs`.

### Desktop E2E process-exit guard (BST-1087)

Desktop E2E fixture teardown is a correctness boundary, not cleanup-only.
Every process launched by `ElectronHarness` is registered with
`ElectronProcessExitGuard`. Any exit before the fixture begins intentional
close fails the owning Playwright test with the recorded code and signal, even
when the test body already passed. Once intentional close begins, both graceful
exit and the harness's bounded forced-termination path are accepted. Before
marking a close intentional, the guard checks the child process's recorded exit
state so a reaped process cannot be misclassified while its Node `exit` event is
still pending. The anti-vacuity floor applies after a context successfully
launches; a skipped test or a launch that already threw is not replaced by a
fixture-teardown error. Restart uses the same close/guard path and must surface
close failures; if close and process health both fail, both errors are retained.
Do not restore the former warn-and-relaunch behavior.

The interactive delegated-child decision fixture uses
`runInteractiveChildFixture` to preserve the original scenario failure alongside
diagnostic and teardown failures. Failure-text extraction or attachment must not
replace the assertion. Provider close and environment restoration still run
when Electron disposal fails. Capture the owned process before Playwright
disposal, observe its exit separately from `app.close()`, and only remove the
disposable workspace after confirmed exit; a sent signal is not proof of exit.
If exit cannot be confirmed, retain the workspace and report its path. These
decision scenarios additionally require a zero exit code, so forced termination
is a test failure even after the UI assertions pass. The real consumer remains
`delegated-child-interactive.desktop.test.ts`; injected diagnostic, disposal,
provider, launch and process-exit failures are covered by
`interactive-child-fixture.test.ts` (BST-1728).

**A harness-owned app may only be closed through the harness.** Tests that seed
on-disk userData (`electron-storage.json`) need the app down mid-test so no
process owns the file; they must call `ElectronHarness.closeForStateSeeding()`,
never `closeElectronApp(context)` directly. An out-of-band close is invisible to
the guard, so the process's exit is recorded as unexpected and the *next*
`restart()` fails the test — with `signal=SIGKILL`, which is just Playwright
reaping the child after `app.close()`, plus a `TypeError` reading `_object` from
the already-disposed `ElectronApplication`. That combination is a lifecycle-bypass
signature, not a crash, not memory pressure, and not an orphaned process: read it
as "somebody closed the app behind the harness's back". All ten
`file-explorer-selection-restore.desktop.test.ts` specs failed this way the
moment the desktop lane started loading again. Whether the failure surfaces as
the bare guard error or as an `AggregateError` pairing it with the `_object`
`TypeError` depends on whether Playwright has disposed the `ElectronApplication`
yet — that run produced 7 of the latter and 3 of the former; both mean the same
thing.

The seeding helpers take `SeedableElectronHarness`, whose required
`closeForStateSeeding` puts the guarded path in reach at every seeding call site.
The type does not *prevent* an out-of-band close — `ensureContext()` still hands
back the `ElectronApplication` — so this stays a convention backed by the paired
test, not a compiler guarantee. `file-explorer-selection.shared.ts` deliberately
does not re-export `loadElectronHelpers`, so the module that states the rule does
not also hand out `closeElectronApp`. Specs that launch their own Electron app
(`launchElectronDevAppInTest`) are unaffected — the harness never observes those
processes. Paired test:
`apps/desktop/src/__tests__/electron-harness-state-seeding.test.ts`.

### E2E module-format contract (BST-1217)

`scripts/e2e-module-format-contract.mjs` (paired test:
`scripts/__tests__/e2e-module-format-contract.test.mjs`, run in the Static job
via `pnpm test:scripts`) holds the module format of both Playwright graphs.

Playwright picks a format per file from the nearest `package.json` `type`
(`transform/esmLoader.js`: `isRequire ? 'commonjs' : fileIsModule(filename) ?
'module' : 'commonjs'`). `apps/desktop` and `apps/web` are deliberately
CommonJS — Electron main, electron-builder and the vite configs depend on it —
so once BST-1014 moved the shared libraries to ESM-only `tsc -b` emit, every
spec was CommonJS and every ESM-only library it reached was force-transpiled.
`import.meta` cannot be represented in CommonJS (this took desktop spec
collection to *0 tests in 0 files* for over a month), and `export *` becomes a
runtime getter loop that cjs-module-lexer cannot see through, so static named
imports of re-exported bindings fail to link. A dynamic `import()` avoids that
specific named-export linking failure, which is what made it look selective;
it does not make `import.meta` or a CommonJS `require()` of an ESM-only package
safe.

Three assertions, over every `apps/*/e2e` directory that holds specs:

1. **The graph is ESM.** The nearest manifest must declare `"type": "module"` —
   that is `apps/desktop/e2e/package.json` and `apps/web/e2e/package.json`,
   neither of which is a workspace member (`pnpm-workspace.yaml` globs
   `apps/*`, not `apps/*/e2e`).
2. **The Playwright config shares that format.** Both configs are
   `playwright.config.mts`, ESM by extension regardless of the app manifest. A
   CommonJS config that imports a workspace library pulls it in through
   `require`, forcing a CommonJS transform that then collides with any spec's
   static import of the same library. This was live: web's config imported
   `parsePositiveIntegerConfig` from `@brainstrike/platform-utils`, and removing
   only that one import made the whole web suite collect again.
3. **Runtime escaping imports stay CommonJS-safe.** A static runtime relative
   import that leaves an e2e root lands under the app's CommonJS manifest, so it
   is transpiled inside an otherwise-ESM graph. The contract walks that target's
   complete static relative-import graph, with cycle protection, stopping when
   it reaches an ESM manifest or re-enters an e2e root. Every CommonJS node must
   contain no bare runtime dependency, no `export *`, and no `import.meta`.
   Statement-level type-only imports do not create a runtime crossing and are
   ignored; inline type modifiers are conservatively inspected. Today the only
   crossing is desktop's `../../src/desktop-renderer-config`, an import-free
   resolver leaf; web's apparent `web-e2e-test-hooks` edges are type-only.

   This third assertion closes the Linux failure BST-1226 exposed after the
   initial BST-1217 repair: `desktop-renderer-url.ts` was lexer-safe itself but
   statically imported ESM-only `@brainstrike/logging`, so Node 24.18 tried to
   require `packages/logging/dist/index.js` from the CommonJS-transpiled target
   and Playwright collected zero tests. Main keeps the logging adapter in
   `desktop-renderer-url.ts`; E2E imports only the shared, import-free resolver.

The contract module is a **library** — importing it runs nothing. The test is
the gate, and every real-tree assertion is paired with a synthetic control
proving the predicate reports the defect when present. Placement in the Static
job is deliberate: the original failure was not "the lane broke" but "the lane
broke and nobody noticed for a week", because `desktop-e2e.yml` is
schedule-only. Deleting either manifest fails this test in the PR-required job.

### E2E lane-coverage contract (BST-1010)

`scripts/e2e-lane-coverage.mjs` (paired test:
`scripts/__tests__/e2e-lane-coverage.test.mjs`, run in the Static job via
`pnpm test:scripts`) statically proves that every Playwright spec in `apps/web`
and `apps/desktop` is selected by some lane CI actually invokes.

BST-1010 was filed as a *nightly selection audit* — run the full suite, diff it
against affected-selection. Both premises were wrong and the ticket was reduced:
the nightly already exists (`web-e2e.yml` cron 07:37, `desktop-e2e.yml` cron
07:53, both running `test:e2e:lane:full-regression`), and the cited bug class
(BST-891/816/817) is not a selection bug at all. It is lane wiring, computable
from source with no suite run. Two live instances the guard found on `main`:
`workspace-index-background-indexing.test.ts` carried `@web-indexing`, a tag no
lane grepped, on a `@stateful` describe that the broad pass grep-inverts; and
`production-csp.test.ts` carried `@stateful`, no lane tag, and appeared in zero
lane file lists. Both ran in no CI job. Each got a serialized dedicated lane —
deleting the `@stateful` tag to sweep them into the parallel broad pass would be
wrong, since one writes to the DB and the other runs PGlite search plus a real
local embedding.

Three assertions, over both apps: every `@web-*`/`@desktop-*` tag routes at
least one title somewhere; every TEST is reachable from at least one lane; every
explicitly targeted `test:e2e*` package script and inline workflow lane names
files that exist and selects a non-empty set. The third assertion intentionally
does not claim to model broad package scripts with no file list: their default
project selection can include suites outside this lane sweep (notably web
performance), while targeted scripts must state `--project` so the answer is
exact. The raw package-script floor protects discovery of the overall
`test:e2e*` surface. A separate floor is applied to the list this assertion
actually consumes: one explicitly targeted non-lane desktop invocation and none
for web today. That applicable count is printed in every verdict, and the paired
money test removes the desktop invocation and observes the floor fail.

**Reachability is resolved per test title, not per spec file** (review finding on
PR #2180). A file-granular answer marks a whole spec covered as soon as any ONE
of its titles is selected, so an untagged `@stateful` test sitting beside an
ordinary test the broad pass picks up reads as fully covered while running in no
CI job — the guard's own bug class, one level down. The failure output names the
dark `file:line` and title, because naming the file alone does not tell the
author which test is dark. The shape is not hypothetical: 11 real spec files
currently mix tag sets within one file (e.g. `git-panel.desktop.test.ts` has one
`@smoke` test that only the smoke lane can reach plus six the regression project
covers, and `embedding-worker-renderer.memory.desktop.test.ts` has one untagged
test that only full-regression reaches among eight `@desktop-embedding-*`
siblings). All are currently covered; the per-title check is what keeps them
honest. A whole-file `KNOWN_UNREACHABLE_SPECS` exemption is valid only while
EVERY title in the file is dark — partial coverage fails the entry rather than
letting it hide the titles still dark.

What holds it honest:

- **Selection is modelled exactly, not heuristically.** Reachability applies real
  Playwright semantics (explicit file list, project `grep`/`grepInvert`,
  command-line `--grep`/`--grep-invert`) to the real title paths parsed from each
  spec's AST via `listPlaywrightTitleEntries` in the shared
  `e2e-playwright-title-tags.mjs`. Anything unmodellable — an unknown
  `--project`, a positional that is not a spec path, a `--flag value` form the
  parser does not know, a `tag` that is not a literal — THROWS rather than being
  assumed benign.

  `titlePath` reproduces `TestCase._grepTitleWithTags()` exactly: for each
  ancestor suite its title THEN its tags, then the node's own title, then its own
  tags, space-joined. Two things that are easy to get wrong and were verified
  against real Playwright 1.61 `--list` rather than assumed:

  - **Tags inherit.** A tag on a describe routes every test nested inside it.
  - **`{ tag: '@x' }` counts.** Playwright's options form is NOT part of any
    title string, but it IS in the grep string. Reading title literals only made
    the guard wrong in both directions and hid three real desktop orphans
    (`agent-devtools`, `local-runtime-probe`, `secrets-settings` — each a
    `test.describe(..., { tag: '@smoke' }, …)` that the `regression` project
    grep-inverts and the smoke lane's file list omitted). There are 23
    options-form tag usages across `apps/*/e2e`; the array form
    (`tag: ['@a', '@b']`) is supported too.

  Both sibling consumers of this parser — `check-e2e-destructive-tags.mjs` and
  `check-e2e-readiness-contracts.mjs` — were silently affected by the same gap: a
  `{ tag: '@destructive' }` or `{ tag: '@stateful' }` describe was invisible to
  them, so each would have reported a FALSE POSITIVE on it (over-strict, not
  under-strict). No spec uses those two tags in options form today, so both
  scripts' real-repo verdicts are unchanged — but they are now correct for that
  shape rather than accidentally unexercised.
- **Only CI-invoked lanes supply coverage.** A lane is CI-invoked if a scoped
  workflow runs it or the `full-regression` aggregate runner references it. Detached
  package scripts cannot mark a spec covered merely by existing.
- **`LANE_WORKFLOW_FILES` is explicit, and that is the safe direction.** The
  `@desktop-embedding-*` lane is written inline in `desktop-e2e.yml` rather than
  as a package script, so workflows must be scanned. An inline lane in an
  unlisted workflow makes the guard report its specs as unreachable (loud red),
  never the reverse. Scanning every workflow is the UNSAFE direction:
  `local-desktop-e2e.yml` is a dispatch-only whole-suite shard run, and counting
  it would mark every desktop spec reachable and make the sweep vacuous.
- **Floors and self-cleaning exemptions.** `MINIMUMS` refuses to report a green
  when discovery collapses, and floors BOTH spec files and test titles — a parser
  regression returning zero titles per file would leave the file count healthy
  while every reachability question went vacuous. `KNOWN_UNREACHABLE_SPECS`
  entries fail if the listed spec becomes reachable, becomes only partly dark, or
  stops existing, so an exemption cannot rot into a permanent hole. It is
  currently empty after the inline desktop embedding lane adopted its former
  crash-b orphan.
- **The money test.** Per the BST-836 lesson below, the paired test drives the
  checker against a synthetic fixture repo carrying a planted orphan tag and
  orphan spec and asserts a non-zero exit, plus a clean control fixture, plus
  failure paths for a dangling lane file, a grep that matches nothing, a lane no
  CI entrypoint reaches, and — the case that verifies per-title granularity — a
  file holding one covered test and one dark sibling. That last case was
  control-tested against the pre-fix per-file logic and goes red there, which the
  other fixtures do not.

**Full-regression execution is fail-late, not shell-short-circuited (BST-1059).**
`apps/web` names the broad pass and ten serialized stateful/destructive lanes as
separate package scripts. `scripts/run-e2e-lane-sequence.mjs` invokes every one,
records each result, and exits non-zero after the final lane if any failed. A
failure in the broad or middle lanes therefore cannot starve tail lanes. The
runner also appends a unique `--output=test-results/<lane>` argument to every
Playwright invocation; later lanes may clean their own subdirectory but cannot
erase an earlier failure's traces, and the workflow uploads the parent
`test-results/` tree recursively.

The workflow remains bounded: lane-level Playwright global timeouts total 130
minutes, eleven fresh web-server starts are capped at one minute each, and
`web-e2e.yml` allows 165 minutes total, leaving 24 minutes for install/build
overhead. Do not replace the runner with an `&&` chain or reduce the workflow
timeout below the aggregate lane and startup budgets. The runner contract test
derives that inequality from every invoked lane's declared timeout and the
job-scoped workflow timeout.

**What a green does NOT prove:** that an externally cancelled or job-timed-out
run completed. The aggregate runner closes the ordinary lane-failure blind
window and prints per-lane START/PASS/FAIL plus a final failure summary, but a
static reachability verdict is not a run-artifact audit.

### Vitest 5 migration (BST-1689)

Accept the default `clearMocks: true`: tests must establish their own call
history. Desktop preload specs re-import their module before each test, and
main-process lifecycle mocks retain registered handlers independently of call
history (as the real event emitter does). Module-initialization assertions must import a fresh module inside
the test after `vi.resetModules()`, as in the file-explorer-hooks logger-scope
specs; do not restore cross-test history globally. DOM test projects include `@brainstrike/test-utils/vitest-matchers`: Vitest 5
extends `Matchers<R, T>`, while jest-dom 7 still declares the old `Assertion<T>`.
The shared declaration uses Vitest's public extension interface and preserves
synchronous versus promise assertion return types; runtime matchers are unchanged.
Preserve real `import.meta.url` in app-shell: its source-boundary tests resolve
files relative to their own module, so a global mock URL invalidates the guards.
Sharding contract tests read `resolveConfig(...).test` with the Vitest 5 API.
Async assertions and bench
fixture `.run()` calls must be awaited. Serialized shared-DB suites use
`{ concurrent: false }` instead of the removed `.sequential` API.

The root aggregator references package directories, so those configs do not
inherit root options. Inline projects inherit and merge arrays in Vitest 5;
keep setup files deliberate. Stryker remains 10.0.0 (its Vitest peer is >=2).
Generated reports and attachments live under ignored `.vitest/`, while
intentional visual baselines remain trackable in `__image_snapshots__`.

### The `__vitest_worker__` mutation guard (was: @vitest/runner teardown patch)

The "every test passes but vitest exits 1" flake (`Vitest failed to access its
internal state` thrown from a stray 100ms task-update `Timeout`, first seen in
CI run 29183123865, root-caused in BST-591) was caused by TEST CODE deleting
the `__vitest_worker__` global — a file-explorer coverage test did this to
simulate a non-test runtime. Vitest's task-update throttle timer is
legitimately armed mid-run; if it fires while that global is absent, the
worker crashes with an unhandled error. The window only collides under
event-loop starvation, so the flake surfaced in loaded full-graph/CI runs and
never in isolation. A pnpm patch on `@vitest/runner` that cancelled the timer
at end-of-run shipped 2026-07-12 and was later shown to be a placebo (an
end-of-run stray timer no-ops on already-flushed packs); it was removed in
BST-592. Dependency fixes normally belong upstream or in supported configuration.
The sole user-authorized exception is `@stryker-mutator/vitest-runner@10.0.0`
(BST-1690): carry upstream [PR #6220](https://github.com/stryker-mutator/stryker-js/pull/6220)
as a tracked pnpm patch until a compatible release ships. Vitest 5 joins full
test names with ` > `; the runner and sandbox must use that same separator
for report IDs, per-test coverage, and filtered mutant runs. Keep mutation
thresholds and `perTest` coverage unchanged. Remove the patch when upgrading
to a release containing the fix, after re-running the mutation lanes.
The installed-package regression in
`scripts/__tests__/stryker-vitest-5-compatibility.test.mjs` must kill every
fixture mutant and attribute it to the nested test; a successful dry run alone
does not prove compatibility. This exception does not reinstate the ineffective
Vitest teardown patch or permit mutating Vitest worker globals.

Regression guard: `scripts/verify-no-vitest-worker-mutation.mjs` (test:
`scripts/__tests__/vitest-worker-global-mutation.test.mjs`, run in the Static
job via `pnpm test:scripts`) forbids `delete`/`Reflect.deleteProperty`/
assignment/`vi.stubGlobal` of `__vitest_worker__` in any test file under
`packages/` or `apps/`. To exercise "not running under a test framework"
branches, mock a detection seam instead — see
`packages/file-explorer/src/persistence/test-environment.ts`.

### Workspace-src alias guard (`pnpm test:scripts`)

`scripts/verify-workspace-src-aliases.mjs` (guard test:
`scripts/__tests__/verify-workspace-src-aliases.test.mjs`, run in the Static job
via `pnpm test:scripts`) prevents the #1066/#1207 regression class: a package
test lane importing another `@brainstrike/*` package at RUNTIME while its vitest
config declares NO workspace-src aliasing resolves that dep from BUILT `dist`
(via package `exports`) — stale/broken dist then silently passes.

The shared registry `@brainstrike/test-utils/workspace-src-aliases`
(`workspaceSrcAliases(packagesDir)`, a committed plain `.mjs` — no build step)
derives EXACT aliases from each package's own `exports` map: regex-exact package
root + each exported code subpath -> validated `src` file (missing source
throws). Asset exports (css/json/icons), src-pointing exports, and prebuilt
`*.worker` bundles get no alias; unexported subpaths are NOT captured (they fail
loudly under node resolution); a same-name wildcard export (preferences `./*`)
gets a validated narrow prefix. Package vitest configs spread it (config-local
mocks/dedicated helpers go BEFORE the spread — vitest `resolve.alias` is
first-match). `@brainstrike/agent` is excluded (Mastra/Node deps): consumers use
`createAgentBrowserSafeAliasEntries`. `@brainstrike/workers` has no `src/` dir:
consumers alias its subpaths explicitly. Prebuilt `*.worker` exports are also
skipped by the shared registry. When a test graph imports one as executable
source, it needs a narrow config-local override: web Vitest maps
`@brainstrike/embedding-worker/worker` to `src/embedding.worker.ts` before the
shared spread, and its integration config inherits that base alias verbatim.

The guard EXECUTES each discovered vitest config (base + integration + mutation +
models, and each inline project). Vitest 5 inline projects inherit root aliases
unless `extends: false`; string `extends` selects a separate config. The guard
uses Vite `mergeConfig` to preserve actual object/array alias precedence. Discovery is the `vitest.*config*.*` filename convention made
a CHECKED invariant: every vitest `--config`/`-c` reference in package scripts
and every stryker `configFile:` must be in the discovered set, else the guard
throws. Per config/project it closes the runtime `@brainstrike/*` specifier set
to a FIXPOINT over the src-resolved graph (a specifier that resolves into
another workspace package's source pulls in that package's non-test specifiers
— so transitive chains like embeddings → embedding-worker(src) → worker-runtime
are checked), then simulates vitest's first-match alias resolution: the winning
entry must point at an existing non-dist source path, and an unaliased
specifier must not resolve to `dist` via the dep's `exports` map. So dist-pin
overrides, imported-but-unspread registries, per-dependency gaps, bare mutation
configs, and transitive src-graph gaps all FAIL. The guard loads configs through
Vite's `loadConfigFromFile`, so app configs with Vite-supported extensionless
imports are inspected under the same loader semantics as their test lanes.
Legitimate built-artifact consumers go in `WORKSPACE_SRC_ALIAS_ALLOWLIST` with
a reason string (NO silent fallback). This was the R3 enabler for dropping
`test.dependsOn: ["^build"]` —
DONE in Series B4: `test`/`test:integration`/`test:coverage` now
`dependsOn: ["topo"]`, a synthetic no-op **transit node** (`topo`,
`dependsOn: ["^topo"]`) that carries the upstream SOURCE-hash cascade WITHOUT
building anything, so a `packages/types` edit no longer rebuilds ~39 packages
before a test runs. Plain deletion of the edge would be a stale-green landmine
(tests import upstream source, so a cached dependent must still re-hash when an
upstream's source changes); the transit node REPLACES the edge instead of
removing it. `topo` hashes full default inputs except the guarded BST-1773
pilot in `@brainstrike/types`: its `topo` and `build` exclude only executable
`**/*.test.*` and `**/*.spec.*` files, matching its TypeScript build exclusions.
Owner `test`/`test:coverage` inputs remain complete. The explicit lost-file reporter
input remains a hash carrier. Never remove transit edges to narrow affected work.

`lint:private-test-input-locality` runs in local and CI lint. It rejects imports
and filesystem reads into the Types private-test boundary, including static,
dynamic, constant-bound URL and partially static paths. Directory inventories and
existence checks are reads too: filesystem method aliases and alternative path
bindings must retain the same boundary checks. Only private Types specs
may consume peer private specs. Shared helpers must live outside excluded paths;
do not blanket-exclude `__tests__` directories. Extend this bounded policy and its
negative controls before introducing another path-construction convention or pilot.
This JS/TS reader guard does not model declarative JSON/YAML or tool-config globs.
Do not add cross-package config globs over private Types specs; move shared
fixtures outside the private boundary or explicitly model and test their task
inputs before introducing such a consumer.
`private-test-input-locality.test.mjs` uses the pinned Turbo binary to verify both
hashes and affected selection, including a deliberately unsafe exclusion.

File-node factories belong to `@brainstrike/file-tree-test-fixtures`, consumed by
file-explorer, file-explorer-hooks, file-explorer-ui, utils and workers. Generic
`@brainstrike/test-utils` must not depend on `@brainstrike/types`. The domain
fixture package may consume generic test setup; that edge is intentionally one-way.

The chunk-cycle guard is an explicit input of web/desktop `build` and desktop
`build:renderer`, not a global input. Coverage enforcement runs directly after
coverage collection, outside Turbo caching, so its script is not a global input.
`ci-guard-input-locality.test.mjs` proves these boundaries with actual Turbo hashes
and affected selection, with negative controls for missing build invalidation.
It discovers direct guard consumers from workspace scripts, rejects package-level
coverage-enforcement scripts, pins the absence of root build-input overrides, and
requires cached coverage tasks to restore `coverage/**` before enforcement.

BST-1773 measurements against `7bc7f079` used isolated Git fixtures and pinned
Turbo `test test:integration --dry=json`, comparing executable task selection and
hashes. Types source edits fell from 61 to 49 tasks; private Types test edits from
61 to 1; domain-factory edits from 60 to 43. Generic setup edits changed 60 before
and 61 after (the new fixture suite is an intentional consumer). Each guard script
previously invalidated 65 test tasks and now invalidates none; chunk guard edits
still invalidate all three consuming app build tasks. Types manifest downstream
reach fell from 47 to 37. These are invalidation counts, not measured CI durations.

Explicit build edges survive in per-package `turbo.json` where a test genuinely
consumes a built artifact:
`@brainstrike/desktop#test:integration`/`#test:coverage` need
`@brainstrike/agent#build` and `@brainstrike/assistant-data#build` for the native
delegated-decision restart verifier (BST-1720): child Node processes resolve
public exports without Vitest aliases.
These exact dependencies build the agent's DB/contract closure and the startup
reaper's public assistant-data export. The resolved graph is guarded by `turbo-global-configuration.test.mjs`; no inline
build or repository-wide `^build` edge is introduced.
`@brainstrike/logging#test` needs its own `build` (logger-dist-singleton test
imports logging's `dist` by file URL); `@brainstrike/utils#test` needs its own
`build` (typescript-build-contract test inspects emitted files);
`@brainstrike/db#test`/`#test:coverage`
need `@brainstrike/utils#build` (migration-runner-types test's nested
`ts.createProgram` resolves utils types from `dist` — vitest aliases can't
intercept tsc); `@brainstrike/secure-fs-native#test`/`#test:coverage` need
their own `build` (the tests load the compiled `.node` addon — and the edge
must NOT be replaced by an inline `pnpm build &&` in the test script: that
shape raced turbo's concurrently-scheduled `build` task as two simultaneous
`node-gyp rebuild`s in one directory ("make: No targets specified and no
makefile found"; reproduced 2026-07-19). Guarded by
`scripts/__tests__/native-addon-build-uncached-contract.test.mjs`; the
`native-windows` job bypasses turbo and therefore builds explicitly before
testing).

BOTH native lanes are also `cache: false`, not just `build`. `build` being
uncached guarantees a FRESH binary; it does not guarantee anything LOADED it,
so a cacheable `test`/`test:coverage` would replay a logged green without ever
dlopening the addon — the exact hazard the package's `test` task documents.
`test:coverage` is the easy one to miss because the ROOT `test:coverage` task
caches (unlike root `test:integration`), and `nightly-coverage.yml` runs
`turbo run test:coverage`. The guard above resolves EFFECTIVE cacheability
(package override → root task → turbo default) for every turbo-scheduled test
lane of a native package.

Because these lanes no longer build inline, invoking them OUTSIDE turbo and
without a prior build (`pnpm --filter @brainstrike/secure-fs-native test`, or a
bare `pnpm test:fast` / `test:coverage:base`, which use recursive `pnpm -r`
rather than turbo) finds no addon. This matches `@brainstrike/logging` and
`@brainstrike/utils`, whose built-artifact tests fail the same way without a
prior build, and the `check.mjs`
gate is safe because it runs `build` before the turbo test lanes sequentially
(BST-1009 replaced its `test:fast`/`test:coverage:split` steps with the same
`turbo run test` / `turbo run test:integration` invocations CI uses, so the
addon arrives through turbo's own `#build` edge either way). A preflight
(`test/ensure-addon.cjs`) turns that case into an actionable message naming the
build command instead of `bindings`' generic "Could not locate the bindings file".
It deliberately CHECKS rather than builds: auto-building on a miss would silently
reuse a stale addon after a C++ edit, and it would reintroduce a second build
declaration. The apps needed NO build edges in the original B4 clean-state proof run
exposed gaps in their hand-maintained vitest alias maps (specifiers falling
through `exports` to dist — invisible while `^build` guaranteed dist existed),
closed by aliasing instead: apps/web gained the missing root aliases
(assistant-contract, chunking-worker, context-actions, file-system,
indexing-contract, storage); apps/desktop now spreads this same
`workspaceSrcAliases` registry (array-form alias, locals first) plus an
agent-root→src alias mirroring web (the registry deliberately excludes agent).
The guard checks both `packages/*` and `apps/*` (the default entrypoint passes
`appsRoot`), so app alias gaps fail the same source-resolution contract instead
of depending on a clean-state resolution crash. Desktop's agent-client-loader
tests pin the loader's FALLBACK_PROVIDERS against the agent SOURCE via
`vi.importActual` — no hand-maintained duplicate (raw require in the loader
bypasses vitest aliases and needs dist, absent by default post-B4, so CI
exercises the FALLBACK path). FALLBACK_PROVIDERS is therefore an explicit tuple
in registry DECLARATION order with compile-time exhaustiveness pins against the
FALLBACK_ENV_KEYS Record (PR #2513 review); do NOT derive it from `Object.keys`
of the Biome-sorted Record — that changes the order only in the dist-absent
state CI runs in. See the Series B turbo-monorepo architecture review.

Desktop main-process unit tests share observable Electron controls in
`apps/desktop/src/__tests__/helpers/electron-main-test-harness.ts`. The harness
layers `vi.fn()`-backed IPC registration and WebContents state over the inert
default surface owned by `apps/desktop/src/__tests__/electron-test-stub.mts`;
new Electron API defaults belong in the stub so the alias and global mock do
not drift. Tests needing those observable controls import the harness instead
of redeclaring `vi.mock('electron')` or patching missing cleanup methods.
Narrow tests may still replace Electron deliberately when they exercise a
different surface, but IPC-focused tests reset the shared harness in
`beforeEach` so owned mock implementations, handler/listener registrations,
and WebContents never leak across cases. The paired harness test pins surface
parity, duplicate registration failure, multi-listener cleanup, and reset
semantics.

### Mutation-lane contract guard (`pnpm test:scripts`, BST-1331)

`scripts/verify-stryker-mutation-contracts.mjs` (guard test:
`scripts/__tests__/verify-stryker-mutation-contracts.test.mjs`, run in the
Static job via `pnpm test:scripts`) keeps the advisory Stryker lane from rotting
silently — the lane is on-demand, so a drifted runner invocation or broken
config stays invisible until someone runs `pnpm mutation` (the #2475 rot class;
BST-1287 shipped the Stryker 10 upgrade this guard builds on).

Discovery is workspace-driven: the globs under `packages:` in
`pnpm-workspace.yaml` are expanded from the repo root (not just direct
`packages/*` children), every resulting directory is scanned for a `mutation`
script, an unparseable `package.json` under a scanned root throws instead of
being skipped (it could hide a mutation script), and an empty discovery set
throws rather than reporting green. The parser deliberately reads only a tiny
YAML subset (top-level scalar globs); anything else fails loudly.

Five invariants per contract:

1. **Local-bin invocation, allowlisted.** The `mutation` script must match
   `^stryker\s+run\b` (arguments allowed) AND declare `@stryker-mutator/core`
   in its dependencies — that declaration is what puts the `stryker` bin in
   the package's own `node_modules/.bin` under pnpm's isolated layout.
   Anything else violates: `npx @stryker-mutator/core run` ignores the catalog
   pin via registry resolution (the original BST-1287 gap), `npx stryker run`
   keeps the registry in the path, and neutered commands (`echo skipped`)
   kill the lane invisibly. This is deliberately an allowlist, not a denylist.
2. **Unambiguous config by Stryker's own precedence.** Candidates are probed
   in exactly @stryker-mutator/core 10's `SUPPORTED_CONFIG_FILE_NAMES` order
   (`stryker.conf.json → stryker.conf.js → .mjs → .cjs → stryker.config.* →
   dot variants`), and only the first existing file is evaluated — the same
   file a real mutation run loads. TWO OR MORE candidates present is itself a
   violation: a stale valid `.cjs` beside a broken `.js` replacement would
   otherwise let the guard validate a file Stryker never reads.
3. **Loadability under repo semantics.** The selected config is loaded exactly
   as Stryker loads it (`.json` parsed; everything else through `import()`,
   which gives CJS interop for `.cjs`; packages are `"type": "module"`, so
   `.js` configs must be ESM — `file-system` deliberately ships `.cjs`). A
   load failure is a violation carrying the underlying error.
4. **Agreed reporter roster.** Values in `reporters` are STRYKER reporter
   names; the supported set (`clear-text`, `html`, `json`, `progress`) is a
   deliberate house roster, NOT a Vitest capability claim (Stryker built-ins
   like `dots` are legal upstream — widening is a reviewed decision). A
   NON-array `reporters` value is itself a violation, never coerced into
   "nothing to validate" (NO SILENT FALLBACKS). Leaving `reporters` absent is
   allowed: Stryker's defaults are inside the set. History: Vitest 4 removed
   `basic` from @stryker-mutator/vitest-runner's supported reporters, which is
   how the #2475 lane rotted — but that reporter name lives inside the vitest
   runner plugin, so this check bounds the roster; it cannot itself see it.
5. **Mutation Vitest wiring survives refactors.** `vitest.configFile` must
   basename to `vitest.mutation.config.ts` and the referenced file must exist.

Entrypoints follow the BST-836 shape: `main({ repoRoot })` anchors discovery,
`directory` is honored as the same anchor so the generic entrypoint control
harness drives it uniformly, and direct execution checks the real repo.

### TypeScript 7 CLI with the TypeScript 6 compatibility API (BST-1011)

All bare `tsc` commands use the TypeScript 7 native compiler. The catalog's
`@typescript/native` alias installs `typescript@7.0.2` at the root and owns the
`tsc` bin. The catalog's existing `typescript` name resolves to the official
`@typescript/typescript6@6.0.2` compatibility package: it owns `tsc6` and the
classic programmatic API, but deliberately does not own `tsc`. This is the
TypeScript team's supported side-by-side topology; do not replace it with two
aliases of the ordinary `typescript` package, which recreate an ambiguous bin.

Repository scripts, ESLint, Stryker, DB compiler tests, and the desktop
runtime-host boundary import `typescript` as a library and must continue to
resolve major 6. Type-check/build scripts execute `tsc` and must resolve major
7 from both root and package scope. `scripts/__tests__/typescript-compiler-wiring.test.mjs`
derives both the type-check-package and API-consumer sets dynamically, applies
anti-vacuity floors, checks the installed package/bin identities, and executes
both compilers. API-consumer discovery comes from `git ls-files`, so ignored
build/coverage output cannot change the census between a developer tree and CI;
an unresolvable consumer is reported as a violation instead of crashing test
module initialization, and workspace-state collection is lazy so failures occur
inside a named test. Package-manager subprocesses use the repository's
cross-platform spawn helper; do not call extensionless `.bin` shims directly.
Its mutation controls prove a swapped major, a native API consumer, an
unresolvable consumer, a compiler patch bump without renewed parity evidence,
editor TSDK drift, or a compatibility package shadowing `tsc` all fail loudly.
The complete wiring file costs about 1.4 seconds locally (seven tests, including
three compiler-version subprocesses) inside the roughly 14-second script-test
phase; keep that cost explicit if more process probes are added.

Desktop packaging is a separate boundary from workspace module resolution.
`apps/desktop/src/__tests__/build-main-config.test.ts` requires the concrete
TypeScript 6 implementation to be a production dependency and requires its
Electron Builder unpack rule. Its mutation control removes both seams and
asserts the exact violations, preventing a source-tree-only LSP green from
hiding a packaged-app failure.

`scripts/ts7-parity-check.mjs` compares every discoverable `--noEmit` command
under `tsc6` and `tsc`, checking binary majors before discovery. It deliberately
does not claim parity for `apps/web`'s emitting `tsc --build --force`; that path
must be verified in a clean isolated worktree so one compiler's declarations
cannot affect the other. The adoption evidence and reproduction commands live
in `docs/series-c-ts7-parity-findings.md`.

### Turbo 2.10 configuration audit and 3.0 preparation (BST-1013)

The root config opts into Turbo 2.10's `futureFlags.globalConfiguration` and
uses the Turbo 3.0 `global.concurrency` / `global.inputs` shape. This is a
mechanical config migration: a before/after `turbo run build type-check lint
test --dry=json` selected the same 47 packages and 235 task nodes. Under this
future flag, Turbo no longer reports these files in `globalCacheInputs.files`;
it injects them into each executable task's resolved inputs instead.
`scripts/__tests__/turbo-global-configuration.test.mjs` therefore expands the
configured globs, runs the pinned Turbo binary, and checks every executable
task at that actual boundary. Its floors require at least 9 matched global
files, 47 packages, 230 total task nodes, and 160 executable tasks. Mutation
controls remove one real input from one task and empty the task selection, and
prove both cases fail visibly. The structural tsconfig contract separately
proves the future flag/layout and the load-bearing tsconfig globs; its controls
reject the legacy layout and a missing preset input. Keep both controls when
editing the global block. On the same machine and base revision, the complete
script-test phase moved from 14.23 seconds / 781 tests to 15.00 seconds / 784
tests: +0.77 seconds (+5.4%). The Turbo dry-run is memoized within the test file
so the money controls do not spawn it twice.

**`global.concurrency` is the build/test calibration; the dev floor lives on
the dev script.** `turbo run dev` selects every workspace `dev` task and turbo
refuses to start when concurrency is <= the number of persistent tasks in the
selection — a property of that selection, not a parallelism budget. Raising the
global value to satisfy it is what produced the 28 → 29 → 30 → 31 → 32 treadmill
and, at 40 tasks vs. concurrency 40, a `pnpm dev` that failed outright. The
global value stays pinned at 40 (structurally, in the tsconfig contract) and the
root `dev` script carries `--concurrency=100`.

Be precise about who inherits the global value: not every CI invocation caps
itself. The Unit lanes pass `--concurrency=4` / `=2`, Type check sets
`TURBO_CONCURRENCY=4`, native-electron and coverage pass `=4` — but the **Build**
job (`test.yml`, `runs-on: ubicloud-standard-4`) runs `pnpm turbo run build`
with no cap and inherits the global number, as do local `pnpm build` /
`pnpm check`. Its effective parallelism is bounded by the build DAG's width, but
the global value is the ceiling, so treat a change to it as a change to Build.

`turbo-global-configuration.test.mjs` enforces the dev cap against a memoized
`turbo run dev --dry=json`: it must exceed both the planned persistent-task
count AND the workspace package count. The second bound is the one that retires
the treadmill — turbo can never plan more `dev` tasks than there are packages,
so a cap above the package count can never bind, and the guard goes red while
`pnpm dev` still works rather than on the commit that breaks it. Controls cover
a cap equal to the task count, a cap that clears the task count but not the
package count, a collapsed dev sweep, and a dev script with no cap at all. The
same file also pins `$schema` to the `package.json` Turbo version, so a bump
cannot leave editors validating against the previous release's schema.

Arithmetic over a planned graph assumes turbo enforces the rule at all, and
neither `--dry` nor `--graph` exercises that check while the real `dev` graph
cannot be run in a test (it launches every watcher). A money test therefore
proves the rule on a two-package fixture at the pinned binary: concurrency 2
against 2 persistent tasks must be rejected naming the floor, concurrency 3
must succeed. That is the file's dominant cost — measured on one machine, it
moved from 1.06 s / 2 tests to 5.88 s / 4 tests, roughly 3.7 s of which is the
fixture's two real turbo runs. Keep the fixture if a future turbo changes the
rule; without it the arithmetic could quietly guard nothing.

The same audit found no active repository use of Turbo 2.9's deprecated
`turbo-ignore`, `turbo scan`, `--parallel`, Turbo's `--no-cache`, daemon flags,
non-HTML `--graph` output, legacy remote-cache flags/environment variables, or
`prune --scope`. The only `--no-cache` match is Alpine's unrelated
`apk add --no-cache` in `scripts/setup-headless-display.sh`. Do not enable the
remaining 3.0 future flags speculatively: `filterUsingTasks` would change the
settled explicit affected filters in `test.yml`; the affected/watch/prune flags
have no adopted call site; `longerSignatureKey` needs the real remote-cache
signing setup to validate; and the diagnostic-only flag has no CI benefit.

Package-config composition was evaluated and deliberately not adopted. The ten
package `turbo.json` files now represent seven behavior classes; five are
unique cache-safety or cross-input contracts. Only app-shell/db-explorer/
vector-management and secure-fs-native/windows-job-native repeat behavior.
Introducing a config micro-package for groups of three and two would add graph
and ownership surface, while extending an operational package would couple
unrelated owners. Turbo's native `extends` is still the required mechanism if
a stable repeated policy grows large enough to justify a shared owner; do not
invent a merger or config registry.

Turbo 2.9's stable `query affected` was also evaluated but is not a CI planner.
Against `origin/main..HEAD` with no package change it correctly returned zero;
against the BST-1011 root/lockfile change it returned 48 package nodes including
the workspace root, or 46 with `--tasks test`. That offers no saving over the
Unit job's native affected selection, cannot weaken the always-on
web/desktop smoke checks, and would create a second selection/reconciliation
seam. `scripts/run-turbo-command.mjs` also appends `--cache-dir`, which run
commands accept but `turbo query affected` rejects. Because no repository query
entrypoint was adopted, the bounded run wrapper was not broadened for an
unsupported command.

### Root clean orchestration

The root `pnpm clean` command stays on the shared Turbo command wrapper so it
retains the same grouped logs and run summary as the other root graph commands.
The root `clean` task is uncached, declares no outputs, and has no dependency
edges. Every workspace package with a `build` script must declare `clean`;
TypeScript and app packages remove local `dist`/`.tsbuildinfo`, while native
addon packages remove their local node-gyp `build` directory. The command,
complete build-package coverage, and resolved task graph are guarded by
`scripts/__tests__/package-scripts-canonical-form-contract.test.mjs`.
That test invokes Turbo's JavaScript entrypoint through `process.execPath`;
do not execute the generated `turbo.cmd` shim directly, because Node 24 rejects
batch files passed to `execFileSync` on Windows.

### Worktree-scoped local Turbo caches (BST-1312)

The bounded Turbo wrapper's default local cache remains outside the checkout,
but it is scoped by the canonical Git worktree root under the platform cache
home (`.../BrainStrike/turbo/worktrees/<name>-<path-hash>`). Package-level and
root invocations in one worktree therefore share one cache and nested-run lock;
different worktrees do not share local cache sidecars. Explicit
`TURBO_CACHE_DIR` / `BRAINSTRIKE_TURBO_CACHE_DIR` values remain exact operator
overrides and are not silently rewritten. Invocations outside a Git worktree
must set one of those overrides; the wrapper fails loudly rather than silently
returning to the unsafe machine-global default. Turbo's `--cwd` value, when
present, owns worktree resolution rather than the wrapper process directory.

This isolation is a correctness boundary for Turbo 2.10's restore manifests,
not a response to `.tsbuildinfo` restoration or cache pruning. A deterministic
two-worktree reproduction created different four-byte outputs with identical
mtime, size, and mode. Both worktrees wrote the same HOME-level cache before
one selected the other's task hash. Turbo's `<hash>-manifest.json` records only
path plus size/mtime/mode and is stored beside the shared archive; it contains
neither output bytes nor checkout identity. The second worktree therefore
reported a cache hit while retaining the first worktree's wrong bytes. The
25-GiB prune was below its cap and did not participate.

Scoping deliberately gives up machine-local hits between worktrees because the
metadata-only sidecar makes those hits unsafe. It preserves local hits across
commands and branch changes within one worktree, and Turbo's independently
configured remote cache remains shareable across worktrees and machines. It
does not change Turbo's metadata-only identity inside one worktree: switching
between two previously cached hashes can still retain same-size/same-mtime stale
bytes in that one namespace. That residual, non-concurrent case is outside the
cross-worktree failure fixed here and must not be described as content-safe.

The scoping also confines the wrapper's post-run pruning and nested-run lock to
the active worktree, so one interrupted or maintained lane cannot remove or
block another lane's usable local entries. The 25-GiB limit consequently applies
per active worktree, not machine-wide; removed worktrees and the pre-BST-1312
top-level cache are not automatically collected. Operators should remove those
abandoned directories as part of worktree/cache housekeeping. Automatic
cross-namespace collection is intentionally deferred because deleting a
namespace without an active-lane lease would reintroduce the cross-lane
invalidation this boundary prevents. Do not collapse these directories back
into one HOME-level cache unless Turbo's restore identity becomes content- or
checkout-aware and the paired same-size/same-mtime concurrency regression proves
the shared topology safe.

### Stale-dist pruning before non-cleaning tsc builds (2026-07-30 cache poisoning)

tsc's incremental builder never deletes outputs whose sources are gone, and the
nested Turbo run by apps/web + apps/desktop `prebuild`/`predev`
(`scripts/run-turbo-command.mjs`) snapshots each package's whole `dist/**` into
the wrapper's cache (the machine-global `~/Library/Caches/BrainStrike/turbo` at
the time of this incident; worktree-scoped after BST-1312). A branch switch that
deletes sources therefore leaves orphaned compiled files in `dist`,
and the next cache save immortalizes them: cold runs restore the poisoned
archive verbatim even after local deletion, tripping `turbo boundaries`
(2026-07-30 incident: 16 boundary issues, 125 poisoned archives purged).

The guard: every build-chain script (`build`, `prebuild`, `postbuild`,
`build:*`) that runs an emitting tsc (any form without `--noEmit` — `-b`,
`--build`, `--project ... --emitDeclarationOnly`, bare `tsc`) must either
clean `dist` first or prepend `node <depth>/scripts/prune-stale-dist.mjs`.
The pruner resolves the package's real tsc program (tsconfig
extends/include/exclude respected, via the TypeScript config loader) and
deletes dist artifacts no program source would emit. Program membership — not
filesystem existence — is the orphan test: a `dist/foo.test.js` whose
`src/foo.test.ts` still exists but is tsconfig-excluded is an orphan (most
wired packages exclude `**/*.test.*`, and compiled tests import vitest — the
exact `turbo boundaries` shape). Two carve-outs: outputs of on-disk
`.js`/`.jsx` sources outside the program are kept (bundler entries like
file-explorer's `.worker.js`), and `.json` pruning activates only when the
program itself contains json sources (db's `drizzle/migrations.json`) — a
generated dist json (a `{"type":"commonjs"}` marker, a copied manifest) is
produced, not compiled, and deleting it would not self-heal. Residual class,
accepted: a generated dist json inside a json-compiling package.

Pruning — not cleaning — is deliberate for the wired packages: it preserves
incremental builds, and it is safe under concurrent builds of the same package
(the reason agent's tsup pins `clean: false`) because a concurrent build only
emits files whose sources are in the current program, so the prune set is
disjoint from its writes. That disjointness silently depends on tsup NOT
code-splitting (hashed split chunks have no source counterpart and would be
pruned out from under a sibling build), so the wiring contract statically
requires `splitting: false` in every pruned package's tsup config. After
BST-1014, `agent` and `file-explorer` are the complete live intersection of
pruned packages and real bundle boundaries; the paired test pins its
anti-vacuity floor to both while continuing to discover and inspect every future
intersection member. The pruner
itself requires `tsconfig.json` with rootDir `src` and outDir `dist` and
per-file emit — anything else throws, and such a package must clean instead. `ui`'s
`pnpm run clean:generated` cleans stray compiled JS in `src`, not `dist` — it
does not satisfy this contract (ui's `dist/prompt-management` was a proven
poisoning vector behind exactly that prefix). The contract scans build-chain
scripts only: `type-check`'s emitting `tsc --build --force` (apps/web) cannot
create orphans or archives — only `build` has `dist/**` outputs, and the prune
before every snapshot-producing build launders dist before archiving. The
wiring contract, pruner behavior, entrypoint controls, and the `turbo.jsonc`
`global.inputs` hash entry for the pruner (editing it must invalidate
cached builds) are guarded by `scripts/__tests__/prune-stale-dist.test.mjs`.

### Canonical package build strategies (BST-1014)

Non-native typed packages have two JavaScript build classes, derived from
`scripts.build` rather than from a package registry:

- **Libraries use TypeScript emit.** A plain library builds JavaScript and
  declarations together with `tsc -b`. All 30 libraries with the canonical
  `rootDir: src` / `outDir: dist` layout prepend
  `node ../../scripts/prune-stale-dist.mjs`; it removes deleted-source artifacts
  without discarding `.tsbuildinfo`, so a normal build does not turn
  TypeScript's project-reference builder into a forced clean rebuild. The sole
  tsc-only layout exception is `workers`: its source files live at the package
  root, outside the pruner's deliberately narrow safety contract, so it keeps an
  explicit clean. This is derived from resolved compiler layout, not a package
  allowlist. A TypeScript-emitted library does not retain a tsup config, tsup
  dependency, or tsup watch command.
- **tsup is for real bundle boundaries.** Eight packages require bundling:
  `chunking-worker`, `embedding-worker`, `file-tree-worker`, and `token-cache`
  package browser workers/WASM/assets; `agent` produces the self-contained
  hosted-web boundary; `assistant-service` and `assistant-wire` retain the CJS
  surface retained for CommonJS consumers; and `file-explorer` emits the
  renderer's worker-storage artifact. Adding a ninth bundler is an architectural
  decision, not a convenient way to emit a second module format.
  This is the compatibility boundary for BST-1014, not an endorsement of tsup as
  the R10 endpoint: upstream marks tsup unmaintained and recommends tsdown. A
  replacement must preserve the custom worker/WASM/assets and CJS contracts and
  carry measured artifact and wall-clock evidence; swapping emitters inside the
  library migration would combine those risks and make regressions unattributable.
- **Native addons remain native builds.** `secure-fs-native` and
  `windows-job-native` use `node-gyp`; the build-strategy guard recognizes that
  structural class rather than pretending a TypeScript or tsup command owns the
  native artifact.
- **Node-compatible emitted ESM is compiler-enforced.** Libraries migrated from
  tsup extend `packages/config/tsconfig/node-library.json`, whose `module` and
  `moduleResolution` are `NodeNext`; declare `type: module`; expose the one emitted
  runtime artifact through `types` + `default`; and spell local TypeScript imports
  as `.js` in source. TypeScript therefore rejects extensionless relative imports,
  directory imports, invalid package-export subpaths, and missing JSON attributes
  during every editor/type-check/build pass. A `require` export condition is not a
  synonym for “Node can require synchronous ESM”: it must point to a real CJS
  artifact. A CommonJS composition boundary that consumes one of these libraries
  uses native dynamic `import()` (and an explicit `resolution-mode: import` for
  type-only imports) rather than forcing the library back into dual-format
  bundling. The Vercel API now declares native ESM in the web manifest; its Node16
  check enforces explicit relative `.js` imports. Vercel disables `require(ESM)`
  by default, so hosted functions must select the agent's ESM export, including
  native imports of external Mastra/provider runtimes. The existing hosted bundle
  guard loads ESM under the Node 26 toolchain with
  `--no-experimental-require-module`, kills a nonterminating probe after 30 seconds,
  and permits no ESM-only
  workspace `require()` exceptions. Pino and tiktoken remain external runtime
  dependencies declared by the bundle owner; inlining their Node/WASM loaders
  would break native loading or browser asset references. Validate both built
  preview status and POST rejection through the generated function artifacts,
  then the deployed preview; a successful Vercel build is not runtime proof.
  Playwright's
  TypeScript loader is a distinct CommonJS
  transform boundary: a Node-side E2E helper imports the narrowest side-effect-
  free contract subpath it needs instead of a package barrel that transitively
  loads browser-oriented `import.meta` modules. Desktop assistant mocks pin this
  through `@brainstrike/assistant-contract/assistant-stream-session`; the desktop
  smoke lane is the runtime proof.
- **Browser-only emit keeps Bundler resolution.** `file-explorer-hooks` is a
  React/Vite library whose public surface imports the browser-only `ui` barrel.
  That barrel's declarations intentionally model a bundler and contain
  extensionless re-exports; consuming them under NodeNext loses named exports
  behind `skipLibCheck` (TS2305 at the hook tests). The package therefore extends
  the shared Bundler config while still using the same canonical `tsc -b` build.
  Module resolution follows the runtime that loads the emitted graph; it is not
  a second build strategy.

`scripts/verify-package-build-strategies.mjs` (alias
`lint:package-build-strategies`, present in both lint chains) enforces the two
classes, the native-addon exception, the exact bundler budget, incremental-safe
cleanup for every compatible src-to-dist library, removal of every supported tsup config-file
shape/dependency/dev command, canonical `tsup.config.ts` for current bundles,
NodeNext manifest conditions, and that every dist code export is an output of
the package's parsed TypeScript program. TypeScript's config loader resolves
array and indirect `extends`; the guard does not approximate inheritance or
re-parse module syntax. Discovery comes from workspace manifests and resolved
compiler configs; there is no identity mapping file. Its anti-vacuity floors
cover typed build packages, tsc-only libraries, incremental-safe pruned
libraries, and NodeNext consumers. The
paired `scripts/__tests__/verify-package-build-strategies.test.mjs` money tests
mutate each protected seam, while a real compiler control observes NodeNext
rejecting an extensionless ESM import with TS2835.

### Agent declaration build split

`@brainstrike/agent` declarations are emitted by the package's composite
TypeScript project before tsup bundles JavaScript. Every agent tsup config
inherits `dts: false`; do not restore tsup's declaration-bundler worker or its
separate compiler-options override. The canonical `tsconfig.json` owns the
assistant-contract path mapping and emits every public entry declaration plus
the internal declaration graph those entries reference.

Development runs a project-only TypeScript watcher and the tsup watcher as
named sibling processes through the package's direct `concurrently`
dependency. The declaration watcher must use `tsc --project`, not
`tsc --build`: referenced packages own separate Turbo watchers, so build mode
would create multiple processes that can concurrently emit into the same
dependency `dist` directories. The watcher supervisor must terminate the
sibling when either process exits, so a failed declaration watcher cannot
leave a stale-but-running JavaScript watcher. The build order, disabled tsup
DTS worker, project-only declaration watch, and two-watcher topology are
guarded by `scripts/__tests__/agent-declaration-build-contract.test.mjs`.

### tsup clean/dts invariants (`pnpm lint`, BST-746)

`scripts/verify-tsup-build-invariants.mjs` (alias `lint:tsup-build-invariants`,
in both the `lint` and `lint:ci` chains; guard test:
`scripts/__tests__/verify-tsup-build-invariants.test.mjs`) generalises the rule
above from `@brainstrike/agent` to every workspace package. A package whose
`build` runs `tsc -b` must not let tsup `clean` the outDir (TypeScript wrote the
`.d.ts` files into it first, and tsup's clean is not concurrency-safe against the
sibling workspace builds that concurrent app prebuilds trigger) and must not let
tsup emit declarations (the separate declaration-bundler worker duplicates
`tsc -b` and causes severe build startup contention).

BST-746 originally proposed a `createTsupConfig` factory in
`@brainstrike/build-utils`. Measured and REJECTED — do not relitigate: at that
time only 9 of 18 configs were simple, and they genuinely diverged on
`sourcemap`, `format`, `target` and `splitting`. A factory would also have added
8 build-graph edges or hit the config-load hash-gap class
`verify-config-load-hash-coverage.mjs` guards. BST-1014 resolved the ordinary
library duplication by removing tsup from those packages, not by abstracting
their obsolete configs; the eight remaining configs describe real, divergent
bundle boundaries.

The invariant is CONDITIONAL, and the class is DERIVED from each package's
`build` script rather than hand-listed. **TypeScript-owned** — `agent`,
`assistant-service`, `assistant-wire`, `embedding-worker`, and `file-explorer` —
runs `tsc -b`/`tsc --build` then tsup, and is governed. **tsup-owned** — exactly
`chunking-worker`, `file-tree-worker`, and `token-cache` — runs tsup ALONE
(`type-check` is a separate `tsc --noEmit`), so tsup is the only possible
declaration emitter and `dts: true` is REQUIRED there. A flat "every config sets
clean/dts false" rule is false for those three. The exemption carries the
INVERSE obligation (a tsup-owned package that enables no declaration emit
FAILS), so it cannot be used as a parking spot to silence a violation; a test
pins the exempt set to those three names so growing it is deliberate.

Three rulings, all enforced and all with failure-path tests:

1. **Dynamic values are rejected**, not assumed safe. Only the literal `false`
   passes; `!options.watch`, a ternary, an env read, and the non-boolean shapes
   tsup accepts (`clean?: boolean | string[]`, `dts?: boolean | string |
   DtsConfig` — every non-false value ENABLES the behaviour) all fail. The guard
   reads source text and cannot prove an expression is false at build time.
   `clean: !options.watch` is not a false positive because every config using it
   is tsup-owned; in a `tsc -b` package it SHOULD fail, since `options.watch` is
   falsy during a plain `pnpm build`.
2. **`clean` and `dts` must be STATED EXPLICITLY** in a governed config that
   exists. tsup's defaults already match, so omission is currently harmless —
   which is the problem: `text-splitter` set neither while the guard claimed all
   governed packages were "pinned", an unverified assertion (the vacuous-green
   class the discovery floors exist to prevent), and deleting `clean: false` from
   a config would have been a silent no-op. The lower-level guard still models
   config-less tsup CLI invocations so its own flag detector cannot be bypassed,
   while the canonical package-build guard rejects that third real-tree shape.
3. **Every declaration-emit spelling is modelled**, verified against the
   installed tsup 8.5.1 rather than from memory: config keys `dts` AND
   `experimentalDts`, plus four CLI flags — `--dts`, `--dts-only`,
   `--dts-resolve`, `--experimental-dts`. tsup normalises
   `if (flags.dts || flags.dtsResolve || flags.dtsOnly)`, so `--dts-only` and
   `--dts-resolve` each enable emit ON THEIR OWN; they are not modifiers of
   `--dts`. `experimentalDts` may be omitted but never enabled.

Discovery floors (`MIN_TSUP_CONFIGS` = 8,
`MIN_TYPESCRIPT_OWNED_PACKAGES` = 5) refuse to run rather than report a vacuous
green — the second catches a collapsed classification, where discovery looks
healthy but the governed class has emptied out. Config parsing is line-shaped
with comments blanked (preserving line
numbers, which are printed in the report) after normalizing Windows CRLF input
to LF; a permissive cross-check THROWS on any
guarded token the line shape did not parse, so an unmodelled shape fails loudly
instead of escaping.

### App bundle chunk ceiling and tokenizer asset

Both app Vite builds use a 1,300 kB JavaScript chunk warning ceiling. This
accepts the measured local-first worker runtimes (browser bootstrap, PGlite,
and Transformers) plus the current renderer/main, context-preview, and
workspace-sync entry chunks while preserving a warning for growth beyond the
largest reviewed output. Do not raise the ceiling to accommodate tokenizer
data.

The browser `o200k_base` table is resolved through Vite's `?url` asset contract
and fetched only when an accurate-token-counting worker first initializes.
Keep the table out of JavaScript chunks and out of both apps' initial HTML
module-preload closure. Heuristic counting must not fetch the table. The
runtime behavior and both app ceilings are pinned by the tokenization package's
strict-counter/worker-lite tests and app Vite-config tests.

`@brainstrike/tokenization` is an ordinary tsc-only library and the sole source
owner. Its root exposes only synchronous constants, heuristics, and cost helpers;
its only public subpaths are the strict-counter and worker-lite modules that have
real consumers. Importing the root cannot pull tokenizer assets into an eager
graph. `chunking-worker` and `token-cache` bundle those shared entrypoints into
their own isolated artifacts; neither owns a source shim or imports the other
worker package.

The `chunking-worker` and `token-cache` tsup builds must install the shared
`tokenizerAssetPlugin` so their published worker artifacts preserve that URL
contract instead of parsing the table into JavaScript. Both package build
scripts run `verify-tokenizer-asset-bundle.mjs`; do not remove that post-build
guard when changing their bundle topology.

Both app worker builds install `preserveWorkerEntryPlugin`. Vite's worker
bundler options force `preserveEntrySignatures: false`; the bundler options hook
restores a strict entry facade. Without that facade, a lazy CommonJS dependency
can import worker startup from its own entry chunk without the managed instance
URL fragment and initialize it twice. The real Vite build regression executes
both the broken stock output and the preserved-entry output. Production web
also configures Zod's public `jitless` option in its small entry module before
dynamically configuring the host capability and then importing the application.
The previous static configuration module was bundled with application schemas,
whose initialization ran before configuration; this is a compiled chunk-ordering
failure, not a general claim about ESM dependency evaluation. The compiled
strict-CSP test is the ordering guard. `jitless` disables Zod parse code generation
in the window realm, preserving strict CSP at the cost of that optimization;
worker realms remain separate and their real startup/embedding paths must pass
the same CSP qualification before changing their schema initialization.

Both app builds install the shared
`createCspQualifiedEvalWarningFilter`. It suppresses Rolldown's `EVAL` warning
only for the exact web-tree-sitter 0.25.10 and PGlite 0.5.3 files whose real
runtime paths were exercised under the production CSP without `unsafe-eval`
(BST-573/594). The package versions and PGlite chunk filename are intentionally
pinned: an upgrade, a new emitted module, a different warning code, or an eval
from any other dependency must surface normally and require fresh review.
Never replace this with a code-only or package-wide warning suppression.

### Desktop development dependency freshness

`apps/desktop` invokes `scripts/ensure-desktop-dev-deps.mjs` for development,
including `dev:agent-debug`. Under root `pnpm dev`, the root pre-script already
completed that graph, so the desktop pre-script skips only when Turbo carries
the explicit preparation marker described in
[Development startup ordering (BST-1168)](#development-startup-ordering-bst-1168).
Standalone desktop and agent-debug launches run the helper synchronously.
Agent-debug runs that preflight
to completion before loading the Windows Job Object addon, then starts the
internal `dev:runtime` script under the initialized Job. This order is
mandatory on Windows: a loaded native addon cannot be replaced by node-gyp, so
loading the Job Object first would make a cold dependency build fail with
`EPERM`. When it is not inside a marked, already-prepared graph, the helper must ask
Turbo to build the exact desktop dependency graph.
Turbo's content hashes and cache are the freshness authority; checking only
whether `dist` files exist is forbidden because branch updates can leave
tool schemas, prompts, or provider code silently pinned to an older commit.
On a warm graph this check is cache-only and does not rebuild the desktop
renderer or unrelated packages. A non-zero Turbo result remains a visible
startup failure.

The shared `fullReloadOnCompilerHotspots` Vite plugin is the development HMR
boundary for cross-package React providers and stores. A hotspot update must
first call Vite's `moduleGraph.invalidateModule` for every affected module with
one shared invalidation set, the update timestamp, and importer invalidation
enabled; only then may it broadcast `full-reload` and return `[]`. Returning an
empty module set without that explicit invalidation leaves cached importer
transforms pointing at different timestamped module identities, which can make
a context consumer fail to see its mounted provider after reload. The contract
is pinned in `packages/build-utils/src/__tests__/vite.test.ts`.

### Agent-debug macOS automation identity

On macOS, `dev:agent-debug` launches through a lightweight temporary
`Electron.app` shim inside its disposable profile. The shim symlinks the
installed Electron executable, Frameworks, and Resources, but owns an
`Info.plist` with display name `BrainStrike Agent Debug` and bundle identifier
`com.brainstrike.desktop.agent-debug`. It is not a packaged application, does
not copy Electron's framework payload, and is scoped to the isolated temporary
profile. Shim construction is fail-closed: an unexpected Electron bundle
layout or malformed plist aborts startup rather than falling back to the
ambiguous `com.github.Electron` identity. Agent-debug windows pin the native
and accessibility title `BrainStrike Agent Debug`.

The launcher re-enters the exact pnpm CLI recorded in `npm_execpath` through
`process.execPath`. On Windows this is required because Corepack exposes a
`pnpm.cmd` shim rather than an executable that `child_process.spawn` can invoke
directly without a shell. The recorded entrypoint must be an absolute
`pnpm.cjs`, `pnpm.js`, or `pnpm.mjs` path — Corepack-managed pnpm resolves to
the `.mjs` form under its cache (`.../corepack/v1/pnpm/<version>/bin/pnpm.mjs`)
on every platform, so all three are accepted; `pnpm.cmd` stays rejected because
re-entering a shim as a Node script is exactly what this contract prevents.
Missing pnpm launch context fails before the
disposable profile is created; child spawn errors are observed and flow through
the normal owned-tree/profile cleanup path. Do not replace this with the shared
shell-based spawn helper: the extra `cmd.exe` process would sit between the
launcher and the process tree whose ownership the Windows Job Object enforces.

The launcher owns its development subprocess tree. On POSIX, `pnpm dev` is the
leader of a detached process group; shutdown signals that exact group with
SIGTERM, waits for quiescence, and escalates to SIGKILL after a bounded grace
period. This remains effective when the direct `pnpm` child exits before a
late-writing Electron or PGlite grandchild. Although other Windows process-tree
helpers may use an ancestry walk while their direct child remains addressable,
agent-debug does not use that weaker path: its launcher first joins a private
Windows Job Object with `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`, then starts
`pnpm dev` console-bound so Ctrl-C can be handled gracefully. Every descendant
inherits the non-breakaway job, so membership remains authoritative after an
intermediate parent exits. Cleanup waits for the job to contain only the
launcher, then terminates only the remaining job members after a bounded grace
period. Missing or malformed native Job Object support aborts Windows startup;
there is no ancestry-walk fallback. Only after the owned tree is stopped may
the launcher remove its temporary profile. Process-tree or profile cleanup
failures are visible fatal errors with a non-zero exit, never warning-only
cleanup. The always-on `Native Windows` CI job builds and exercises the native
addon with a late-writing orphan plus an unrelated-process survival assertion.

#### Stale-profile sweep (abrupt-kill recovery)

In-process cleanup covers every exit the launcher can observe, but SIGKILL, a
panic, and loss of power run no handler at all, and nothing reclaims `$TMPDIR`
while the machine stays up — 121 profiles totalling 262 GB accumulated over a
single eleven-day uptime. Because the profile is also
`BRAINSTRIKE_DB_ROOT_PATH`, each abandoned profile retains a whole PGlite
cluster, so the leak is measured in gigabytes.

Each profile records an `agent-devtools-owner.json` marker
(`{ pgid, pid, platform, startedAtMs }`). `pid` and `platform` are written
immediately after `mkdtemp`; `pgid` is added right after `pnpm dev` is spawned,
because the group does not exist before then. On startup, after spawning its own
dev server, the launcher sweeps sibling `brainstrike-agent-devtools-*`
directories.

**A dead launcher pid is not proof the profile is idle.** On POSIX `pnpm dev` is
spawned detached, so SIGKILLing the launcher leaves the whole tree reparented and
still writing to this directory. Reclaiming on the pid alone would `rm -rf` a
live PGlite cluster — the historical failure, re-created from the other side —
and on macOS would also delete the running app's own `electron-dist` bundle.
Verified by experiment: after `kill -9` of the launcher, the detached tree stays
alive and keeps writing.

The sweep is opportunistic hygiene, **not** the ownership guarantee, and the two
must not be conflated:

- A sibling is reclaimed only when the launcher pid is dead **and** its recorded
  process group has no live members. Every uncertain liveness answer resolves to
  alive (`EPERM`, a recycled pid), so the sweep can only under-delete. An age
  threshold is deliberately **not** the deciding signal: a long-running
  agent-debug session is both old and live.
- A marker written before the current boot is reclaimable outright: no process
  from before the boot survives. Without this, pids re-issued from a low
  watermark after a reboot probe as alive against unrelated processes and the
  profile becomes permanently unreclaimable.
- On `win32` the launcher pid suffices — descendants inherit a non-breakaway Job
  Object with `KILL_ON_JOB_CLOSE`, so no tree outlives the launcher.
- A profile with a missing/malformed marker, or a POSIX marker with no recorded
  `pgid`, cannot be proven stale. It is reported as an explicit list of paths,
  **with no removal command**, and is **never** auto-deleted. Any glob in that
  report is paired with `ls -d` only: a `brainstrike-agent-devtools-*` glob also
  matches a concurrent session's profile.
- Skipped and failed profiles are both reported. Skipping is the safe answer,
  but a machine where the sweep never reclaims anything must not look identical
  to one with nothing to reclaim.
- The sweep runs after the dev server is spawned, so it overlaps startup instead
  of delaying it, and it never fails a launch. The run's own profile stays
  fail-loud through `removeUserDataDir`; do not make the sweep fatal to "match"
  it.

The marker sits at the profile root, which is safe only because the database
joins `<root>/profiles/<profile>` and never enumerates the root. Re-verify that
before adding anything else there.

Manual QA must cover both automation surfaces while another Electron app is
running:

1. Run `pnpm --filter @brainstrike/desktop dev:agent-debug` and connect CDT to
   the printed local CDP endpoint (default `http://127.0.0.1:9222`). Confirm the
   visible target is the expected BrainStrike renderer.
2. In Computer Use, verify `list_apps` reports
   `com.brainstrike.desktop.agent-debug` as `BrainStrike Agent Debug`, then call
   `get_app_state({ app: "com.brainstrike.desktop.agent-debug" })`.
3. Confirm the accessibility tree describes the same renderer URL/title seen
   through CDP. Do not stop or retarget unrelated Electron processes.
4. Stop the documented root command with Ctrl-C, wait for it to exit, and
   confirm the printed `brainstrike-agent-devtools-*` profile remains absent
   after a bounded post-exit observation. Keep unrelated Electron processes
   running throughout this check.
5. Verify abrupt-kill recovery in the correct order — the orphaned tree must be
   spared, not reclaimed, while it is still alive:
   a. Start the launcher, `kill -9` its pid, and confirm the printed profile
      survives and the orphaned Electron/PGlite tree is still running.
   b. Start a second session. It must report the profile as *still in use* and
      leave it on disk. Reclaiming it here would delete a live database.
   c. Kill the orphaned process group, then start a third session and confirm it
      now reports reclaiming that profile and the directory is gone. A
      concurrently running session's profile stays untouched throughout.

---

## SHRINK-ONLY FILE BUDGETS (BST-1652)

`packages/app-shell/src/__tests__/assistant-contract-boundary.test.ts` guards
`assistant-ui-panel-wrapper.tsx` and its executable test with a budget that runs
ONE WAY. This is a deliberate reversal, not an oversight, and it should not be
softened back into a ceiling with headroom.

The previous budget was a cap that got raised roughly twenty times, 1,500 →
1,905, each raise justified in-file as "the wrapper only adds ONE hook call and
ONE prop". Individually true; collectively it made the most-churned file in the
repo the seam every assistant feature had to cross, and made crossing it free.
An instrument that records growth is not a guard.

The rule:

- The recorded number is the file's CURRENT line count, never an allowance.
  Growth past it fails. The fix for a failure is to put the code in a hook or a
  module (`src/assistant-panel/` for panel-scoped logic), not to raise the number.
- Shrinking more than `RE_BASELINE_SLACK` (40) below the number ALSO fails, with
  a message naming the new number. Lower it in the same commit; recovered
  headroom must not be bankable by the next feature.
- Both directions must be able to fail. Verify that before trusting the budget —
  a budget that can only pass is not evidence.

Apply the same shape to any new file-size guard rather than reintroducing a cap.

## REACT DOCTOR (LINT)

`.github/workflows/react-doctor.yml` runs **React Doctor** (`millionco/react-doctor@v2`,
pinned `0.9.13`) on every PR and on push to `main`. It was adopted to supersede standalone knip
in CI by pairing knip-style dead-code analysis (the `deslop` engine, a separate `deslop-js`
dependency through 0.9.12) with its React/JS lint rules (Security / Bugs / Performance /
Accessibility / Maintainability). At 0.9.13 dead-code analysis is not active in this
repository — see the knip bullet below.
It uses `ubicloud-standard-2`; provider allocation has no GitHub fallback.
Config lives in `doctor.config.ts`. Plan + baseline: `docs/react-doctor-migration-2026-06-15.md`
(historical: it predates `deslop`'s removal, and this section wins where they differ).

Invariants (do not regress without updating this section, `doctor.config.ts`, and the doc):
- **Telemetry OFF.** `noScore` + `share:false` in config; `REACT_DOCTOR_NO_TELEMETRY=1` in the
  workflow `env` (the Action exposes no flag). Nothing is sent to the hosted score API / Sentry.
- **Gate = `scope: changed` + `blocking: error`.** Only NEWLY introduced error-severity issues
  fail a PR; the pre-existing backlog is advisory and is burned down in stacked PRs. The pinned
  version carries [upstream's rename-aware baseline comparison](https://github.com/millionco/react-doctor/pull/1376),
  so moving unchanged code does not reclassify its diagnostics as new. Re-checked for 0.9.13
  (2026-09-15) against upstream source, not re-run here: the `baseline-pure-rename` regression
  test is byte-identical at the `react-doctor@0.9.11` and `react-doctor@0.9.13` tags.
  `compute-diagnostic-delta.ts` also gained detector-provided identities that take precedence
  over source evidence. Across both the `react-doctor` and `oxlint-plugin-react-doctor` 0.9.13
  `dist/` trees the only detector that sets one is `duplicate-jsx-subtree`, keyed on its
  JSX-family fingerprint and occurrence count rather than a path; whether that interacts with a
  BST-981-style rename set is untested. CAVEAT (BST-981,
  2026-08-06, not re-tested since): that pairing failed on a ~200-file rename PR —
  byte-identical renamed files had their pre-existing diagnostics reclassified as new, both in
  CI and in a local `--scope changed` run. Precedent: prove pre-existence with a full scan of
  the base at the old paths, then suppress narrowly via `ignore.overrides` with a follow-up
  ticket to fix the findings and drop the override. BST-1182 completed that cleanup for the
  three assistant-ui ref mutations and removed the temporary override; the caveat remains for
  future large rename sets, not as an active exception.
  `scripts/__tests__/react-doctor-version-contract.test.mjs` keeps the local and Action pins equal
  and rejects downgrade below the 0.8.2 fix. It also pins the exact reviewed version in
  `EXPECTED_REACT_DOCTOR_VERSION`, so a bump is a three-file change: root `package.json`,
  `.github/workflows/react-doctor.yml`, and that constant.
- **Keep lint enabled when reading JSON coverage.** React Doctor's `analyzedFiles`,
  `analyzedFileCount`, and `complete` fields describe its lint pass, not dead-code enumeration.
  Passing `--no-lint` therefore reports zero analyzed files and `complete:false`; through 0.9.12
  it still scanned every project for dead code, and that output is expected, not a repository
  config or environment failure (BST-1142, verified against 0.9.11 on 2026-08-23 and upstream's
  [JSON report contract](https://github.com/millionco/react-doctor/blob/main/docs/json-report.md)).
  Re-measured at 0.9.13 (2026-09-15, `cf2d8db86`): `--no-lint` reports `analyzedFileCount` 0,
  empty `analyzedFiles`, and `complete:false` for all 23 projects while `scannedFileCount`
  totals 4360; the lint-enabled full scan reports 4360 analyzed with `complete:true` for every
  project. At the `react-doctor@0.9.13` tag the contract still defines `complete` by the
  planned lint files. At 0.9.13 `--no-lint` runs no dead-code rules (see the knip bullet). It
  still reported one `duplicate-jsx-subtree` warning: that detector is tagged `project-analysis`
  and runs outside the per-file lint pass, so it reports even with zero analyzed files.
  The root `react-doctor` script pins `--scope full` and deliberately omits `--no-lint` — at
  0.9.13 that protects lint coverage, not dead-code scanning;
  `scripts/__tests__/react-doctor-version-contract.test.mjs` guards both properties.
- **0.9.11 activated four error-severity rules that 0.9.3 did not** (measured at 0.9.11 on
  2026-08-15, BST-1273; historical — the 0.9.13 re-measurement follows).
  Measured on the same tree, same 3366 scanned files: full-scan errors go 85 → 95 while total
  issues go 641 → 594. The additions are `react-hooks-js/todo` (×4), `react-doctor/
  no-prop-callback-in-render` (×3), `react-hooks-js/refs` (×1),
  `react-doctor/effect-observer-needs-disconnect` (×1), plus one extra
  `react-doctor/effect-needs-cleanup` hit (10 → 11). `no-ref-current-in-render` (×71) and
  `no-impure-state-updater` (×4) are unchanged. All 10 are pre-existing code newly caught, so
  under `scope: changed` they join the advisory backlog rather than blocking; none sit in a
  file the bump itself touched. Concentrations to expect when burning them down:
  `root-layout-content.tsx` (all three copies) and `hooks/use-resize-observer.ts`.
  **Re-measured at 0.9.13** (2026-09-15, `cf2d8db86` — `main`, 132 commits after #3038's squash
  merge, not #3038's head `3e50c70cd`; 23 projects / 4360 files / 608 issues):
  the 85 errors are `no-ref-current-in-render` ×67, `effect-needs-cleanup` ×10,
  `no-impure-state-updater` ×4, `no-prop-callback-in-render` ×3, and
  `effect-observer-needs-disconnect` ×1. This is a larger tree than the 3366-file one above,
  so the two sets of counts are not a before/after, and 0.9.13's 85 matching 0.9.3's 85 does not
  mean the rule set reverted. Of the four 0.9.11 additions, the two `react-doctor/*` rules still
  report; the two `react-hooks-js/*` rules report nothing — see the next bullet.
- **`react-hooks-js/*` rules do not run in this repository** (2026-09-15, 0.9.13; tracked in
  BST-1760). The full scan has **zero `react-hooks-js/*` findings of any severity**:
  `react-hooks-js/todo` and `react-hooks-js/refs` are not clean, they are not loaded (the same
  `refs` compiler rule holds a 123-warning ESLint budget in `eslint-warning-baseline.json`).
  React Doctor loads `eslint-plugin-react-hooks` as `react-hooks-js` only for a project it
  detects as using the React Compiler, and all 23 projects report `hasReactCompiler:false`. The
  bump did not cause this: the detection code is identical in 0.9.11 and 0.9.13, and in an
  isolated directory holding only `apps/web`'s `package.json` + `vite.config.mts` and one
  component, 0.9.13 reports `hasReactCompiler:true` for the files before BST-1659 (#3017, which
  moved the compiler from a Babel preset to `oxc-transform-react`) and `false` for the current
  ones. #3017 is an ancestor of #3038's head, so #3038's 0.9.11-vs-0.9.13 comparison (85 → 85
  errors) already ran without the plugin. BST-1273's 0.9.11 counts of `react-hooks-js/todo` ×4
  and `react-hooks-js/refs` ×1 (2026-08-15) predate #3017's 2026-09-06 merge, which is why those
  rules were still observable then. **Unresolved:** nothing in this repository has been changed
  to restore these rules; BST-1760 tracks the decision.
- **`react-doctor/no-multi-comp` re-measured for 0.9.13** (2026-09-15). BST-1273 said not to
  bump past 0.9.11 without re-measuring it. #3038 took 0.9.13 without measuring this rule
  specifically; its full-scope 0.9.11-vs-0.9.13 comparison (85 → 85 errors, "Crowded component
  file ×7" among the new warnings) covered it only incidentally. Upstream 0.9.12
  ([#1641](https://github.com/millionco/react-doctor/pull/1641)) split the rule:
  `react-doctor/no-multi-comp` is now the strict one-component-per-file port,
  `defaultEnabled: false` at severity `warn` (`react/no-multi-comp` aliases to it), and the
  previous lower-noise policy moved to `react-doctor/no-multi-component-file`, on by default at
  `warn` and reported as "Crowded component file". The 0.9.13 full scan reports `no-multi-comp`
  ×0 and `no-multi-component-file` ×7 warnings in 2 files; no repo config sets either id, so
  neither can trip `blocking: error`. The id's occurrence count in `react-doctor/dist/` is 6 at
  0.9.11 (reproduced from the published tarball), 15 at 0.9.12 (BST-1273, not re-measured), and
  10 at 0.9.13 — a proxy, not a severity signal, and `dist/`-only: the rule itself ships in
  `oxlint-plugin-react-doctor`. Enabling `no-multi-comp`, or raising either id
  to `error`, is the change that needs a fresh multi-component scan first.
- **knip is retained (NOT replaced), but CI never runs it.** Before 0.9.13, `deslop` was not
  knip: it read knip's `entry`/`ignore` (only from strict-JSON `knip.json` or
  `package.json#knip`, never `knip.jsonc`) but ignored knip's `ignoreDependencies` and had no
  per-dependency allowlist, so `deslop/unused-dependency` + `deslop/unused-dev-dependency` were
  disabled in `doctor.config.ts`. 0.9.13 removed `deslop`
  ([#1624](https://github.com/millionco/react-doctor/pull/1624)): whole-project analysis is now
  `react-doctor/unused-{file,export,type,dependency,dev-dependency}` +
  `react-doctor/circular-dependency`, all opt-in (`defaultEnabled: false`) and, per #1624, kept
  out of changed and staged scans. The config's `deslop/*` keys still resolve through upstream's
  `LEGACY_RULE_KEY_TO_NATIVE_RULE_KEY` alias table, but they only switch off rules that are
  already off, and nothing opts a graph rule in. So at 0.9.13 **neither CI (`scope: changed`)
  nor the root full scan runs dead-code analysis**, and the "Left active: … unused-file +
  circular-dependency" comment in `doctor.config.ts` is stale. That comment and the inert
  `deslop/*` disables are deliberately left in place by the docs-only 0.9.13 re-measurement
  (BST-1759 records them as out of scope). Opting `unused-file` + `circular-dependency` in
  (2026-09-15) produced 0 graph findings and an unchanged 608-issue report; that alone does not
  prove the rules are live. `pnpm knip` (driven by `knip.jsonc`, with the curated false-positive
  allowlist) stays the dependency auditor, but CI never reaches it: no file under
  `.github/workflows/` invokes knip, and neither the turbo config nor any root or `scripts/`
  command those workflows run (`check`, `lint:ci`, `boundaries`, `type-check`, `test`, `build`,
  `test:scripts`) references it (2026-09-15). So at 0.9.13 CI runs no dead-code or
  unused-dependency analysis at all. BST-1761 tracks that gap.
- **No broad `ignore.files` exclusions.** The old 0.5.5/0.7.1 implementation silently dropped
  roughly half the monorepo when that key was present. Upstream fixed enumeration by listing
  all supported sources before filtering (0.9.3, per `doctor.config.ts`; the 0.9.13 full scan
  analyzes all 4360 scanned files with every project `complete:true`), but Brainstrike still
  needs no whole-file ignores: build artifacts are gitignored and test-file noise is handled
  natively. Prefer the narrow `ignore.overrides` / `rules` surfaces for a proved exception.
- **`Accessibility` + `Security` categories are OFF.** a11y is already enforced by the
  biome a11y rules (and react-doctor can't read `biome-ignore`, so it re-flagged every
  documented exception + custom ARIA widget — an audit of 28 findings found 1 genuine
  gap). Security produced 0 genuine issues across 6 real-source findings; secret detection
  stays covered by the lefthook `secrets-scan`. react-doctor's unique value here is its
  React-Compiler-correctness rules (`react-hooks-js/*`, `react-compiler-*`) + dead-code,
  which is where remediation effort is focused. At 0.9.13 none of that runs here: the
  `react-hooks-js/*` rules and dead-code analysis are inactive (see the `react-hooks-js` and knip
  bullets; BST-1760 and BST-1761 track restoring them), and the only `react-compiler-*` id,
  `react-compiler-no-manual-memoization`, is off by config and, per its upstream source, active
  only when the React Compiler is detected, which no project here is. What still reports is
  React Doctor's native set: 53 `react-doctor/*` rule ids in the 2026-09-15 full scan, and all
  85 errors come from that set.
- **`react-compiler-no-manual-memoization` is OFF.** Manual `useMemo`/`useCallback`/
  `React.memo` is intentional here (guards non-React work, external-store identity,
  referential stability for consumers outside the compiled tree). The rule fired 1211× in the
  2026-06-15 baseline (react-doctor 0.5.5; 54% of that 2258-finding backlog) demanding removal —
  disabled per team decision.
  `react-hooks-js/preserve-manual-memoization` stays ON in config (it protects memo the
  compiler needs), but at 0.9.13 the `react-hooks-js` plugin is not loaded here; see the
  `react-hooks-js` bullet.
- **An unimplemented rule id is accepted SILENTLY — 0 findings means "gone" OR "clean".**
  `doctor.config.ts` emits no "unknown rule" error, so a config that believes it enabled
  (or disabled) a rule is indistinguishable from one that did not, and that rule's zero
  findings read as a passing gate. Re-proved at 0.9.13 (2026-09-15) with a deliberately
  nonexistent id: adding `'react-doctor/zz-nonexistent-rule-probe': 'error'` produced no
  warning and an identical 608-issue summary. The original example no longer holds:
  `react-doctor/only-export-components` (2026-08-09, pinned 0.9.3) was judged alias-only from a
  grep of `react-doctor/dist/` alone, where it appears as a *value* in the oxlint→react-doctor
  alias tables (`react-refresh/only-export-components` and `react/only-export-components` both
  map to it). The separately published `oxlint-plugin-react-doctor` carries a registry entry for
  the id at 0.9.11 and 0.9.13, and at 0.9.13 the rule reports ×45 warnings in the default full
  scan. That example's control — adding `rules: { 'react-doctor/only-export-components': 'warn' }`
  left counts byte-identical (149 → 149 on `packages/file-explorer-ui`) — remains a 0.9.3
  measurement, not re-run. An unchanged count could never prove absence: it is also what an
  already-enabled `warn` rule, or a rule with no violations in that package, produces. Reuse
  the nonexistent-id probe above as the silent-acceptance control. **Before citing a
  react-doctor rule id as a contract, prove it fires on a known violation** — a
  package-scoped scan returning 0 is not evidence.
  `scripts/__tests__/lint-rule-liveness-contract.test.mjs` mechanizes that proof — **for
  ESLint rules only.** It drives `new ESLint({ cwd: repoRoot })` against `eslint.config.js`,
  so it exercises **zero react-doctor rules** and confers no coverage on any
  `react-doctor/*` or `react-hooks-js/*` id, or on the legacy `deslop/*` aliases. Do not
  read a green `test:scripts` as evidence that a react-doctor id is live; that engine remains
  unmechanized, and it is the one with the silent-acceptance defect.
- **The two ids once "absent from the bundle" were a grep-scope miss; only `async-parallel` is
  proved live** (2026-08-09, #2372;
  re-measured at 0.9.11 on 2026-08-15, BST-1273; re-measured at 0.9.13 on 2026-09-15).
  `react-hooks-js/preserve-manual-memoization` and `react-doctor/async-parallel` (the rule in
  `doctor.config.ts`'s lone `ignore.overrides` entry) still appear **0 times** across
  `node_modules/react-doctor/dist/` at 0.9.13. Occurrence counts there by `grep -o | wc -l`,
  at 0.9.3/0.9.11 then 0.9.13: `only-export-components` 12 then 8;
  `react-compiler-no-manual-memoization` 10 then 7; `preserve-manual-memoization` 0 then 0;
  `async-parallel` 0 then 0. The 0.9.11 figures reproduce from the published tarball. But
  rule metadata ships in the separate `oxlint-plugin-react-doctor` package (`async-parallel`
  ×10 at 0.9.11, ×12 at 0.9.13), and the compiler rules come from `eslint-plugin-react-hooks`,
  loaded as `react-hooks-js`. Liveness at 0.9.13: **`react-doctor/async-parallel` is live** —
  the default full scan reports it ×4 in files other than `db-provider.tsx` — so the override
  targets a real rule. `react-hooks-js/preserve-manual-memoization` is registered (severity
  `error` in the plugin's compiler-rule table) but reports nothing here because the
  `react-hooks-js` plugin is not loaded (see the `react-hooks-js` bullet). Registry presence is
  not firing evidence, and no planted violation has proved this id live. The manual-memoization
  protection still exists via eslint-plugin-react-hooks' own
  `react-hooks/preserve-manual-memoization`, which is live, reporting 2 warnings, and is
  tracked in `eslint-warning-baseline.json`.
- **The Fast Refresh module-boundary contract is NOT react-doctor's — it is
  `react-refresh/only-export-components` in `eslint.config.js`** (BST-1220, #2372, plugin
  `eslint-plugin-react-refresh`), riding the same `--max-warnings` ratchet as the
  compiler diagnostics. It landed at 155 warnings across 77 files; burn it down and lower
  its baseline entry, exactly as for the compiler wave.
  **That ratchet is now PER RULE.** `eslint-warning-baseline.json` holds one budget per
  rule id and `scripts/verify-eslint-warning-baselines.mjs` enforces it as `lint:eslint`.
  A rule OVER its entry fails; a rule UNDER its entry also fails until the entry is
  lowered, so every burn-down is banked instead of leaving headroom behind; a rule with
  findings and no entry fails; error-severity findings never get a budget. This replaced a
  single `--max-warnings=N` scalar, which could not tell the two warning families apart —
  burning Fast Refresh warnings silently granted the same headroom to compiler
  diagnostics. The scalar had already failed that way: #2372 found 186 actual warnings
  under an unchanged 194 ceiling. Re-baseline with
  `pnpm run lint:eslint --write-baseline`, and read the diff — an unexplained drop is a
  rule going dark, not a win. Biome's `useComponentExportOnlyModules`
  was evaluated and rejected for this job despite already being installed and already
  blocking: measured against this repo it also flags unexported components (63 sites —
  not a defect, since `@vitejs/plugin-react`'s `validateRefreshBoundaryAndEnqueueUpdate`
  walks `moduleExports` only, so a private component never breaks the boundary) and
  misreads `export default <Component>` aliases (29 false positives, e.g.
  `logging-settings.tsx`, whose only exports are one component named and defaulted).
  The eslint plugin matches the Vite runtime semantics; do not swap in Biome's rule
  without re-measuring both.

  The required Static job owns the full-tree ESLint verdict through `lint:ci` ->
  `lint:eslint`. `scripts/__tests__/verify-script-entrypoints.test.mjs` separately proves
  that executable verifier wiring can run and fail; it must not repeat full-tree audits merely
  to observe output. The four measured hotspots — ESLint warning baselines, workspace source
  aliases, private test input locality, and source cycles — therefore support an explicit
  `--repo-root <path>` control seam. Their full-tree verdicts remain in their owning lint
  commands or paired real-tree tests. The entrypoint test launches each of those four bounded real
  child processes against a temporary invalid root and requires all three signals: output, a nonzero exit, and a
  fixture-specific failure path. Its executable negative controls cover a no-op `main`, an
  incorrect direct-execution predicate, an ignored fixture root, and a lost nonzero exit
  status. Each default command remains the full repository audit, including ESLint's
  `--write-baseline` mode. On the 2026-09-18 main checkout, two local entrypoint-suite
  baselines took 26.39s and 26.54s; the bounded suite took 3.11s. The four duplicate scans
  accounted for 24.08s in the per-verifier profile. This is verifier-proof cost, not a
  guaranteed reduction in the required check's final elapsed time.

### React Compiler bailouts are invisible — measure them (BST-1659)

Both app bundles run the React Compiler through `oxc-transform-react` (Rust), enabled as
`react({ compiler: ReactCompilerConfig })` in `apps/web/vite.config.mts` and
`apps/desktop/vite.config.mts`. `compilationMode: 'infer'` is unchanged and is a non-goal to
change. The Babel detour (`@rolldown/plugin-babel` + `reactCompilerPreset`) is gone from both
apps; `@vitejs/plugin-react` ≥ 6.1.0 with the optional peer `oxc-transform-react` replaces it,
and the same plugin now owns the JSX transform and Fast Refresh injection.

- **oxc is not "preferred" — it is the only backend `react({ compiler })` has.** This matters
  because `babel-plugin-react-compiler` and `@rolldown/plugin-babel` stay resolvable next to
  `@vitejs/plugin-react` through workspace-root peer resolution even though both app manifests
  dropped them, so "Babel is out of the app builds" needs proof rather than absence.
  `createReactCompilerPlugin` in `@vitejs/plugin-react@6.1.1` contains a single
  `await import('oxc-transform-react')` and no Babel branch; a missing package is
  `this.error(...)`, a hard build failure, never a fallback. `reactCompilerPreset` (the Babel
  path) is only reachable if a config calls it and feeds it to `@rolldown/plugin-babel` —
  neither app does. Confirmed three ways on 2026-09-06: the plugin source above; the build's own
  `PLUGIN_TIMINGS` block naming `vite:react-compiler transform (1656 calls)` with no
  `@rolldown/plugin-babel` row; and by mutation — hiding `oxc-transform-react` from
  `node_modules` and the plugin's peer directory, with `babel-plugin-react-compiler@1.0.0` left
  in place, fails `vite build` with `React Compiler requires the optional 'oxc-transform-react'
  package`. Re-run that mutation rather than trusting a version bump.
- **Restore the `.vite` exclusion whenever `cacheDir` moves out of `node_modules`.**
  `@vitejs/plugin-react` defaults to `exclude: /\/node_modules\//`, but both apps set
  `cacheDir: <app>/.vite`, so the dep-optimizer output sits OUTSIDE `node_modules` and the
  default would let the compiler and the Fast Refresh transform run over pre-bundled dependency
  chunks in dev. Both configs pass `exclude: [/[\\/]node_modules[\\/]/, /[\\/]\.vite[\\/]/]`,
  which is what the removed `@rolldown/plugin-babel` pass carried. This is a dev-path
  correctness guard: the production bundle is byte-identical with and without it (1283 cache
  sentinels either way).
- **What else the filter swap changed, and what it did not.** The compiler's eligible extension
  set narrowed from `/\.(?:[jt]sx?|[cm][jt]s)(?:$|\?)/` (`@rolldown/plugin-babel`'s default) to
  `/\.[tj]sx?$/`, dropping `.mjs`/`.cjs`/`.mts`/`.cts`; the only first-party module of that
  shape in either app graph is a worker, so nothing was lost. `.ts` is NOT excluded — mapping
  the built bundle's `react.memo_cache_sentinel` sites back through a `--sourcemap` build lands
  on `.ts` modules (`packages/db/src/use-db.ts`, `packages/ui/src/hooks/use-copy-to-clipboard.ts`
  and peers) at roughly the inventory's own 17% `.ts` share, so there is no category-level
  `.ts` loss hiding under a net bundle-wide gain. The compiler's position in the pipeline did
  NOT change either: `@rolldown/plugin-babel` and `vite:react-compiler` are both
  `enforce: 'pre'`, and Vite orders every pre plugin ahead of the core `vite:oxc` JSX transform,
  so both passes saw real JSX rather than `_jsx(...)` calls. Do not attribute the 978 → 1130
  delta to a transform-ordering change.
- **A bailout is silent in BOTH backends, and no build flag changes that.** `infer` skips any
  function it cannot analyse and emits nothing. `oxc-transform-react` 0.148.0 returns only
  *fatal* diagnostics in `TransformResult.errors`, which stay empty for an ordinary bailout, and
  `@vitejs/plugin-react`'s `compiler.logDiagnostics` forwards exactly those same `errors` — so
  turning it on does NOT surface bailouts. Do not cite it as bailout coverage.
- **`scripts/react-compiler-inventory.mjs` is the measurement.** One command per backend:
  `node scripts/react-compiler-inventory.mjs --backend <babel|oxc> --out <file.json>`, plus
  `--diff <baseline.json> <candidate.json>`, which exits nonzero when a function that compiled
  in the baseline no longer compiles. Run the diff before any compiler-toolchain change.
  `scripts/__tests__/react-compiler-inventory.test.mjs` guards it under `pnpm test:scripts`.
- **The instrument refuses to report a false green.** An unknown `--backend` is rejected before
  the walk (it used to become one identical per-file failure, a written JSON and exit 0); an
  inventory carrying ANY analysis failure is neither written nor diffed, because a file that
  failed to parse is indistinguishable from a file with no compiled functions; and `--diff`
  rejects a baseline stamped with an older `inventoryFormat`. Regenerate baselines after
  touching the script rather than diffing against a stale one.
- **Only a function with an identity on BOTH sides is compared.** The diff keys on
  `file::name`, and the names come from the COMPILED OUTPUT, whose line numbers differ per
  backend. Three kinds of record are marked `matchable: false`: one that cannot be named, one
  sharing its name with another function in the same file, and one whose name does not appear
  in the source at all (a name the backend synthesized — two backends need not spell it the
  same way). Keying any of them surfaces one unchanged function as a regression AND a win.
  Matchability is then judged across the comparison, not per side: a key ambiguous in either
  inventory is dropped from both, because keeping the unambiguous side manufactures a win out
  of the other side's collapse. Such records are reported as an explicit "outside this
  comparison" count.
  **Dropping a key is not the same as having nothing to say about it.** Per-key compiled
  multiplicities are compared for every dropped key, and any key the candidate compiles fewer
  times than the baseline is reported as an ambiguous coverage loss and fails the command —
  otherwise a file that compiled `Row` twice and now compiles it never would print "0
  regressed" and exit 0, which is the false green this instrument exists to refuse.
  Both current inventories carry zero unmatchable records, so the numbers below are not
  softened by any of it; the rules are what keep that checkable rather than assumed.
- **The measurement is output-based, so it is identical across backends**: compile a module,
  then record every function that received a `react/compiler-runtime` cache slot. Only the
  Babel backend can also name the functions the compiler *attempted and failed*, with a reason,
  because only it exposes a per-function `logger`. That is the sole reason
  `babel-plugin-react-compiler` and `@babel/core` remain ROOT devDependencies; neither is in
  either app's build any more. An oxc report therefore carries
  `bailoutReasonsSupported: false` rather than an empty bailout list.
- **Bailouts are grouped per FUNCTION, not per error site.** The compiler logs one
  `CompileError` per failing site, so counting events inflates the total — 466 events over 258
  functions at the time of measurement.
- **Enable the JSX parser plugin only for `.tsx`/`.jsx`.** `<T>(x: T) => x` is a type-parameter
  list in `.ts` and an unterminated JSX tag in `.tsx`; parsing every file as JSX silently drops
  each `.ts` module holding a generic arrow (5 files when this was first run).

Measured on 2026-09-06 over 2177 first-party source files (`apps/web/src`,
`apps/desktop/src/renderer`, `packages/*/src`):

| | Babel 1.0.0 | oxc 0.148.0 |
| --- | --- | --- |
| functions compiled | 978 | 1130 |
| functions bailed | 258 | not reportable |
| compiler pass, single-threaded | 11.6 s | 1.02 s |

The migration diff was **0 regressions, 152 newly compiled**, with 0 records on either side
that the diff could not identify. End to end in the `apps/web` bundle,
`react.memo_cache_sentinel` sites went 1081 (Babel, measured before the migration) → 1283
(`grep -ro 'react\.memo_cache_sentinel' apps/web/dist | wc -l` on the current tree). 106
functions that Babel bailed on are still not memoized.

- **Our largest components are NOT compiled, under either backend.** The eleven largest
  first-party files each have their principal component or hook bailing:
  `threads-panel.tsx::ThreadsPanel`, `workspace-collection-sync-provider.tsx::
  WorkspaceCollectionSyncProvider`, `use-lazy-file-tree.ts::useLazyFileTree`,
  `assistant-ui-panel.tsx::LocalRuntimeChat`,
  `assistant-ui-panel-wrapper.tsx::AssistantUiPanelWrapper`, `tree-table.tsx::TreeTable` and
  peers. Their hand-written `useMemo`/`useCallback` is the only memoization they have — which
  is why `react-hooks/preserve-manual-memoization` matters and why
  `react-compiler-no-manual-memoization` stays OFF (see above). Note this is per-function, not
  per-file: `threads-panel.tsx` is 3415 lines and compiles 23 of its 25 attempted functions
  while the top-level `ThreadsPanel` bails.
- **The dominant bailout causes**, by remaining site count: destructuring defaults in an object
  pattern (`{ a = 1 }`, 63), `try`/`finally` (37), `try` without `catch` (28), refs read during
  render (24), `throw` inside `try` (14). Logical assignment (`??=`) accounts for only 4 sites,
  in 4 functions — the repo has 64 logical-assignment occurrences across 48 files, but `infer`
  never attempts the plain factory functions holding the other 60.
- **This is why `eslint-warning-baseline.json` is a floor over the *analysable* subset, not
  over the codebase.** A bailed function reports zero messages of any compiler-powered rule.
  Extracting code out of one surfaces latent findings and reads as a CI regression while being
  nothing of the sort (this cost a round-trip in BST-1652). Check the inventory before treating
  a baseline increase as a real regression, and do not adjust the baseline speculatively.
- **`??=` and `throw`-inside-`try` are not oxc-specific limitations.** Babel's React Compiler
  1.0.0 rejects both identically, so neither was a migration risk; every function failing on
  them failed before the migration too.

Local dependency audit: run `pnpm knip` from the repository root after installing
dependencies. The command builds `@brainstrike/platform-utils` and
`@brainstrike/build-utils` through the bounded Turbo wrapper before Knip loads
the Vite/Playwright configs, so absent
`dist/` directories need no manual preparation; a failed build stops the audit,
and an audit failure remains nonzero. `scripts/__tests__/knip-workflow.test.mjs`
exercises that command ordering and both failure paths. The web-only
`@brainstrike/mcp-app-host-ui` ignore documents its real CSS `@import`, which the
workspace's TS/TSX project glob does not follow. Installed Knip 6.32.2 rejects
workspace-level `rules` (including `exports: "warn"`), so the BST-1642 trial for
`types`, `utils`, `logging`, `tokenization`, and `worker-runtime` has no warning
counts; keep existing global severities until a version supporting scoped rules
is deliberately adopted. App category registration is tested through each app's
rendered settings navigation; settings-ui tests must not read either app's source
without declaring those cross-package inputs in Turbo.

Local: `pnpm run react-doctor` (lint-enabled full scan, telemetry off via config) ·
`pnpm exec react-doctor . --no-supply-chain --scope full --json --no-cache` (fresh machine report) ·
`npx react-doctor . --scope changed --verbose` (only new issues) ·
`npx react-doctor why <file>:<line>` (explain a rule).

**The script is named `react-doctor`, not `doctor`, and the `run` is not optional.**
`doctor` is a pnpm **builtin** subcommand, so `pnpm doctor` <!-- shadowed-shorthand-example --> runs pnpm's own
environment doctor and never reaches any package script — while printing
`All checks passed with 1 warning(s)` and exiting 0, which reads exactly like a
clean react-doctor run. Because react-doctor error-severity findings are a
required PR check, that false green can be followed by a red CI. The script was
renamed in BST-852 so the collision cannot be typed by accident, and
`scripts/__tests__/pnpm-shadowed-builtin-contract.test.mjs` fails if any package
reintroduces a shadowed script name or any doc reinstates the bare shorthand.
The shadow set is empirical, not read from `pnpm help -a` — that listing omits
`doctor` (hidden yet shadowing) and lists `clean` (visible yet harmless).

Two react-doctor CLI constraints worth knowing before you script around it:

- It takes a **directory only**. A file path fails with `not a directory`, so
  per-file checks are not possible.
- It takes **exactly one** positional argument (`too many arguments. Expected 1
  argument but got 3`), so covering several changed paths means several
  invocations — do not pass a changed-file list.

---

### Delegated workspace smoke coverage

The required delegated desktop smoke lane (`test:e2e:lane:smoke-delegated`,
BST-1762) includes `delegated-workspace-reload.desktop.test.ts` and its `@smoke`
case. It restores two native child histories through the real workspace
coordinator, switches by keyboard, closes a sibling tab, and verifies that
inspection neither executes inference nor advertises unsupported edit/regenerate
actions. Its screenshot uses disabled finite animations for stable evidence. The
case measured 4.2s locally (not the complete lane). On head bf8d50b, required
Desktop E2E job 103119913725 completed in 6m19s including setup and this new
smoke case. This is an observed total, not a measured before/after lane delta.
The existing lane deadline and zero-retry policy remain unchanged.
