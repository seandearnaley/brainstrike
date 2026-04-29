---
title: PGlite and Drizzle DB Contract
---

# PGlite and Drizzle DB Contract

This note records the current database runtime baseline after the desktop DB host,
web PGliteWorker host, and Drizzle schema compatibility audit work.

## Current Runtime Ownership

Desktop owns PGlite in an Electron utilityProcess DB host. The visible renderer
uses the preload-facing DB APIs, while Electron main coordinates lifecycle and
routes requests through the DB host manager. Desktop storage remains the
filesystem-backed profile directory.

Web owns PGlite in a browser PGliteWorker DB host. The visible renderer uses the
shared DB client/runtime layer and must not own the IndexedDB-backed PGlite WASM
runtime directly.

Direct PGlite remains scoped to tests, memory-only databases, and explicitly
non-browser utility paths. It is not the production web app runtime owner.

PGlite remains a single-connection database. Worker and multi-tab designs
multiplex callers to one owner; they do not create true concurrent Postgres
connections.

## Migration Authority

The legacy MigrationRunner remains the production migration authority.
Production initialization records applied migrations in `_migrations`.

Drizzle migration runner remains schema-validation-only. It writes
`__drizzle_migrations` only in explicit validation contexts, not in runtime
startup. Promotion to production is currently
`blocked-by-production-schema-drift`: generated Drizzle migrations still create
core runtime tables with incompatible ID, timestamp, and queue payload types.

No runtime may introduce silent dual-ledger migration behavior. If
`__drizzle_migrations` exists on the production bootstrap path, startup fails
hard with actionable diagnostics rather than guessing which ledger is
authoritative.

## Provider/Model Catalog Drift

The hand-authored app migrations create and seed the provider/model catalog with
`providers/models`.

Drizzle schema now maps the production `providers/models` tables, so repository
work can use the production catalog shape without depending on the old
`model_registry` spike table.

The generated Drizzle migration manifest now ends with `providers/models` as the
catalog tables and drops the old `model_registry` spike table from its final
schema.

The coded baseline records this as
`schema-and-manifest-reconciled`: production schema is represented in Drizzle
code and in the final generated Drizzle manifest shape for these catalog tables.

This does not mean the full generated Drizzle migration manifest is production
compatible. The migration authority audit separately blocks Drizzle promotion
until the core file, collection, and job queue table shapes match production.

## Required Contract

The shared Brainstrike DB contract has two layers.

The execution client covers:

- `query`
- `exec`, which resolves without exposing implementation-specific command
  results
- `transaction`
- live query start, refresh, listener cleanup, and terminal disposal

The runtime host covers:

- diagnostics with an explicit `ok` state plus optional message/details
- reset and close semantics

Live-query listener cleanup and live-query disposal are separate operations:
removing one UI listener must not silently tear down the underlying live query,
while disposal is the terminal runtime cleanup path.

Desktop utilityProcess, web worker, and direct test/non-browser implementations
should conform to that contract for all migration paths.

No fallback should silently hide missing DB capabilities. If a runtime cannot
support part of the contract, it should report an unavailable/error state.

## Drizzle Adapter Bridge

`drizzle-orm` is pinned to exact `0.45.2` because `drizzleFromHandle()` bridges a
PGliteWorker-compatible raw execution client into Drizzle's concrete PGlite
adapter. That bridge is intentionally narrow: it only accepts explicit
`DbHandle.raw` clients that expose `query`, `exec`, and `transaction`, and it is
covered by integration tests for the adapter calls used today.

Do not widen the dependency range or upgrade Drizzle as routine dependency
churn. Any Drizzle upgrade must re-audit the adapter's PGlite method usage and
either prove the raw execution-client bridge is still valid or replace it with a
first-class Drizzle driver/client adapter.
