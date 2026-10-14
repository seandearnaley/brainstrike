# Idle worker retirement — 2026-10-06

The normal app at `4b6cb08` returned semantic results during indexing, then a
query submitted at 04:45:10Z timed out after the existing 60000ms response bound.
At 04:46:20Z the physical-window close callback threw `Object has been destroyed`
before resolving its retirement promise. The visible query and later shutdown
remained pending. The original main log records those events; it does not record
a GPU device-loss notice, so the initial timeout's hardware cause is unconfirmed.

Two ownership defects are demonstrated. Electron makes the window's
`webContents` getter inaccessible after physical close; the manager now retains
that emitter before destruction and removes listeners through that retained
reference. A browser worker calling `self.close()` emits no owner-side error or
exit event. Workerpool 10.0.3 therefore retains the dead slot unless the adapter
acts on its existing typed source-close notice. The adapter now uses its existing
public `terminate(true)`/replacement path and awaits that retirement before new
submission. It never resubmits an interrupted request.

Controlled public-workerpool tests cover idle and active self-close: idle resumes
on a distinct worker; active inference rejects once and is absent from the new
worker's request list. A held retirement blocks new submission. Retired duplicate
notices and malformed or foreign identities keep their existing controls. Idle
closure logs its device-loss reason at INFO without failure telemetry; active
interruption and retirement failure remain errors.

A separate headless Chromium replay used real browser Workers and installed
workerpool RPC, with deterministic vectors instead of model inference. After
the owner observed the close, the original adapter left the next request pending;
the candidate returned its result through a distinct worker with no failure
telemetry. A request admitted before the owner handled the close instead failed
explicitly. This proves browser transport ownership, not native GPU recovery.

Validation on the frozen candidate:

- `pnpm exec vitest run` in `packages/queue`: all 222 tests passed.
- Desktop `pnpm exec vitest run` for query/document settlement, manager
  cancellation, physical-stop ownership, reinitialization readiness and
  foreground ownership: all 124 tests passed.
- Desktop `pnpm exec tsc --noEmit --project tsconfig.main.json` and queue
  `pnpm exec tsc --noEmit`: passed. Ultracite checked the six code/test files.
- The older desktop `embedding-host-manager.test.ts` had 27 failures, four
  passes and 18 errors on both candidate and the original `4b6cb08` manager;
  the failed test names match. This is not a full regression pass.

Foreground-only phase logs report preparation, inference and validated completion
with elapsed time and runtime/request identity; they contain no query text or
vectors. All response and physical Stop/shutdown/reset deadlines are unchanged.
The coordinator owns the final normal-app test after more than five idle minutes.

CI is disabled due to cost; validation must run locally.
