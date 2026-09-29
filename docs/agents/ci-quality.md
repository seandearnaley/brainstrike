# CI & Quality Gates: PR Flow, React Doctor

> Read before changing workflows, `doctor.config.ts`, or knip config. Rules
> here are true now; the record behind each is in `ci-quality/<topic>.md`.

## PR CI FLOW

- CI is plain GitHub Actions: no planner, no committed proof artifact, no
  command registry, no routing label. The `coverage` label only adds an
  advisory run (see "Coverage is a separate workflow").
- Required PR checks are `test.yml`'s `Static`, `Unit`, `Build`, `Web E2E`,
  `Desktop E2E`. Both E2E smokes run on every PR; full regression runs on
  `schedule` or `workflow_dispatch`. `main` pushes: "A red `main` announces itself".
- A pull request touching official MCP conformance must link its workflow-dispatch run URL
  in its body; a self-reported pass count is no substitute (reviewer-enforced).

### Review and CI budget

- Before implementing, record start time, acceptance criteria, the actual PR
  base chain, and required checks; search open and recent PRs for the same fix.
- Review is complete when every finding has a disposition. Collect the whole
  review for one head, classify it, fix the in-scope batch, run local checks,
  push once. Do not push each comment separately. Adjacent work becomes a
  tracked follow-up, never new acceptance criteria.
- Allow an initial whole-PR review and one re-review after the batch; a third
  needs a scope checkpoint and user approval. Prefer a targeted review of the fix.
- At 45 minutes, report elapsed time, exact head, blockers, and the next stop.
  At 90 minutes without an exact-head-ready PR layer, stop pushes, reviews,
  reruns, and merges; present a recovery plan. A stack shares one budget.
- Keep one CI watcher. Reuse green evidence for the same head/base; rerun a
  failed job only for an identified infrastructure failure; a code fix needs a
  new head. Do not close/reopen PRs, toggle draft, or push empty commits to
  solicit review. Why: each can start a complete pipeline.
- Read the live ruleset. Declare the required gate ready without waiting for
  advisory Coverage; inspect individual Unit rows while the fan-in is pending.
- Batch lower-layer fixes before rebasing descendants once. Refresh a stack only
  for a real conflict, required up-to-date protection, or a relevant base change.

These rules hold without the external `pr-scope-guard` skill.
Guard: `scripts/__tests__/engineering-skills-contract.test.mjs`.

### Browser failure traces

- Browser-project traces are configured only through
  `browser.trace: { mode, tracesDir }`: off locally, `retain-on-failure` in CI.
  Why: Vitest ignores `test.outputDir` for traces and would leave them outside
  the uploaded `test-results/`. Failure screenshots use their own attachment path.
- Browser artifact uploads set `include-hidden-files: true` and name the resolved
  attachment directories for all six browser packages. Why: captures land under
  `.vitest/`, a dot-directory `actions/upload-artifact` skips silently — the step
  goes green and the artifact is empty.

Guard: `packages/config/__tests__/vitest-browser.test.ts`.

### Workload boundaries

- Unit partitions are `test.yml`'s `unit-shard` matrix: DB, Agent, and Desktop
  own native Vitest shards, one fork and no file parallelism per runner. A
  `*_TEST_SHARD_REQUIRED` run fails on a missing shard identity; unset locally,
  the whole suite runs. Required `Unit` rejects any failed or missing shard.
- Job and `--global-timeout` values are failure ceilings; aim for a PR verdict
  in 15 minutes. Judge a ceiling as a ratio to measured runtime and raise or
  split the lane when you add work. An `interrupted` test plus a missing
  `.playwright-artifacts` zip means the ceiling was hit: check run total first.
- Required `Desktop E2E` fans in `test:e2e:lane:smoke` and
  `test:e2e:lane:smoke-delegated`. Add a smoke spec to the lane with measured
  headroom and append the measurement to the evidence file.
- PR Turbo steps pin `TURBO_SCM_BASE`/`TURBO_SCM_HEAD` to exact SHAs. Declare a
  cross-package contract read (docs included) in the consuming package's task
  inputs, never global inputs.
- Test omits `ready_for_review`: marking a draft ready reruns nothing.
- A Radix menu or popover fixture finishes close and trigger focus in its own `afterEach`;
  never suppress the unhandled error, stub Event, sleep, or drop timers.

Settled: delegated smoke specs stay in the PR gate, not nightly. Evidence:
`ci-quality/workload-boundaries.md`, `ci-quality/e2e-lane-timeout-budgets.md`.
Guard: `scripts/__tests__/unit-shard-partition.test.mjs`,
`scripts/__tests__/ci-input-locality.test.mjs`,
`scripts/__tests__/ai-tools-e2e-pr-gate-contract.test.mjs`.

### MCP verifier lanes

- Required `Static` and local `pnpm check` both run the representative profile,
  with no `continue-on-error`, event predicate, or second selection planner:
  `pnpm run verify:mcp -- --profile pr --output artifacts/pr-evidence.json`.
- `mcp-verification.yml` runs the exhaustive profile on `schedule` and
  `workflow_dispatch` only; its `push` trigger serves the official jobs:
  `pnpm run verify:mcp -- --profile exhaustive --output artifacts/exhaustive-evidence.json`.
- `scripts/run-mcp-verification.mjs` is an identity guard, not a planner. Proof
  uploads only after a complete run on a clean checkout at `GITHUB_SHA`. It takes
  exactly one `--profile` from a closed set and one `--output` JSON path below
  `artifacts/`; unknown, duplicate, or shell-sensitive input fails before any
  platform-specific spawn.
- Both profiles emit evidence-schema `1.1.0` with desktop applicability
  `protocol-lab-only`; desktop-required proof is `mcp-conformance.md`'s gate.
- The three official conformance jobs below run on `main` pushes (docs-only
  ignored), nightly, and on dispatch, serialized and never cancelled. They are
  required post-merge gates: no `continue-on-error`, `--expected-failures`, or
  `--output-dir`. Only sanitized evidence uploads, on green and red: ANSI
  stripped, URL queries, OAuth parameters and structured secret assignments
  redacted, and captured child output never written into the evidence file. That
  redaction is why these artifacts can be published at all.
- When one goes red, fix forward or revert before the next MCP-touching merge
  and attach the run URL to that merge's ticket. `notify-main-failure` does not
  cover this workflow: whoever merges checks the run on their own commit.

```bash
pnpm run verify:mcp:official
pnpm run verify:mcp:official -- --profile core
pnpm run verify:mcp:official -- --profile modern-closeout
```

Settled: official jobs gate post-merge on `main`, not in the PR lane; change a
timeout only with its budget arithmetic. Evidence: `ci-quality/mcp-verifier-lanes.md`.
Guard: `scripts/__tests__/mcp-verification-ci-contract.test.mjs`,
`scripts/__tests__/run-mcp-verification.test.mjs`.

#### MCP 2026 fleet working agreements (BST-1590)

This heading keeps its identifier because
`scripts/__tests__/mcp-verification-ci-contract.test.mjs` pins it verbatim; every
other heading drops the suffix.

The WIP limit, ladder freeze, and daily status update lapsed when
[BST-1472](https://linear.app/brainstrike/issue/BST-1472) closed (Done,
2026-09-02). Standing for MCP work: dedupe against open and last-24-hour merged PRs
before branching; evidence is an exact-head CI artifact URL in the PR body and
on the ticket; a host-only deliverable says "host-only, product surface
pending" and does not close as Done; PRs only; conformance prose lives in
`docs/agents/mcp-conformance.md`, not `assistant-providers.md`.
Evidence: `ci-quality/mcp-verifier-lanes.md`.

### Open PR to Linear conformance

- Every human-authored PR description carries a `BST-###` reference (identifier
  or Linear URL); a title-only reference is insufficient. Only Dependabot and
  Renovate are exempt. `.github/PULL_REQUEST_TEMPLATE.md` prompts for it.
- `pnpm check:pr-linear` audits open PRs read-only. It is advisory: findings
  exit 0, while GitHub/API failures and malformed responses fail visibly.

Guard: `scripts/__tests__/check-open-pr-linear-conformance.test.mjs`.

### Desktop Electron provisioning

- `pnpm install` never provisions Electron. Each job that launches it downloads
  the release zip to `${RUNNER_TEMP:-/tmp}/electron.zip` right before use, with no
  Actions cache; `Native Electron Package` hands that same verified zip to
  electron-builder via `--config.electronDist`.
- That job packages once (`VITE_MCP_TASK_HARNESS=1`, never set for release), then
  runs `test:e2e:lane:packaged-mcp-apps-bridge`, `test:e2e:lane:packaged-mcp-tasks`,
  `test:e2e:lane:packaged-mcp-apps`, the packaged native checks, then
  `test:e2e:lane:packaged-mcp-core`. Lanes never build or package. Their specs
  carry `@packaged @destructive`, full-regression grep-inverts `@packaged`, and
  the launcher forwards an explicit env allowlist, never ambient CI env. The
  harness injects into the REAL main window (production preload, default session,
  production header CSP) — never a private-partition harness window.
- A proof's diagnostic branch reads text and never clicks; both racers of its
  `Promise.race` are `.catch`-handled. Do not widen the core lane to hide
  skip-on-failure MCP discovery.
- Memory specs launch with `--enable-precise-memory-info` **and**
  `--js-flags=--expose-gc`, and read working set from `app.getAppMetrics()`; a
  missing PID metric fails. Changing a fixture, window, ceiling, or memory source
  needs three same-head samples in evidence; collect them with `desktop-e2e.yml`'s
  `memory-baseline` dispatch suite. That suite is evidence collection only — it
  never replaces or routes a required PR check.
- AI Tools settings specs stay in both required PR smoke lanes and in nightly.
- E2E collection selection waits for the named picker or loaded single-set label, never unrelated text or pending rows.

Evidence: `ci-quality/desktop-electron-provisioning.md`,
`ci-quality/packaged-mcp-lanes.md`, `ci-quality/desktop-memory-calibration.md`,
`ci-quality/ai-tools-smoke-lanes.md`, `ci-quality/electron-collection-readiness.md`.
Guard: `scripts/__tests__/desktop-electron-provisioning-contract.test.mjs`,
`e2e-lane-coverage.test.mjs`, `mcp-*-packaged-ci-contract.test.mjs`,
`ai-tools-e2e-pr-gate-contract.test.mjs`; `desktop-e2e-harness-contract.test.ts`, `search-collection-picker.test.tsx`.

### Every Linux apt site drops the unused Google Chrome source first

- Put `uses: ./.github/actions/apt-drop-unused-sources` ahead of every step that
  reaches apt, `playwright install-deps` included. Never relax apt's exit status
  instead. Why: that also swallows a real Ubuntu-archive failure.
- A green rerun proves nothing; reproduce per `ci-quality/apt-source-guard.md`.

Guard: `scripts/__tests__/apt-source-guard-contract.test.mjs`.

### Development startup ordering

- Root `pnpm dev`: `predev` prepares the app dependency graph synchronously, then
  the `dev` wrapper marks the Turbo graph `BRAINSTRIKE_DEV_DEPS_PREPARED=1`.
  Web/desktop `predev` skip only when `TURBO_HASH` and that marker are both set;
  bare `turbo run dev` fails closed; package-level `pnpm dev` prepares itself.
- Never order startup with sleeps, polling, or `dist` existence sentinels.

Guard: `scripts/__tests__/run-turbo-command.test.mjs`.

### The package-boundary gate

- `Static` runs `pnpm run boundaries` (`scripts/turbo-boundaries.mjs`): real
  `turbo boundaries`, judged only on files git does not ignore; any finding it
  cannot pin to a git-ignored file fails. Keep it ahead of `dist/`-producing steps.
- Deliberate crossings carry `// @boundaries-ignore <reason>` at the import.
  `architecture-domain-boundaries.mjs` owns cross-domain direction rules.
- Do not upgrade Turbo to >=2.11.3 until vendor walking judges tracked files
  under ignore patterns; recheck the real tracked-source guard before upgrading.

Settled: git decides what is generated. Evidence: `ci-quality/package-boundary-gate.md`.
Guard: `scripts/__tests__/turbo-boundaries-gate.test.mjs`.

### App test-tsconfig programs (`tsconfig.test.json`)

- Both apps type-check tests through `tsconfig.test.json` with `"paths": {}`, so
  deps resolve to built `dist`: build first. `type-check:main` passing does not
  imply the test program passes on the same `src` file.
- Desktop `type-check:test` runs `scripts/verify-test-tsconfig-program.mjs` with a
  400-test-root floor; keep it in `apps/desktop/turbo.json` inputs.
- Desktop sets `declaration: false`/`declarationMap: false` and excludes
  `src/types/pglite*.d.ts`; web sets `noEmit: true` and inherits `declaration`
  from the base config. They are not symmetrical — do not "align" them.

Evidence: `ci-quality/test-tsconfig-programs.md`.
Guard: `scripts/__tests__/verify-test-tsconfig-program.test.mjs`.

### Vercel Preview is advisory

- `Vercel` is outside the required checks (ruleset `4797672`). When red, read the
  status: provider capacity stays red and unpushed, and the PR merges on clean
  exact-head required checks; a real build or deploy failure blocks.
- Never claim Preview QA happened without a deployment.

Evidence: `ci-quality/vercel-preview-advisory.md`.

### Deterministic agent-behavior evals

- `packages/agent/src/__tests__/agent-behavior-eval.spec.ts` is a zero-network
  unit-lane gate: every deterministic gate averages exactly `1.0`, Mastra `failed`
  fails Vitest, and a misbehaving control proves each gate bites. `scored` is
  advisory; real-provider evals belong in a `*.integration.spec.ts` lane.

### Quiet-head admission before PR fan-out

- Every `pull_request` run of `test.yml` waits in `admission`, then releases the
  full job graph only if the PR head still equals the run's SHA. A superseded
  head succeeds with `admitted=false`; push and dispatch are admitted at once.
  Admission only delays: the latest quiet head always runs the complete graph.
- Admission fails closed when currency cannot be established, and each gated job
  keeps `always()` plus its first-step `Require successful admission` failure.
  Why: a skipped required check satisfies branch protection.
- Vitest generated failure captures stay in ignored
  `.vitest/attachments/failure-screenshots`;
  intentional `toMatchScreenshot` references resolve to tracked
  `__image_snapshots__` via `@brainstrike/config`.
  The Browser tests upload names the capture directory of every `--filter` package.

Evidence: `ci-quality/quiet-head-admission.md`.
Guard: `scripts/__tests__/quiet-head-admission-contract.test.mjs`,
`vitest-browser-screenshot-ignore-contract.test.mjs`.

### A red `main` announces itself

- On a `push`, `notify-main-failure` opens or comments on the one open
  `main-broken` issue when Static, Unit, or Build fails. For a red Lint or Type
  check, first look for a toolchain bump merged after the PR's last green run.

Evidence: `ci-quality/main-failure-notifier.md`.
Guard: `scripts/__tests__/main-failure-notifier-contract.test.mjs`.

#### The scope line is required-check status, not "important lanes"

- Watch required checks minus the two flaky E2E lanes (their scheduled notifiers
  cover them). `Browser tests`, `Native Windows`, and `Native Electron Package`
  are not required; a job promoted into the ruleset joins `needs:` in that change.

#### `== 'failure'` is necessary but NOT sufficient — `!cancelled()` is what makes cancelled runs silent

- Keep `if: !cancelled()` on both notifier jobs, never `always()`. Why: the
  admission first-step and the `unit` fan-in turn a cancelled run into `failure`.
  Leave `unit`'s `!= 'success'` check alone and do not gate on admission success.

#### Green `main` closes the issue

- `notify-main-recovery` closes every open `main-broken` issue on the next
  all-green push, so each incident gets its own issue. `main` pushes are
  serialized (`cancel-in-progress: false`), so it cannot race the notifier.

#### Prevention is out of scope

Detection only; requiring up-to-date branches is the repo owner's ruleset call.

#### Constraints any change must preserve

- Both jobs add no trigger to `test.yml`, are not required checks, run on
  `ubuntu-latest`, and keep their `gh` steps in `check-ci-parity.test.mjs`'s
  `PROVISIONING_STEPS` so `pnpm check` never files or closes issues.
- Every tracking notifier's label step is `gh label create --force` with no
  `|| true`, failing before an unlabelled issue can be created. The scheduled
  web, desktop, coverage, and performance notifiers stay human-closed.
  Guard: `scripts/__tests__/nightly-notifier-label-contract.test.mjs`.

### Biome 2.5.8 cleared the 2.5.3/2.5.4 module-graph hold

- No release hold is active. Pin `@biomejs/biome` to one exact version in root
  and `apps/web` together, and on every bump require a full
  `pnpm exec biome check .` with zero panic output.
- When a bump pushes a file past `noExcessiveLinesPerFile`, shrink the file.
  Never bulk-remove `noDelete` suppressions: only `delete process.env[...]` is
  exempt.

Evidence: `ci-quality/biome-module-graph-hold.md`.

### Static runs on arm64; the Unit fan-in runs on slim

- `static` runs on `ubuntu-24.04-arm` (cheaper per minute, not faster); the
  `unit` fan-in runs on `ubuntu-slim`; `native-windows` runs on
  `windows-latest` for every admitted head.

Evidence: `ci-quality/static-unit-runners.md`.
Guard: `scripts/__tests__/ubicloud-runner-contract.test.mjs`.

### Performance lane (performance.yml) — calibrated budgets only

- The lane gates on the budget assertions in `apps/web/e2e/performance/*.test.ts`
  and runs without `--max-failures`, so it reports its full breach surface.
- A metric gets a `GITHUB_ACTIONS_MINIMUMS` floor in
  `apps/web/e2e/utils/performance-config.ts` on its first CI breach, provenance
  in the adjacent comment: dispatch `performance.yml` several times on one SHA,
  one run at a time; floor = observed worst × ~1.5. Local numbers never set a
  CI budget. A breach of a calibrated budget is a regression ticket, not a bump.
- Interaction helpers sample entirely inside the page and fail on a detached
  element; only `measureNamedCheckboxInteractionFrame` re-resolves its checkbox.
- The worker-memory ceiling is structural (half the smallest model store), not a
  calibrated floor. Web unit coverage excludes exactly the memory page probe and
  its wrapper worker; keep that list exact.

Evidence: `ci-quality/performance-lane.md`.
Guard: `apps/web/e2e/utils/__tests__/performance-benchmark-contract.vitest.ts`.

### Claude review coverage and orchestration

- Automatic review runs on `pull_request` `opened`, `ready_for_review`, and
  `reopened`. A push never triggers it, so any later push voids that head's
  coverage. Drafts are reviewed at `ready_for_review`.
- Request coverage for a new head, or for a PR that changes the reviewer itself
  (self-change is **skipped**), with the trusted default-branch dispatch:

  ```bash
  gh workflow run claude-code-review.yml --repo seandearnaley/brainstrike --ref main \
    -f pr_number=123 -f expected_head=<40-character-current-head> \
    -f 'focus=<the boundary or prior findings to verify>'
  ```

- Budget per PR: one automatic review plus one targeted dispatch after the fix
  batch; Codex likewise gets one automatic review plus at most one
  `@codex review`. A third whole-PR round needs user approval.
- Request review only through that dispatch. Leave the PR's open/draft state,
  its commits, and the Test pipeline alone.
- Coverage means a **Completed** disposition at the exact head with real review
  text. **Skipped** and **Incomplete** are red and are not coverage; a missing
  disposition is not completion. Completed is coverage, not approval — read and
  close its findings.
- A diff over 512 KiB is refused as Incomplete. Split the PR; no narrower diff
  or partial review is ever substituted. `pnpm-lock.yaml` hunks are replaced by
  a derived summary, and the published disposition says so.
- The job runs the pinned CLI, whose catalog must list the model id, with every
  tool removed except `StructuredOutput`; prompt, diff, and body go on stdin.
  After changing tool args, model, or CLI pin, update and run
  `node scripts/probe-claude-review-tools.mjs /absolute/path/to/claude`.
- Under `pull_request` this workflow and `scripts/claude-review.mjs` execute from
  the PR's merge commit — PR-author code — with `CLAUDE_CODE_OAUTH_TOKEN` and a
  `pull-requests: write` token in scope. That exposure is accepted because every
  PR is the owner's or their agents'; read workflow diffs before merging. If it
  stops holding, rotate the token or put the step behind a protected
  `environment:`. The `--ref main` dispatch is the trusted path for a PR that
  touches the reviewer itself.
- The CLI runs under an 80-turn ceiling, and failure diagnostics are bounded:
  500 characters per field, 4 KiB per assembled reason, and raw JSON above
  64 KiB is not parsed.
- On failure, grep the job log for `CLAUDE_REVIEW_CLI_FAILED:` or
  `CLAUDE_REVIEW_PUBLICATION_FAILED:`.

Settled: the `pull_request` trigger (not `pull_request_target`), the direct CLI
(not `anthropics/claude-code-action`), stdin delivery, the raw UUID-fenced diff
(not JSON-encoded), and the empty tool set (not `allowedTools`). Evidence:
`ci-quality/claude-review.md`.
Guard: `scripts/__tests__/claude-review.test.mjs`,
`scripts/__tests__/claude-auto-review-contract.test.mjs`.

### Cost-ranked Linux x64 jobs run on Ubicloud

- Each job's runner label is fixed in its workflow and pinned by the guard.
  Rollback is reverting the label; a provisioning failure queues or fails
  visibly. Add no provider-selection layer, GitHub fallback, or per-shard
  routing, and no changed-path gate for always-on `native-windows`.
- Unit shard variables reach only their owning package's Turbo tasks via its
  `turbo.json` `env`, never Turbo CLI passthrough
  (`scripts/unit-shard-partition.mjs`). Static caps type-check with
  `TURBO_CONCURRENCY=4` on the CI invocation only (`quiet-head-admission-contract`).
- Turbo's remote cache is arch-blind: a green arm64 run mostly replays x64
  entries. Every node-gyp package sets `cache: false` on its build and test
  tasks (`native-addon-build-uncached-contract`).
- `native-windows` caches node-gyp's header dir (an input, not an output) and
  retries a cold install (`install-attempts: '3'`). Each part below silently
  un-does the fix on its own: the job pins `npm_config_devdir` (node-gyp's
  default lives under `%LOCALAPPDATA%` and no cache step can name it portably);
  the restore runs **before** `Setup workspace`, because the download happens
  inside that composite's `pnpm install`; and the save is guarded on
  `steps.setup.outcome == 'success'`. `TAR_ENTRY_ERROR ENOENT` there is noise
  from an aborted header download (`native-windows-node-gyp-cache-contract`,
  `setup-workspace-install-retry-contract`).

Evidence: `ci-quality/ubicloud-runners.md`,
`ci-quality/native-windows-node-gyp-cache.md`.
Guard: `scripts/__tests__/ubicloud-runner-contract.test.mjs` plus the
parenthesised `scripts/__tests__/<name>.test.mjs` contracts above.

### Coverage is a separate workflow (`.github/workflows/coverage.yml`)

- PR coverage is advisory: once per non-draft PR lifecycle or on a `coverage`
  label add, never on `synchronize`. The only threshold gate is
  `nightly-coverage.yml` → `pnpm coverage:enforce`.
- Keep it out of `test.yml` (a `labeled` subscription there repaints the five
  required checks as `skipping`) and keep `cancel-in-progress: false` (any
  label's no-op run would cancel a live one).
- DB blob output, cleanup, counting and upload/download paths all use
  `packages/db/.vitest/blob`; keep the two-blob assertion and
  `include-hidden-files: true` on those uploads.
- DB coverage runs alone as the same native `1/2` + `2/2` shard set as Unit and
  nightly, merged with `--merge-reports=.vitest/blob`; other packages stay
  concurrent with DB excluded. Isolate only DB.
- Nightly coverage is six static shards (the sixth a negative-filter
  remainder), two DB shards, and a DB merge; the final job fails closed unless
  all seven archives arrive. Add no generated planner or larger shared timeout.
- Only scripts invoking `--coverage` owe a JSON artifact; a native package's
  `test:coverage` may run uninstrumented.

Evidence: `ci-quality/coverage-workflow.md`.
Guard: `scripts/__tests__/nightly-coverage-sharding-contract.test.mjs`.

#### The embeddings integration lane is serialized

- `packages/embeddings` `test:integration` keeps
  `--maxWorkers=1 --no-file-parallelism` on `pool: 'forks'`. Why: memory, not
  CPU. Before removing the flags, re-measure peak RSS against the runner's
  16 GB with the `test.yml` `--concurrency=2` co-lane held constant.

Evidence: `ci-quality/embeddings-integration-serialized.md`.

#### A worker with a blocked event loop is killed and named

- Every real-PGlite lane lists
  `@brainstrike/test-utils/vitest.event-loop-watchdog.setup` FIRST in its
  effective `setupFiles` (its heartbeat must capture a real timer). Add a new
  lane to `PGLITE_LANES` in the guard.
- After 60 s of silence the watchdog names the test on stderr and SIGKILLs the
  worker; the lane fails. In a `threads` lane that stderr line is the only
  attribution. It stays off under `--inspect*`.

Evidence: `ci-quality/event-loop-watchdog.md`, `ci-quality/settings-pglite-integration.md`.
Guard: `scripts/verify-event-loop-watchdog.mjs`.

#### A test file with no verdict fails the lane

- Every `vitest.config.mts` outside the `tooling` domain registers
  `LostTestFileReporter`, and a script passing `--reporter=` to vitest names
  `@brainstrike/test-utils/vitest-lost-file-reporter` too. Why: vitest reports
  a run that lost a file as passed.
- Required Unit steps run through `scripts/run-test-command.mjs`, which emits
  `BRAINSTRIKE_CI_VERDICT=V8_WASM_JIT_TEARDOWN_FATAL` only on the complete
  three-marker signature.
- A lost file or that verdict is a runtime defect to investigate. Fewer
  workers, lighter fixtures, a skip, or a passing rerun do not resolve it.
- The toolchain is the exact Node in `.nvmrc` (`devEngines.runtime`, React
  Doctor's `node-version`, any composite action running npm). Qualify a new pin
  on Linux x64 first. Shipped code stays on the Node 24 API floor.
- Tests creating `memory://` PGlite close the returned handle themselves.

Evidence: `ci-quality/lost-test-file-reporter.md`, `ci-quality/v8-wasm-fatal-symbolization.md`.
Guard: `scripts/verify-lost-file-reporter.mjs`, and in `scripts/__tests__/`
`run-test-command.test.mjs` and `types-node-runtime-alignment.test.mjs`.

#### Codecov statuses are non-gating

- The ruleset requires exactly `Static`, `Unit`, `Build`, `Web E2E`,
  `Desktop E2E`. `codecov.yml` keeps `project: off` and patch
  `informational: true`, in exactly one Codecov config file.
- Re-gating is a two-part change: complete PR uploads AND the context added to
  the ruleset.
- The guard runs in required Static: it never passes vacuously and never fails
  a valid config.

Settled: patch coverage does not gate. Evidence: `ci-quality/codecov-non-gating.md`.
Guard: `scripts/verify-codecov-status-contract.mjs`.

### Assistant stop/retry verifier

- `apps/web/e2e/assistant-panel-interactions.test.ts` injects a controlled
  `LocalLlmBackend` (webdriver only), asserts `window.llmHost` is absent, and
  needs no provider key, model download, sleep, retry, or skip.
- Before weakening it, falsify it: disconnect the adapter's AbortSignal from
  backend generation, see it fail, restore, see it pass. UI visibility alone
  is not evidence of cancellation.

Evidence: `ci-quality/assistant-stop-retry-verifier.md`.

### `pnpm check` is a mirror of test.yml, not a second CI definition

- `scripts/check.mjs` conforms to `test.yml`: every `run:` step there is a mapped
  plan step, a reasoned `CI_GATES_NOT_RUN_LOCALLY` entry, or declared runner
  plumbing. Unit lanes are unfiltered `turbo run test` then `test:integration`;
  lint is read-only (`--fix-lint` writes); install is `--frozen-lockfile`.
- `CI=true` wraps the Playwright lanes only. Why: on unit lanes it changes the
  workload (coverage thresholds, worker counts), not just the environment.
- Vitest timeout parity is `TEST_TIMEOUT_MULTIPLIER=2`, set explicitly by CI, the
  root Vitest scripts, and `pnpm check`, and declared in Turbo task `env`.
- Every lane calling `waitFor`/`findBy*` loads a timeout setup: shared
  `vitest.setup`, `@brainstrike/test-utils/vitest.timeouts.setup`, or
  `createBrowserProject`'s required `asyncUtilTimeout` and `setupFiles`.

Settled: the parity test compares invoked commands, not step names or verbatim
`run:` blocks. Evidence: `ci-quality/pnpm-check-parity.md`,
`ci-quality/test-timeout-multiplier.md`.
Guard: `scripts/__tests__/check-ci-parity.test.mjs`,
`packages/config/__tests__/vitest-browser.test.ts`.

### Guard-script entrypoint contract

- Every `scripts/verify-*.mjs` runs its check when executed directly and exports
  `main({ repoRoot })`; artifact guards take a bundle `directory` instead.
- Thread `repoRoot` into the check, give the CLI the same verdict as the paired
  test, and fail on an empty tree.

Evidence: `ci-quality/guard-script-entrypoints.md`.
Guard: `scripts/__tests__/verify-script-entrypoints.test.mjs`.

### Desktop assistant setup promise ownership

- `setupAssistantMock` owns the pending credential write: `evaluateHandle`
  returns the write promise and its tagged completion, rejection is observed in
  the same renderer turn as `saveKey`, and the handle is disposed in `finally`.
- Desktop Playwright artifacts live in `apps/desktop/blob-report/`; every
  desktop uploader targets it.

Settled: no retries, global promise pin, or timeout increase. Evidence:
`ci-quality/desktop-assistant-setup-promise.md`.
Guard: `apps/desktop/e2e/assistant-panel.desktop.test.ts`,
`scripts/__tests__/desktop-smoke-artifacts-contract.test.mjs`.

### Desktop E2E process-exit guard

- Every `ElectronHarness` process is registered with `ElectronProcessExitGuard`;
  an exit before intentional close fails the owning test, passed body or not.
- Close a harness-owned app only through the harness; state-seeding tests call
  `closeForStateSeeding()`. `signal=SIGKILL` plus an `_object` `TypeError` on
  the next `restart()` means an out-of-band close, not a crash.
- `runInteractiveChildFixture` keeps the scenario failure beside teardown
  failures, requires exit code zero, and removes the workspace only after
  confirmed exit.

Settled: no warn-and-relaunch. Evidence:
`ci-quality/desktop-e2e-process-exit-guard.md`.
Guard: `apps/desktop/src/__tests__/electron-process-exit-guard.test.ts`,
`electron-harness-state-seeding.test.ts`, `interactive-child-fixture.test.ts`.

### E2E module-format contract

- Both Playwright graphs are ESM: `apps/{web,desktop}/e2e/package.json` declare
  `"type": "module"` and both configs are `playwright.config.mts`.
- A runtime import that leaves an e2e root lands in the app's CommonJS manifest;
  its static graph holds no bare dependency, `export *`, or `import.meta`.

Evidence: `ci-quality/e2e-module-format.md`.
Guard: `scripts/__tests__/e2e-module-format-contract.test.mjs`.

### E2E lane-coverage contract

- Every Playwright test title in `apps/web` and `apps/desktop` is selected by a
  lane CI invokes; every `@web-*`/`@desktop-*` tag routes a title. Give a dark
  `@stateful` spec its own serialized lane.
- Inline workflow lanes count only from `LANE_WORKFLOW_FILES`; keep it explicit.
  Why: a whole-suite dispatch workflow would make the sweep vacuous.
- Web full-regression runs through `scripts/run-e2e-lane-sequence.mjs`
  (fail-late); `web-e2e.yml`'s timeout covers every lane timeout plus startup.

Settled: reachability is per title, with exact Playwright grep semantics.
Evidence: `ci-quality/e2e-lane-coverage.md`.
Guard: `scripts/__tests__/e2e-lane-coverage.test.mjs`,
`scripts/__tests__/run-e2e-lane-sequence.test.mjs`.

### Delegated workspace smoke coverage

- Required `test:e2e:lane:smoke-delegated` runs both
  `delegated-workspace-reload.desktop.test.ts` and
  `parent-approval-with-parked-workers.desktop.test.ts` (`@smoke`): child reload
  and live root/Worker read/edit grants and writes. Deadline/zero retries stand.

Evidence: `ci-quality/delegated-workspace-smoke.md`.

### Vitest 5 migration

- `clearMocks: true` stays: tests build their own call history, and
  module-initialization assertions import fresh after `vi.resetModules()`.
- DOM projects include `@brainstrike/test-utils/vitest-matchers`. Await async
  assertions and bench `.run()`; serialize with `{ concurrent: false }`.
- Package configs inherit nothing from the root aggregator; inline projects
  merge arrays, so list setup files deliberately. Stryker stays 10.0.0.
- Generated output lives under ignored `.vitest/`; visual baselines stay tracked
  in `__image_snapshots__`.

Evidence: `ci-quality/vitest-5-migration.md`.

### The `__vitest_worker__` mutation guard

- Test files under `packages/` and `apps/` never delete, assign, or stub
  `__vitest_worker__`; mock a detection seam
  (`packages/file-explorer/src/persistence/test-environment.ts`) instead.
- The `@stryker-mutator/vitest-runner@10.0.0` pnpm patch carries an unreleased
  upstream fix; remove it on a fixed release, after re-running mutation lanes.

Settled: no `@vitest/runner` teardown patch. Evidence:
`ci-quality/vitest-worker-mutation-guard.md`.
Guard: `scripts/__tests__/vitest-worker-global-mutation.test.mjs`,
`scripts/__tests__/stryker-vitest-5-compatibility.test.mjs`.

### Workspace-src alias guard (`pnpm test:scripts`)

- Every Vitest config in `packages/*` and `apps/*` resolves runtime
  `@brainstrike/*` imports to source: spread `workspaceSrcAliases()` from
  `@brainstrike/test-utils/workspace-src-aliases`, config-local entries first
  (first match wins). Agent, `workers`, and prebuilt `*.worker` exports get no
  registry alias; alias them locally.
- Name configs `vitest.*config*.*`. A real built-artifact consumer goes in
  `WORKSPACE_SRC_ALIAS_ALLOWLIST` with a reason.
- Test tasks depend on `topo`, the no-op transit node carrying upstream source
  hashes. Keep that edge. Why: deleting it replays stale-green dependents.
- A test that loads a built artifact declares an explicit `#build` edge in its
  package `turbo.json`; no inline `pnpm build &&`, no `^build`. Native-addon
  packages keep `build`, `test`, and `test:coverage` uncached; outside Turbo,
  build them before testing.
- Narrow task inputs only as a guarded pilot. `@brainstrike/types` excludes its
  test/spec files from `topo` and `build`, so nothing outside it may import,
  read, or glob them. Shared helpers live outside excluded paths.
- A guard script is an input of the tasks that run it, never a global input.
  Coverage enforcement runs outside Turbo.
- File-node factories live in `@brainstrike/file-tree-test-fixtures`;
  `@brainstrike/test-utils` never depends on `@brainstrike/types`.
- Desktop main-process tests use `apps/desktop/src/__tests__/helpers/electron-main-test-harness.ts` and
  reset it in `beforeEach`; Electron defaults go in `electron-test-stub.mts`.

Evidence: `ci-quality/workspace-src-alias-guard.md`.
Guard: `scripts/__tests__/` `verify-workspace-src-aliases`,
`turbo-global-configuration`, `native-addon-build-uncached-contract`,
`private-test-input-locality`, `ci-guard-input-locality` (`.test.mjs`).

### Mutation-lane contract guard (`pnpm test:scripts`)

- A `mutation` script is `stryker run [args]` in a package that declares
  `@stryker-mutator/core`, with exactly one loadable Stryker config whose
  `vitest.configFile` is an existing `vitest.mutation.config.ts`.
- `reporters` stays within the guard's `SUPPORTED_REPORTERS`; widening it is a
  reviewed decision.

Evidence: `ci-quality/mutation-lane-guard.md`.
Guard: `scripts/__tests__/verify-stryker-mutation-contracts.test.mjs`.

### TypeScript 7 CLI with the TypeScript 6 compatibility API

- `tsc` is TypeScript 7 (`@typescript/native`). Importing `typescript` gives
  the TypeScript 6 API (`@typescript/typescript6`, which owns `tsc6`, never
  `tsc`). `@typescript/old` is the concrete TypeScript 6 for the editor TSDK
  and desktop's LSP, shipped as an unpacked production dependency.
- Bumping any of the three pins requires a fresh
  `node scripts/ts7-parity-check.mjs` run and the wiring test's new baseline.
  Parity covers `--noEmit` only; verify `apps/web`'s emitting type-check in a
  clean worktree.

Settled: the side-by-side topology; two aliases of plain `typescript` make the
`tsc` bin ambiguous. Evidence: `ci-quality/typescript-side-by-side.md`, `ci-quality/lsp-webgpu-fixture.md`.
Guard: `scripts/__tests__/typescript-compiler-wiring.test.mjs`,
`apps/desktop/src/__tests__/build-main-config.test.ts`.

### Turbo 2.10 configuration audit and 3.0 preparation

- `turbo.jsonc` uses the Turbo 3.0 `global` block under
  `futureFlags.globalConfiguration`; `$schema` tracks the pinned `turbo`.
- `global.concurrency` stays `"40"`, the build/test calibration that CI's
  uncapped Build job and local `pnpm build`/`pnpm check` inherit. `pnpm dev`
  carries its own `--concurrency` above the workspace package count. Why: Turbo
  refuses to start when concurrency <= persistent tasks selected.
- Enable another future flag only with an adopted call site and a proving test.
  Share package config only through Turbo's native `extends`.

Settled: no config micro-package or registry; `turbo query affected` is not a
CI planner. Evidence: `ci-quality/turbo-configuration.md`.
Guard: `scripts/__tests__/turbo-global-configuration.test.mjs`,
`scripts/__tests__/tsconfig-global-deps-contract.test.mjs`.

### Root clean orchestration

- `pnpm clean` runs the uncached `clean` task through the Turbo wrapper; every
  package with a `build` script declares the canonical `clean`.
- Tests run Turbo's JS entrypoint via `process.execPath`, never `turbo.cmd`.

Guard: `scripts/__tests__/package-scripts-canonical-form-contract.test.mjs`.

### Worktree-scoped local Turbo caches

- The wrapper's local cache, nested-run lock, and 25-GiB prune are scoped per
  Git worktree root (`--cwd` decides which). `TURBO_CACHE_DIR` and
  `BRAINSTRIKE_TURBO_CACHE_DIR` are exact overrides, required outside a
  worktree. Removed worktrees' caches are yours to delete.
- Never describe the local cache as content-safe: same-size/same-mtime stale
  bytes remain possible within one worktree.

Settled: no shared HOME-level cache until Turbo's restore identity is content-
or checkout-aware. Evidence: `ci-quality/turbo-cache-and-dist-hygiene.md`.
Guard: `scripts/__tests__/run-turbo-command.test.mjs`.

### Stale-dist pruning before non-cleaning tsc builds

- Every build-chain script that runs an emitting `tsc` first cleans `dist` or
  runs `node <depth>/scripts/prune-stale-dist.mjs`. The pruner requires
  rootDir `src`, outDir `dist`, per-file emit; any other layout cleans.
- A pruned package with a tsup config pins `splitting: false`, and the pruner
  stays in `turbo.jsonc` `global.inputs`. A type-check never runs `tsc --build
  --force`: it rewrites dist that concurrent type-checks read (BST-1818).

Settled: prune, not clean, for wired packages. Evidence: `ci-quality/turbo-cache-and-dist-hygiene.md`.
Guard: `scripts/__tests__/prune-stale-dist.test.mjs`, `package-scripts-canonical-form-contract.test.mjs`.

### Canonical package build strategies

- Build class derives from `scripts.build`; keep no registry. A library builds
  with `node ../../scripts/prune-stale-dist.mjs && tsc -b` and carries no tsup.
  tsup is only for the eight real bundle boundaries (workers/WASM/assets, the
  hosted-web bundle, retained CJS); native addons build with `node-gyp`.
- A Node-loaded library extends `packages/config/tsconfig/node-library.json`
  and imports relatives as `.js`. A `require` export names a real CJS artifact;
  CJS consumers use dynamic `import()`. Browser-only libraries keep Bundler
  resolution under the same `tsc -b` build. Hosted functions load the agent's
  ESM export; pino and tiktoken stay external.

Settled: tsup stays until a replacement ships alone with measured evidence.
Evidence: `ci-quality/package-build-strategies.md`. Guard:
`scripts/verify-package-build-strategies.mjs`,
`packages/agent/scripts/verify-hosted-web-bundle.mjs`.

### Agent declaration build split

- `@brainstrike/agent` emits declarations with `tsc -b` before tsup bundles;
  agent tsup configs keep `dts: false`. `dev` pairs `tsc --project --watch`
  with `tsup --watch` under `--kill-others`. Why `--project`: build mode would
  emit into referenced packages' `dist` alongside their own watchers.

Guard: `scripts/__tests__/agent-declaration-build-contract.test.mjs`.

### tsup clean/dts invariants

- A package that runs `tsc -b` then tsup states literal `clean: false` and
  `dts: false`. The tsup-only set is exactly `chunking-worker`,
  `file-tree-worker`, `token-cache`; each MUST emit declarations.

Settled: no shared `createTsupConfig` factory; dynamic values are rejected.
Evidence: `ci-quality/tsup-build-invariants.md`. Guard:
`scripts/verify-tsup-build-invariants.mjs` and its test.

### App bundle chunk ceiling and tokenizer asset

- Both app builds warn at 1,300 kB per JavaScript chunk. Never raise it to fit
  tokenizer data: the `o200k_base` table is a `?url` asset fetched when an
  accurate-counting worker first initializes, never part of a JavaScript
  chunk, the module-preload closure, or the heuristic path.
- Keep `tokenizerAssetPlugin` plus `verify-tokenizer-asset-bundle.mjs` in both
  tokenizer worker builds, `preserveWorkerEntryPlugin` in both app worker
  builds, and Zod `jitless` ahead of the app import in `apps/web/src/entry.ts`.
- `createCspQualifiedEvalWarningFilter` silences `EVAL` only for version-pinned
  files qualified under the production CSP. Its PGlite pin trails the installed
  version, so PGlite warnings surface by design; re-qualify before bumping.

Evidence: `ci-quality/app-bundle-chunks.md`.
Guard: both apps' `vite-config.test.ts`, `packages/tokenization` and
`packages/build-utils` tests, `test:e2e:lane:production-csp`.

### Desktop development dependency freshness

- Desktop `predev` and `dev:agent-debug` run
  `scripts/ensure-desktop-dev-deps.mjs` synchronously; it skips only under the
  root-prepared marker. Turbo's hashes decide freshness, never a `dist`-exists
  check, and a non-zero Turbo exit fails startup.
- Agent-debug finishes that preflight before loading the Windows Job Object
  addon. Why: node-gyp cannot replace a loaded addon (`EPERM`).
- `fullReloadOnCompilerHotspots` invalidates every affected module and its
  importers before broadcasting `full-reload` and returning `[]`.

Evidence: `ci-quality/desktop-dev-freshness.md`. Guard (HMR):
`packages/build-utils/src/__tests__/vite.test.ts`.

### Agent-debug macOS automation identity

- On macOS the launcher runs a symlinked `Electron.app` shim in its disposable
  profile as `BrainStrike Agent Debug` / `com.brainstrike.desktop.agent-debug`.
  A bad bundle layout or plist aborts startup; `com.github.Electron` never runs.
- Re-enter pnpm through `process.execPath` plus the absolute
  `pnpm.cjs`/`.js`/`.mjs` in `npm_execpath`. Reject `pnpm.cmd` and keep the
  shell-based spawn helper out of this path.
- The launcher owns the `pnpm run dev:runtime` tree: a detached process group
  on POSIX; a non-breakaway kill-on-close Job Object on Windows, with no
  ancestry-walk fallback. Remove the profile only after the tree stops. Tree or
  profile cleanup failure is fatal.

Evidence and manual QA script: `ci-quality/agent-debug.md`.
Guard: `apps/desktop/scripts/__tests__/start-agent-devtools-session.test.mjs`,
the `Native Windows` CI job.

#### Stale-profile sweep

- The sweep is hygiene, not the ownership guarantee: it runs after the dev
  server spawns, reports what it skipped or failed, and never fails a launch.
- Reclaim a sibling profile only when its `agent-devtools-owner.json` launcher
  pid is dead AND its process group is empty, or the marker predates this boot;
  on `win32` the pid suffices. Uncertain liveness means alive; age never decides.
- A missing or malformed marker, or a POSIX marker without `pgid`, is listed by
  path with `ls -d` only, never deleted. Keep the profile root otherwise empty:
  the marker is safe there only because the database never enumerates it.

Evidence: `ci-quality/agent-debug.md`.

## SHRINK-ONLY FILE BUDGETS

- A file-size guard records the file's CURRENT line count, never an allowance.
- Growth past the number fails. Move the code out (a hook, a module under
  `src/assistant-panel/`, the owning package); never raise the number.
- The number is an EXACT pin: shrinking below it ALSO fails, naming the new
  count. Lower it in the same commit. Why: a tolerance band lets trimmed lines
  be added back later while still passing.
- Both directions must be able to fail; prove each before trusting a budget.
- Give every new file-size guard this shape, never a cap with headroom.

Guard: `packages/app-shell/src/__tests__/assistant-contract-boundary.test.ts`
(its comment block is the evidence),
`scripts/__tests__/agent-contract-budget-contract.test.mjs`.

## REACT DOCTOR (LINT)

React Doctor owns React/JS lint via `.github/workflows/react-doctor.yml` (every
PR, push to `main`) and `doctor.config.ts`. Change an invariant below only
together with that config and this section.

- Telemetry off: `noScore` + `share: false` in config, and
  `REACT_DOCTOR_NO_TELEMETRY=1` in the workflow `env` (the Action has no flag).
- Gate is `scope: changed` + `blocking: error`: only newly introduced
  error-severity issues fail a PR; the existing backlog is advisory.
- A version bump changes three files: root `package.json`, the workflow
  `version`, and `EXPECTED_REACT_DOCTOR_VERSION`. Re-run the full-scan and
  changed-scope controls first. Never pin below 0.8.2 (rename-aware baseline).
- A large rename set can still reclassify old findings as new. Prove
  pre-existence with a full base scan at the old paths, then suppress narrowly
  through `ignore.overrides` with a follow-up ticket to drop it.
- Keep lint enabled: the root `react-doctor` script is `--scope full` without
  `--no-lint`. Why: JSON `analyzedFiles`/`complete` describe the lint pass only.
- `doctor.config.ts` keeps, with its reasons inline: no broad `ignore.files`
  (a proved exception uses `ignore.overrides`, globs relative to each workspace
  package, or `rules`); `Accessibility` and `Security` categories off (Biome
  a11y and the lefthook `secrets-scan` own them);
  `react-compiler-no-manual-memoization` off (manual memoization is intentional).
- `react-hooks-js/*` rules do not run here (no project is detected as using the
  React Compiler): zero findings means not loaded, not clean. ESLint's
  `react-hooks/*` rules are the live compiler diagnostics.
- An unknown rule id is accepted silently. Before citing a React Doctor rule id
  as a contract, prove it fires on a known violation; a zero count proves
  nothing. `lint-rule-liveness-contract.test.mjs` covers ESLint rules only.
- Run a fresh full scan before enabling `no-multi-comp` or raising it or
  `no-multi-component-file` to `error`.
- Knip is the only file/dependency auditor: `doctor.config.ts` keeps
  `deadCode: false` and the six native graph rules off. `knip.yml` (weekly +
  dispatch) runs `pnpm knip`, then `node scripts/check-knip-liveness.mjs`; every
  finding or tool failure exits nonzero — no `continue-on-error`, baseline, or
  threshold. It becomes a PR gate only with measured runner cost. Cycles stay
  with `lint:no-source-cycles` and `scripts/verify-no-cross-chunk-cycles.mjs`.
- The Fast Refresh boundary rule is ESLint's
  `react-refresh/only-export-components` — not React Doctor's id, not Biome's
  `useComponentExportOnlyModules`. Why: only it matches Vite's runtime check.
- ESLint warnings are a per-rule two-way ratchet (`eslint-warning-baseline.json`,
  run as `lint:eslint`): over the entry fails, under it fails until lowered, a
  rule with no entry fails, errors never get a budget. Re-baseline with
  `pnpm run lint:eslint --write-baseline` and read the diff — an unexplained
  drop is a rule going dark.
- The required Static job owns the full-tree ESLint verdict (`lint:ci`).
  `verify-script-entrypoints.test.mjs` probes verifiers against a bounded
  `--repo-root` and names each one's full-tree owner test; keep audits there.
- Run `pnpm run react-doctor`; the `run` is required because bare `doctor` is a
  pnpm builtin that exits 0. New issues only:
  `npx react-doctor . --scope changed --verbose`. The CLI takes exactly one
  positional argument, a directory — one invocation per path.

Settled: both categories off, manual-memoization rule off, Knip over React
Doctor graph rules, ESLint over Biome for Fast Refresh, per-rule ratchet over a
scalar `--max-warnings`. Evidence: `ci-quality/react-doctor.md`,
`ci-quality/knip-audit.md`, `ci-quality/eslint-warning-ratchet.md`.
Guard: `scripts/__tests__/react-doctor-version-contract.test.mjs`,
`scripts/__tests__/knip-workflow.test.mjs`,
`scripts/__tests__/eslint-warning-baseline-contract.test.mjs`,
`scripts/__tests__/pnpm-shadowed-builtin-contract.test.mjs`.

### React Compiler bailouts are invisible — measure them

- Both apps compile through `react({ compiler: ReactCompilerConfig })` on
  `oxc-transform-react`, the plugin's only backend; a missing package fails the
  build. `compilationMode: 'infer'` stays.
- Keep `/[\\/]\.vite[\\/]/` in the plugin `exclude` while `cacheDir` sits
  outside `node_modules`. Why: otherwise dev compiles pre-bundled dependencies.
- A bailout emits nothing, and `compiler.logDiagnostics` forwards fatal errors
  only; it is not bailout coverage. The measurement is
  `node scripts/react-compiler-inventory.mjs --backend <babel|oxc> --out <file.json>`.
- Before any compiler-toolchain change, run its
  `--diff <baseline.json> <candidate.json>`; it exits nonzero when a function
  stops compiling. Regenerate baselines after editing the script.
- Root devDependencies `babel-plugin-react-compiler` and `@babel/core` exist
  only so the inventory can report bailout reasons.
- The largest components bail, so their hand-written memoization is all they have.
- `eslint-warning-baseline.json` covers only functions the compiler analyses.
  Extracting code from a bailed function surfaces latent findings: check the
  inventory before calling an increase a regression; never adjust speculatively.

Evidence: `ci-quality/react-compiler-inventory.md`.
Guard: `scripts/__tests__/react-compiler-inventory.test.mjs`.
