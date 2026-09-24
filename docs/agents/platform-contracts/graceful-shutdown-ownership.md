# Shutdown ordering, the forced-exit budget, and the measured forced exits — evidence

Supports `docs/agents/platform-contracts.md` § "Graceful shutdown ownership (hidden hosts and background indexing)".
Read before adding or reordering a shutdown step, or before raising a shutdown timeout. The contract holds the rules; this file is the record behind them.

Everything below is extracted verbatim from the contract as it stood before
distillation (2026-09-21). Corrections verified against the code today are
marked inline as **CORRECTION (2026-09-21)**; nothing else is rewritten.

---
### Graceful shutdown ownership (hidden hosts and background indexing)

`main.ts` runs its ordered shutdown steps under ONE forced-exit budget
(`SIGNAL_SHUTDOWN_TIMEOUT_MS`, 5s), armed for both signals and `before-quit`.
Do not raise that budget to absorb a slow
step; fix the owner. Settled rulings, each with a paired test:

- The forced-exit log names the step still awaiting completion and its elapsed
  time (`shutdown-step-tracker.ts`). That record is the only actionable fact a
  CI runner leaves behind, so it is a product log, not temporary instrumentation.
- `before-quit` delays Electron's normal window closing while app cleanup runs.
  After retiring embedding-backfill admission, the first tracked step closes
  and joins ordinary renderer windows
  with `BrowserWindow.close()` / `closed`, while their IPC dependencies still
  exist (`close-desktop-renderers.ts`). Hidden chunking/embedding/LLM windows
  stay alive for their owning stop commands. Normal close preserves unload and
  window-state hooks; macOS activation cannot recreate a producer and
  second-instance and macOS `open-file` requests cannot enqueue work or show a
  window during this drain.
  Already-admitted database work then drains through the existing
  scheduler before database closure. The new `joins renderer IPC producers before
  closing their hosts` case in `app-launch.test.ts` keeps real renderer DB/chunking
  requests active across quit and rejects observed renderer console errors and
  main-process IPC failures. Renderer console capture is observational until the
  page closes; process output and the owned-process exit assertion remain available
  through shutdown.
  Its owned-process close assertion uses a 5s test deadline; the application retains
  the separate existing `SIGNAL_SHUTDOWN_TIMEOUT_MS` 5s forced-exit budget above.
- Shutdown retires embedding-backfill admission FIRST
  (`cancelAllDesktopEmbeddingBackfills()` before any host step), and a backfill
  that arrives after `markDesktopShuttingDown()` is refused before it touches
  the host (`ipc-embedding-backfill.test.ts`). Background indexing keeps
  requesting backfills until its renderer dies; each request would otherwise
  restart the host the next step is stopping. Job rows stay durable.
- `EmbeddingHostManager.dispose()` refuses new starts BEFORE its cooperative
  stop awaits the renderer (`embedding-host-manager.test.ts`), and
  `RendererHostLifecycle.ensureStarted()` lets a `stopping` host settle instead
  of replacing its window (`renderer-host-lifecycle.test.ts`). Replacing the
  window mid-stop used to orphan the stop wait and let a timed-out stop destroy
  the replacement. Shutdown disposal waits at most 3s (`EMBEDDING_HOST_SHUTDOWN_TIMEOUT_MS`),
  below the unchanged 5s application deadline. Ordinary Stop and factory reset
  retain their existing 10s wait. Timeout or an explicit renderer
  error still destroys the owned renderer and retires its lifecycle, but rejects
  so the shutdown tracker records the failure instead of reporting a successful stop.
- The embedding worker wakes for `stop()` while awaiting a background permit,
  idle backoff, inter-batch delay, claim-size retry, or error backoff via a stop
  signal (`embedding-worker-stop-idle.integration.test.ts`). A stopped permit
  waiter returns before claiming any job, even if its permit never arrives.
  Already-running batch work remains bounded by the existing `leaseMs` stop join;
  the stop signal does not cancel an embedding already executing. The first
  attributed local forced exit named `embedding-host` at 4998 ms: the host's
  cooperative stop was waiting for a worker parked in a 30 s idle poll.
- The assistant HTTP server's shutdown stop ends live connections after
  `close()` (`close-http-server.ts`, paired real-socket integration test). An
  already-closed listener (`ERR_SERVER_NOT_RUNNING`) is a successful repeated
  stop; other close failures remain visible. Plain `server.close()`
  waits for every in-flight response, and the first attributed CI forced exit
  named `assistant-server` at 5000 ms in the bare app-launch smoke case.
