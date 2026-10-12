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

The normal root `pnpm run dev` launch on `612fdf033` subsequently reproduced
the timeout under the 15-second budget. Instrumented utility/worker timestamps
showed fork, initial IPC, module import, option validation and projection
selection completing quickly; no state projection was configured. Direct
`writeSync(2, ...)` traces were necessary because worker stderr can buffer later
messages during synchronous validation. Full SQLite integrity took 6,386.294 ms,
porter FTS integrity took 2,232.114 ms, and trigram validation was still running
when the deadline fired. A native sample located active FTS integrity/tokenizer
work, rather than an import deadlock.

The original and retained SQLite files remained byte identical (the SHA above).
The primary and repair macOS arm64 SQLite prebuilds were also identical:
1,980,736 bytes, SHA-256
`98e0e8acd01c632fe5615243e1296af0372826f8783b18fc31c506f73c47459c`.
With the app and dev graph stopped, matched disposable-copy writer benchmarks
completed in 3,385.937 ms under Node 26.8.2 and 3,506.960 ms under Electron 44.4.5
utility/Node 24.21.0. Both writer workers exited 0. The Electron harness retained
its utility IPC port and reached its outer 30-second diagnostic cap after the
completed writer measurement; it is not proof of normal app shutdown.

The same validation checks on the original database path, with the app closed,
completed in 3,321.690 ms, closed normally and preserved the SQLite SHA. That
comparison eliminates different data, native builds and the database pathname
as explanations for the observed launch slowdown. It isolates launch workload
as the relevant difference; the traces do not establish a universal timing bound.

The sequenced root-dev candidate settles the existing `acquireRead()` readiness
outcome before the first visible renderer cold load. The existing full
`acquire()` subscriber continues independently and retains original failure
reporting. The initial subscribers deduplicate only the same error object,
normalizing the trusted retained-blocked wrapper to its cause; independent
cleanup aggregates and primitive throws remain distinct. A fresh read
acquisition failure is reported immediately. A quit begun during the readiness
wait prevents initial window creation and ends initial window wiring cleanly.
Neither full scans nor inference completion delay the first window;
setup-required and failed reader outcomes still open the UI unless graceful
shutdown has begun. Later activation
of windows is unchanged. The actual root-dev candidate reached native reader
readiness and visible Scanning under the unchanged 15-second policy. Final
normal-launch proof belongs to the delivery receipt; no timing-margin claim is
made from that candidate.

Sequencing RED (`/tmp/m2-reader-sequencing-red.log`) reproduced premature window
creation while the reader was held, with four controls passing. Tests also
exercise the actual activation owner with an initial collection scan held:
reader readiness admits the window while full startup is still pending.
Failure controls preserve setup, deadline and independent cleanup errors while
opening the setup/diagnostics UI. Review-control RED
(`/tmp/m2-reader-review-red.log`) had seven failing controls and five original
passing cases before the shutdown and diagnostic fixes. These controls cover
quit on either readiness outcome, immediate fresh failure reporting, retained
error identity in either subscriber order, distinct cleanup aggregates and
independent equal primitive failures.

Detailed receipts are under
`/Users/seandearnaley/Documents/brainstrike-m2-completion-20261005/root-dev-startup`:
`traced-root-dev-unbuffered.log`, `indexer-live.sample.txt`,
`matched-writer-node.log`, `matched-writer-electron-utility.log`,
`original-path-validation.log` and `reader-sequenced-root-dev.log`.
Temporary diagnostic traces are excluded from the final source change.


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


Final sequencing validation from `apps/desktop`:

- `pnpm exec vitest run src/__tests__/native-index-startup-window.test.ts src/__tests__/native-index-activation.test.ts src/__tests__/native-index-startup.test.ts src/__tests__/native-index-activation-error.test.ts --pool=forks --maxWorkers=1 --no-file-parallelism`: 39/39 passed (`/tmp/m2-reader-review-green.log`).
- `pnpm exec tsc --noEmit --project tsconfig.main.json`: exit 0 (`/tmp/m2-reader-review-main-types.log`).
- `pnpm exec tsc --noEmit --project tsconfig.test.json`: exit 0 (`/tmp/m2-reader-review-test-types.log`).
- `pnpm exec biome check --write` on the four changed TypeScript files: exit 0 (`/tmp/m2-reader-review-format.log`).
- `git diff --check`: exit 0.

Independent read-only review is CLEAN after both correctness fixes. The full
regression suite and final normal root dev launch remain delivery-owned checks;
these focused tests and type checks do not qualify those omitted checks.
