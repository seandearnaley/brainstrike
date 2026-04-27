---
title: PGlite and Drizzle DB Contract
---

# PGlite and Drizzle DB Contract

This note records the current database runtime baseline before the web
PGliteWorker and Drizzle migration-authority work.

## Current Runtime Ownership

Desktop owns PGlite in an Electron utilityProcess DB host. The visible renderer
uses the preload-facing DB APIs, while Electron main coordinates lifecycle and
routes requests through the DB host manager. Desktop storage remains the
filesystem-backed profile directory.

Web currently creates PGlite directly from the visible renderer through
`DbProvider` and `wasmLoader.createPGlite('idb://web')`. The target architecture
is a worker-owned PGlite runtime, but that work should be implemented behind an
explicit shared DB client contract.

PGlite remains a single-connection database. Worker and multi-tab designs
multiplex callers to one owner; they do not create true concurrent Postgres
connections.

## Migration Authority

Current production initialization still uses the legacy MigrationRunner through
`migrate()`. That path records applied migrations in `_migrations`.

The Drizzle migration runner exists and records state in `__drizzle_migrations`,
but it is not the production initialization path today. Do not treat the
presence of the bundled Drizzle `migrations.json` as evidence that drizzle-kit
owns production migrations.

No new runtime should introduce silent dual-ledger migration behavior. A future
cutover must explicitly choose one production authority or define a staged
compatibility bridge.

## Provider/Model Catalog Drift

The hand-authored app migrations create and seed the provider/model catalog with
`providers/models`.

Drizzle schema now maps the production `providers/models` tables, so repository
work can use the production catalog shape without depending on the old
`model_registry` spike table.

The generated Drizzle migration manifest still describes `model_registry` for
that area. That manifest is therefore schema-validation-only and must not become
the production migration authority until it is regenerated or bridged through an
explicit migration cutover.

The coded baseline records this as
`schema-reconciled-manifest-unreconciled`: production schema is represented in
Drizzle code, but drizzle-kit generated SQL is not production-canonical.

## Required Contract

The shared Brainstrike DB client contract needs to cover:

- `query`
- `exec`, which resolves without exposing implementation-specific command
  results
- `transaction`
- live query start, refresh, listener cleanup, and terminal disposal
- diagnostics with an explicit `ok` state plus optional message/details
- reset and close semantics

Live-query listener cleanup and live-query disposal are separate operations:
removing one UI listener must not silently tear down the underlying live query,
while disposal is the terminal runtime cleanup path.

Desktop utilityProcess and web worker/direct implementations should conform to
that contract before broad Drizzle or web PGliteWorker work proceeds.

No fallback should silently hide missing DB capabilities. If a runtime cannot
support part of the contract, it should report an unavailable/error state.
