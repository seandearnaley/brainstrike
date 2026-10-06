# Existing-profile startup and retained failure observation

The original dev startup failed at `2026-10-06T03:05:43.490Z` with
`indexer-startup-timeout` under the 5-second caller deadline. Its export contained
245 repeated IPC errors. The safely stopped profile snapshot contained 4,236
files, 39,622 chunks and 39,622 scoped vectors in a 338,825,216-byte SQLite file.
The original profile was not modified by this investigation.

On disposable copies, full writer validation took 3,226.759 ms and a standalone
Node process/worker/reader became ready in 3,682.710 ms. SQLite integrity, both
FTS integrity checks, Float32 validation and scoped storage checks passed. Copied
profile reopens through both the built Electron app and the original dev-server
mode passed the unchanged 5-second baseline. The reported timeout was **not
reproduced**; these measurements do not identify its cause or establish a bound
for every corpus or host.

The desktop now uses a finite 15-second readiness budget, distinct from
the unchanged 5-second interactive request budget. Close and physical exit join
remain bounded at 1 second. Full validation and readiness admission are
unchanged. A test using the actual connection lifecycle holds readiness beyond
5.5 seconds, then proves successful validation before the new deadline. Its
paired deadline case proves termination occurs after 15 seconds and caller
rejection waits for physical exit.

The activation owner identifies only its exact retained startup failure with a
typed blocked error carrying the original cause. Public status and batch
coverage expose stable blocked data with no authority/counters; renderer
progress stays Blocked. Three activation read polls preserve the cause without
retrying acquisition or creating another startup report. Main's initial startup
subscriber still receives the original error once. Strict search and singleton
coverage reject. Raw errors with the same message and aggregates containing an
independent cleanup failure remain fatal. Background source-abort failures are
outside this startup projection.

The copied app's normal quit at `2026-10-06T03:25:01.458Z` exposed a separate
misleading main startup diagnostic: source retirement's direct
`NativeAuthorityTransitionError` (`Native ingestion paused.`) reached the still
pending initial subscriber. Process exit was 0. The reporter now records that
typed transition as informational retirement only when the existing desktop
shutdown flag is already set. Raw same-message errors, real startup deadlines,
transitions outside shutdown and independent cleanup aggregates retain error
reporting. Reporter RED reproduced one false error with five negative controls
passing (`/tmp/m2-shutdown-report-red.log`); reporter plus startup tests then
passed all ten (`/tmp/m2-shutdown-report-green.log`). Source retirement and its
cleanup rejection semantics are unchanged.

Evidence packet:
`/Users/seandearnaley/Documents/brainstrike-m2-completion-20261005/existing-profile-startup`.
`DIAGNOSIS.json` records the original failure, snapshot counts, isolated timings
and nonreproduced baseline reopens. `snapshot-receipt.json` records the retained
snapshot; `m2-measure-index-startup.log` and `m2-whole-index-startup.log` record
isolated measurements. The retained SQLite SHA-256 is
`be47b69402649da5e54c972a3b2c9778539858313a9c0937b003e96711bb95c6`.

Policy RED: `/tmp/m2-startup-budget-red.log` shows both held-readiness cases fail
under the old 5-second deadline. Relevant tests are desktop
`native-index-startup.test.ts`, `native-index-activation.test.ts`, `ipc-index-search.test.ts`,
`native-scoped-search.test.ts`, app-shell
`native-workspace-index-provider.test.tsx`, and indexer
`lifecycle.integration.test.ts` / `collection-scopes.integration.test.ts`.
Local implementation validation used Node 26.8.2 with
`pnpm_config_verify_deps_before_run=error`:

- From `apps/desktop`, `pnpm exec vitest run src/__tests__/native-index-startup.test.ts src/__tests__/native-index-activation.test.ts --pool=forks --maxWorkers=1 --no-file-parallelism`: 21 tests passed. The final deadline-cause assertion was then verified with the same command targeting startup only: 4 passed.
- From `packages/indexer`, `pnpm exec vitest run --config vitest.integration.config.mts __tests__/lifecycle.integration.test.ts __tests__/collection-scopes.integration.test.ts --maxWorkers=1 --no-file-parallelism`: 9 tests passed, including real-process termination failures and corrupt/replaced-store rejection.
- From `apps/desktop`, `pnpm exec tsc --noEmit --project tsconfig.main.json`: passed.
- From `apps/desktop`, `pnpm exec biome check src/native-index-blocked.ts src/native-index-activation.ts src/__tests__/native-index-startup.test.ts`: passed.

These focused results are not a full regression pass. Final combined renderer,
IPC, test-type results and copied-app proof belong to the delivery receipt.
Reporter validation used `pnpm exec vitest run src/__tests__/native-index-activation-error.test.ts src/__tests__/native-index-startup.test.ts --pool=forks --maxWorkers=1 --no-file-parallelism` from `apps/desktop`: 10 passed.

**CI is disabled due to cost; validation must run locally.** No hosted checks or
automated reviews were requested.


Final copied-profile app verification used the canonical Agent Debug shim, built
Electron app, actual persisted settings and repository root, and Chrome DevTools
observations. The first 30 samples grew from 4,236 files / 39,622 vectors to
4,816 / 43,660. Normal quit exited 0. Reopening that settled profile restored
6,063 / 52,639 and the next 30 samples grew to 6,274 / 54,232. Counts never
decreased within either observation window; both had zero captured renderer
warnings/errors and preserved the same store identity. These observations
verify retained progress and resumption, not completion of the whole scan.

Those runs exposed the shutdown-reporting defect above. After the final reporter
change and main rebuild, a final reopen retained 6,369 files / 55,129 vectors,
returned eight ready status/current coverage observations with no renderer
warnings/errors, and normal quit exited 0. The final structured application log
contained zero error-level records and the expected informational retirement
record. Original unavailable-root and development-runtime warnings remain;
this is not a warning-free claim. All disposable app profiles were removed after
physical process cleanup. The original SQLite, WAL, SHM and clean-shutdown marker
still match the pre-investigation hashes. Final evidence is `REOPEN-RESULT.json`,
`final-observations.jsonl`, `final-log-summary.json`, phase screenshots, exit
receipts, and `original-preservation.json` in the evidence packet.
