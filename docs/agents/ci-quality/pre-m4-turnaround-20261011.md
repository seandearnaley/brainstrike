# Pre-M4 test-turnaround receipt — 2026-10-11

CI is disabled due to cost; validation must run locally.

Implementation is published through `be4d3136c1976ce1af3a7538174906d825ed4815`
on `codex/pre-m4-test-turnaround-20261011`. The final receipt commit also removes
an ineffective agent worker setting. M4's coordinator reports composing
`08fbdd948` with final M3 on `codex/m4-delivery-20261011`; also pick up
`be4d3136c` (required destructive tagging) and this receipt's cleanup.

## Whole-path outcome: failed, not accepted under 30 minutes

Command: `pnpm check:routine --no-install`.

- Candidate: `ce9aedd69dfed51d25363249ab72a5958a55d4ad`.
- Tree: `036a95cfd65065d4c5a8668f9654ec125626da00`.
- Parents: `be4d3136c1976ce1af3a7538174906d825ed4815` and M3
  `4e4a71a821fa91b1bac3b48a1ca7c31fa13a5ab1`.
- Started 10:45:00.952 UTC; finished 11:03:27.707 UTC. Exit 1 after
  **18m26.756s wall time**. Checkout clean before and after.
- Mac mini: arm64, 12 logical CPUs, 32 GB, macOS 27.0.1;
  Node 26.8.2, pnpm 11.15.0, Electron 44.4.5.
- Installed workspace, existing Turbo/transform caches retained. Every pnpm
  command used `pnpm_config_verify_deps_before_run=error` and
  `COREPACK_ENABLE_PROJECT_SPEC=0`. Unsigned local execution.

| Stage | Actual result | Elapsed |
| --- | --- | --- |
| Secret scan, boundaries, lockfile | Passed | 1.892s combined |
| Script tests | 1,787 passed, 2 skipped, 0 failed | 17.488s |
| Lint | Passed; existing warning baselines retained | 75.501s |
| Type check | 122 tasks passed, 76 cached | 48.612s |
| MCP representative verification | Passed | 2.179s |
| Build | 60 tasks passed, 58 cached | 2.461s |
| CSS validation | Passed | 0.039s |
| All units | 77 tasks passed, 50 cached | 522.554s |
| Other package integrations | 61/63 tasks passed, 38 cached; failed | 435.725s |

Failure: `packages/host-capabilities/__tests__/cli-bin.integration.test.ts`
rejects a missing/non-JavaScript `npm_execpath` with “Run CLI executable
integration with pnpm run test:integration”, despite running that script.
Four installation cases fail this fixture precondition: two executable aliases
and two frozen-install store-setting variants. Host-capabilities totals:
127 passed, 4 failed, 1 skipped across 20 files. The agent integration task was
interrupted when Turbo failed; it has no complete passing receipt.

The later explicit desktop/agent-host integrations, browser stage and smoke
lanes were NOT reached in this whole-path run. The tested M3 parent is older
than the coordinator's final `6815d2323`; this receipt does not qualify that
newer M3/M4 composition. No further benchmark campaign was started.

## Demonstrated improvements and separate passes

- D5 lock race: readiness/decision/release handshake removes the fixed
  250-second waiting floor. Windows routine: 8 passed in 2.81s; explicit
  ten-round/eight-contender stress: all rounds passed in 5.09s.
- Desktop units: all 523 files and 6,346 tests passed in **285.73s** during
  the composed run, versus the earlier serialized root-plan run's 501.38s
  (6,345 tests). The standalone two-fork run passed in 230.14s. Load/cache
  conditions differed; these are observed timings, not a controlled A/B claim.
  Only local Mac units use two isolated forks. Native integrations, coverage,
  Windows, Linux, CI and explicit shards remain serialized.
- Desktop type check: `pnpm --filter @brainstrike/desktop run type-check`
  passed in 28.076s cold and 16.901s warm on Mac. Incremental invalidation was
  separately checked with a deliberate exported-type mismatch and restoration.
- File-import transform-cache run: 4.310s disabled / 4.350s cold / 3.696s warm;
  assistant-service: 2.353s / 2.325s / 1.474s. All passed; isolation retained.
- Assistant UI `test:browser`: 29 files, 174 passed, one existing skip, 51.28s
  after restoring stylesheet aliases and explicitly parking the real pointer.
- On `165cfd89f`, exact check-runner smoke commands with
  `CI=true pnpm_config_ci=false` passed: web 28/28 in 34.063s; desktop
  35 passed/1 existing skip in 159.762s; delegated desktop 14/14 in 109.035s.
- `playwright test e2e/database-live-query-memory.desktop.test.ts
  --project=regression --workers=1 --retries=0`: both passed in 29.149s.
  Routine repetitions were reduced; original memory and handle assertions remain.
- Native-text fixture repair passed again in the composed integration stage:
  7 passed/1 skipped. Query success needs SQLite memory accounting absent from
  this Node build; the query-refusal case passed.

Rejected DB/app-shell/app-state worker caps made those packages slower and
were removed. The agent's apparent improvement was also NOT attributable to
its added cap: unit, integration and coverage commands already use
`--no-file-parallelism`, which Vitest resolves to one worker. This receipt
removes that redundant cap; effective official-command worker settings are
verified unchanged. Do not credit it with a speedup.

Other delivered repairs include native addon build ordering for state-store,
canonical build-cache reuse, stale validation references, portable compiler
launching, and destructive tagging with all three retirement cases still
selected. No specs or acceptance assertions were deleted.

## Limits and evidence

Routine selection omits the complete desktop/agent-host integration matrices,
full E2E, coverage and deliberate stress. `pnpm check:release` retains those
longer checks. Full release, cold-cache timing, install time, Linux qualification
and the final M3/M4 composition remain unverified here. **There is no complete
passing under-30-minute receipt.** Do not turn the 18m27s failure into one.

Raw evidence is retained beside both `pre-m4-test-turnaround/brainstrike`
worktrees in `../evidence/`: `composed-routine.{log,mjs}`,
`composed-routine-receipt.json`, `composed-routine-candidate.bundle`,
`remaining-e2e-validation.{json,log}`, `desktop-parallel-units.log`,
`worker-budget-units.{json,log}`, `focused-optimizations.json`, normal hook logs,
and `agent-workers-before.json` / `agent-workers-after.json`.
The composed checkout was clean at completion and no processes from that
worktree remained in the post-run process listing. The composition is retained
on the Mac validation branch and in the bundle; the worktree returns to the
published pre-M4 base for handoff. No new M4 product work was done here.
