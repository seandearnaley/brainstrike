# Desktop composition root: Phase 4 decision and first slice

Supports `docs/agents/effect-boundary.md` § "Desktop composition refactors".
ADR: `docs/adr/0005-desktop-composition-root.md` (**Accepted by owner,
2026-09-25 UTC**). This record maps current ownership and the first extraction;
it does not imply the rest of the composition root has been extracted.

## Current ownership map

| Time / owner | Current source | Constraint for an extraction |
| --- | --- | --- |
| Before Electron ready | `apps/desktop/src/main.ts` boot setup | Scheme registration and path isolation precede readiness; they are not disposable profile services. |
| Module scope | `main.ts` host managers, maintenance objects and early IPC | Keep IPC's one `main/disposer-stack.ts` owner; early handlers resolve app-ready services at use time. |
| App ready | `main.ts` and `main/git-awareness-lifecycle.ts` | Git inventory and forge use the database and retain separate failure-isolated shutdown steps. |
| Profile generation | `db-main.ts`, `db-host-manager.ts`, MCP reset authority | Reset retires the old DB owner; retained client methods reject. Reusing an old Layer reference cannot revive that owner. |
| Process shutdown | `main/desktop-graceful-shutdown.ts` | Named dependency order, failure isolation and the 5-second deadline remain the owner; a Scope finalizer is not a substitute. |
| Factory reset | `desktop-reset-platform.ts`, `desktop-factory-reset.ts` | Eleven named stops settle in parallel before DB drain/deletion; the renderer-ready acknowledgment gates MCP reopening. This is restartable, not final teardown. |

The platform contract's factory-reset and graceful-shutdown sections, and the
Phase 3 lifecycle evidence, are the current behavioral authorities. The new
PGlite fatal-trap rule in `docs/agents/database.md` also remains authoritative:
after a fatal WASM trap, do not keep using the corrupted instance.

## Why extraction precedes Layers

The present construction order cannot express shutdown's dependency order by
reverse Scope release. A combined Git/forge Layer could also lose their separate
failure isolation. Reset stops resources that later restart, while DB-owner
retirement permanently invalidates old clients. An imperative composition owner
can expose those facts without adding a second release path. A later scoped
resource is worth testing only where one owner has a matching acquisition and
final release and demonstrably removes manual cleanup.

Two possible improvements are outside behavior-preserving extraction: cleanup
after partial app-ready acquisition, and an explicit policy for failures after
DB-owner retirement but before renderer replacement. Both need their own tests,
contract decision, and user authorization; restoring an old owner pointer is
never a valid rollback.

## First slice: snapshot startup maintenance

`main.ts` still constructs the one `SnapshotService` after `app.whenReady()`,
assigns it to the slot used by early IPC resolvers, then calls
`main/snapshot-lifecycle.ts` with that same service. The assistant server also
receives that exact instance. The new module owns only the original nonblocking
startup task: obtain the DB, reap pre-boot runs, query **all** roots with
`SELECT id, path FROM roots`, sweep vanished-root snapshots, then run retention
GC. The reap's inner catch still logs and continues; the outer catch still logs
DB/query/sweep/GC failures under the existing orphan-sweep category. GC item
failures and inaccessible roots keep their separate logs. No new reset,
shutdown, startup rollback, or Layer ownership was introduced.

`snapshot-lifecycle.test.ts` checks the order, exact root query, unchanged
service identity, nonblocking return, and failure paths. A deliberate temporary
rethrow in the inner reap catch made the focused test fail before sweep/GC; it
passed after restoration. The five-file focused batch (snapshot lifecycle and
wiring, graceful shutdown, factory reset, IPC disposer ledger) passed 40 tests;
Effect and contract-budget guards passed 14 tests. Desktop's topological
type-check passed 51 tasks, including main/test/E2E types and Effect diagnostics
with zero errors; `build:main` and scoped Ultracite checks passed. These checks
establish the targeted invariants, not a measured bundle-size improvement.
