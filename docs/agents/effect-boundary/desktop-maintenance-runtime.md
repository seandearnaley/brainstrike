# Desktop maintenance resource ownership

Supports `effect-boundary.md` § "Desktop maintenance scopes" and
`platform-contracts.md` § "Graceful shutdown ownership (hidden hosts and background indexing)".
Decision: `docs/adr/0006-scoped-desktop-maintenance.md` (BST-1824).

## Baseline — 2026-09-25

Main base is `e04d9f99d0ccc5583f483cf400b8739ba61ea6df`. Measurement used the
clean pre-squash checkout `4543eccd077fbb8d6702fadf5e59a58581821050`; the scheduler
and the complete source tree compare identical to that base. With the same installed tools,
`pnpm --filter @brainstrike/desktop build:main` produced `dist/main.js` of
2,694,394 bytes (574,029 bytes with gzip -9). Bare packages are external in this
build, so this measures application code, not Effect's installed dependency size.
Both existing scheduler suites passed: 35 tests, 2.51 seconds.

## Timing choice

The initial proposal used an unref Clock adapter plus Schedule.fixed and
TestClock. Inspection of rc.117 showed that fixed scheduling can emit an
immediate catch-up tick after a missed window. Sequentially repeating an awaited
SQL pass instead changes fixed cadence into delay-after-completion. Neither
preserves the native interval behavior. The implementation retains one native
unref timer adapter under Effect resource ownership; it does not create a
custom interval clock to make the proposed feature checklist fit.

The two domain policies stay separate. Factory reset does not stop these
schedulers: their submissions already wait behind the database reset barrier.
The trigger scope owns no admitted SQL and no database handle.

## Contract falsification

The paired Effect and contract-budget guards pass (16 tests). Replacing the
contract's prohibition on scope-owned SQL with permission to own it makes the
new ownership guard fail (exit 1); restoring the rule passes. Runtime resource
and race falsifications are recorded with the implementation below.

The Effect contract grows from 95 to 105 lines for this newly adopted ownership
area. Its decision and measurement history remain in this evidence file and
ADR-0006; the guard pin changes explicitly in the same commit.

The production delegation guard first failed against the unmigrated schedulers
(exit 1). With both using the shared owner it passes; the complete paired guard
run now passes 17 tests. The guard also rejects a second native timer owner in
either scheduler and checks the scoped adapter uses the sanctioned Promise boundary.

## Real process and resource evidence

The integration test bundles the real owner source into a Node child. Both
initial-timeout and recurring-interval cases exit naturally. Removing both
`.unref?.()` calls makes both cases fail at the 2,504 ms parent timeout;
restoring the calls passes both cases (247 ms total). The timeout is a bounded
regression detector, not a production lifetime mechanism.

A local Node microbenchmark ran 550 real create/start/stop/close cycles (50 warmup,
500 retained), with a 60 s initial delay and 10-minute interval. It counted native
timeout creation/clear and subscription acquisition/release. All 550 subscriptions
released, with zero subscriptions or timers remaining. Median acquisition was
0.005208 ms (p95 0.011459 ms); stop plus joined close was 0.003209 ms median
(p95 0.008 ms). These are isolated owner costs, not whole-app startup timings or
CI thresholds; no database work executes in this probe.

## Validation

The focused desktop lifecycle batch passes 133 tests across 13 files, including
both maintenance policies, main boot/shutdown wiring, reset barriers, IPC and
preload import isolation. Full desktop type checking passes for main, tests and
E2E; the test program selects 569 files and strict Effect diagnostics report zero
errors and warnings. Existing factory-reset and shutdown E2E specifications are
unchanged. Shutdown runs in required smoke; factory reset has a separate
`@desktop-ipc-reset` regression lane.

Behavioral main tests invoke the real database shutdown step: both owners stop
before closure is awaited; a finalizer rejecting even `undefined` still permits
the independent database drain and close, while an idle-join rejection prevents
database close. A deferred admitted pass remains pending after its trigger closes
and settles only when its original operation finishes. Repeated start preserves
each scheduler's continuous-idle window; a first tick that stops itself cannot
arm a leaked interval.

## Final build and additional falsification

The canonical desktop build passes all 50 tasks. Final `dist/main.js` is
2,698,158 bytes, or 574,862 bytes with the same `gzip -9 -c` command used on the
baseline: **+3,764 raw bytes / +833 gzip bytes**. No renderer code changed, and
the preload import guard passes; the native timer adapter is main-only.

Removing the post-first-tick liveness check causes the reentrant-stop test to
fail with one leaked timer instead of zero. Restoring it passes all six owner
tests. The staged production-import and documentation guards pass all 17 tests.

The unchanged basic factory-reset E2E passes both cancel and confirmed-reset
cases (11.9 s). The unchanged delegated factory-reset case fails locally after
WebGPU initialization fails and the embedding host refuses reset teardown.
The identical test and command on the unchanged base also fail with the same
embedding-host reset error, before the 30 s first maintenance tick. This is a
reproduced baseline defect, not a flaky verdict or proof of a maintenance
regression. No test, timeout, WebGPU behavior or reset policy was weakened.

The explicit renderer-before-host shutdown E2E also passes unchanged (one test,
3.9 s). The delegated reset failure is tracked as BST-1825; the logs identify the
failed owner but omit its nested rejection, so no precise timeout cause is claimed.
