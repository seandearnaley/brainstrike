# Closing a PGlite: the wedge and the sanctioned drains — evidence

Supports `docs/agents/database.md` § "CLOSING a PGlite: drain first — an overlapping statement wedges it forever".

Why an overlapping statement at `close()` blocks the event loop with no timer recovery, the BST-1320 CI wedge, the BST-1329/BST-1330 reachability audit, and the exact desktop and web drain orderings. NOTE: the wedge below was verified on the then-pinned PGlite 0.5.5; the catalog now pins 0.5.8. Read before touching any close or reset path.

The record below is the original contract text, extracted unchanged.

`PGlite.close()` (verified on the pinned 0.5.5) deactivates the WASM backend
(`mod._pgl_setPGliteActive(0)`) **before** it awaits the shutdown protocol and
`closeFs()`, and `_checkReady()` only guards *entry*. A statement still in
flight at that moment enters `execProtocolRawSync`'s **synchronous** main loop
against a dead backend: neither that statement nor `close()` ever settles, and
because the spin is synchronous WASM the **event loop is blocked** — no timer,
no `AbortSignal`, no `Promise.race` timeout can recover it. `SIGKILL` is the
only exit.

Any close path must therefore drain in-flight work first. This is not
theoretical: it wedged a CI job to its 60-minute cancellation cap (BST-1320,
diagnosis and the Mastra-free repro in `docs/agents/mastra-boundary.md`;
upstream [electric-sql/pglite#1084](https://github.com/electric-sql/pglite/issues/1084)).
App-path reachability was **audited by code reading (2026-08-16,
BST-1329/BST-1330; not instrumented)**: desktop shutdown/factory reset cannot
hit it as an event-loop wedge — every statement reaching the DB-host utility
process is a serially dispatched envelope and `close()` runs only as the
`'close'` envelope, so overlap is impossible *as long as `db-host-entry.ts`
stays strictly serial*, and `DbHostManager` caps any in-host wedge at its 2s
ack-race kill. The `'close'`/`'reset'` handlers drain live-query handles first
(BST-1330). The reachable exposure is the **web direct path** — web factory
reset and the DbProvider prod-unmount close, tracked as **BST-1329**.

Drains mean **canonical join points only** — sleeps, `SELECT 1` flushes, and
`Promise.race` timeouts are rejected (a narrowed window is silent degradation,
and no timer can fire against the blocked event loop anyway). The sanctioned
seams, per surface:

- **Desktop (main process / DB host):** the reset barrier + scheduler idle
  join in `apps/desktop/src/platform/desktop-database-work.ts` (the idle join
  delegates to the shared `waitForDatabaseWorkSchedulerIdle` below), the
  awaited live-subscription cleanup in
  `apps/desktop/src/ipc-domains/db-ipc.ts`, and the in-host live-unsubscribe
  in `db-host-entry.ts`'s `'close'`/`'reset'` handlers (BST-1330).
  `resetDesktopDatabaseProfile` (`desktop-reset-platform.ts`) composes them:
  barrier → unsubscribe → idle → unsubscribe again → reset.
- **Web direct path (BST-1329):** `packages/db/src/db-reset-drain.ts` mirrors
  those seams for the renderer-owned PGlite — a reset-barrier scheduler facade
  (new submissions wait out an active reset; no browser `AsyncLocalStorage`,
  so reset-internal statements MUST run on the raw connection, never the
  scheduled handle), `waitForDatabaseWorkSchedulerIdle` over the renderer
  `DatabaseWorkScheduler`'s `getSnapshot`/`subscribe`, and a provider-level
  live-query drain registry that `usePGliteLiveQuery` unsubscribes route
  through (PGlite's live refreshes have no scheduler entry to join — the
  purge's own DELETEs trigger them). The web drain order is deliberately
  **idle join FIRST, then seal, then unsubscribe** — the reverse of the
  desktop's unsubscribe-first double-cleanup: the web barrier already blocks
  new subscriptions (`live.query` is scheduler work), so nothing can attach
  while the scheduler drains, and joining idle first means an idle-timeout
  abort leaves every live handle alive and subscribed instead of silently
  killing them all. Sealing the registry closes the tail where scheduler work
  settled before idle but its handle registration lands after the drain's
  snapshot: a sealed `register()` immediately initiates unsubscribe and the
  drain joins those late unsubscribes before returning; a failed reset
  unseals on barrier release. Both orderings now live in ONE React-free
  module, `packages/db/src/database-runtime.ts` (BST-1653):
  `createDatabaseRuntime().factoryReset` runs barrier → idle → seal →
  unsubscribeAll → purge → close, and `dispose()` (the prod unmount close)
  joins the in-flight initialization promise plus the same
  `drainDatabaseWorkForClose` before running the closer that
  `DatabaseTransport.detachConnection()` handed back (the direct transport
  registers its connection before `migrate()`, so unmount-mid-init is
  otherwise a close under running migration statements; the EARLIER half of
  that window — a client that finishes being created after dispose — is
  covered by `DatabaseTransportOpenContext.isDisposed`). A failed idle join
  aborts/skips the close loudly — never close over a drain you could not
  complete; past the seal the close is committed and unsubscribe failures
  warn and proceed. A DESKTOP reset never reaches that leg: the main process
  owns the database, so `electron-ipc-transport.ts` THROWS from both
  `hardReset()` (when its capability probe fails after the transport was
  already selected) and `purgeAndClose()` rather than handing the runtime a
  local purge that would resolve having destroyed nothing — the caller reloads
  on success, so a fall-through there is a factory reset that silently keeps
  the profile. Pinned by
  `packages/db/__tests__/db-reset-drain.test.ts` and
  `packages/db/__tests__/database-runtime.test.ts` (the invariants, with fake
  transports and no React) plus
  `packages/db/__tests__/electron-ipc-transport.test.ts` (the desktop
  transport's own reset contract, with the real transport);
  `factory-reset.test.tsx` and `db-provider-lifecycle.test.tsx` stay as the
  thin mount-level wiring checks.

## Structured close failures (BST-404, 2026-09-26)

The direct transport keeps teardown non-throwing but emits one error-level
`database_close_failed` record through the existing logger. While the diagnostic listener is mounted, it
can convert the record into a diagnostic event. After renderer unmount, the
logger still emits it, but the database sink has detached; durability in the
database being closed is not guaranteed.
Its storage dimension is only `direct` or `browser-persistent`; it does not add
the data directory as a dimension. The existing error payload is preserved
and may itself contain a path; this is not an error-redaction guarantee. Only the exact PGlite closed message sentinel (including cross-realm errors) is
ignored, not arbitrary failures mentioning "closed". Guards:
`pglite-close-diagnostics.test.ts` (both ownership paths, benign/success and
unexpected/non-Error failures) and `db-provider.test.tsx` (normal unmount). The cached loader reports at its
non-throwing catch boundary; reset uses the same close helper.
`wasm-loader.test.ts` and `factory-reset.test.tsx` cover these real ownership paths.

## DbHostManager's wedge escape (BST-1872 L1, 2026-09-29)

The 2s ack-race kill above is superseded: closing the host is now close ack, SIGTERM,
awaited `exit`, then SIGKILL on timeout, and a transaction or init timeout SIGKILLs and
awaits the exit before another host forks. A host stuck in synchronous WASM can run no
signal handler, so SIGKILL is the only signal that ends it. A failed `syncToFs` or `close`
in the host now rejects and keeps the process lock instead of being swallowed. Record:
`docs/agents/platform-contracts/graceful-shutdown-ownership.md`.
