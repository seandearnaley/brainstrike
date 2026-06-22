# Turso Schema Baseline

## Contract

Turso uses a greenfield schema baseline. It does not replay the existing
Postgres/PGlite migration chain.

The baseline lives in `packages/db/src/turso/schema-baseline.ts` and records one
applied version in `brainstrike_turso_schema_ledger`. The ledger stores a
checksum over the DDL and seed statements. If that checksum drifts, bootstrap
fails closed instead of silently reshaping an existing Turso profile.

`_migrations` and `__drizzle_migrations` are forbidden in a Turso profile. Their
presence means a PGlite/Postgres migration path touched the file, so the Turso
baseline refuses to continue.

## Table Scope

Version 1 creates the current greenfield table surface needed for later Turso
repository slices:

- roots, file records, file chunks, selection snapshots, and snapshot files
- embedding sets, embedding cache, collection indexing stats, and job queue
- file token cache and legacy token cache
- file tags and file relationships
- providers and models
- view filter presets
- assistant run usage

Seed data is intentionally small but functional: provider/model catalog rows
needed by current settings paths and the seven default view-filter presets.
Catalog reseeding preserves existing `is_enabled` toggles.

## SQLite/Turso Shape

- IDs are app-owned `TEXT` except simple rowid tables.
- Booleans are `INTEGER CHECK (... IN (0, 1))`.
- JSON-like values are validated JSON text.
- Timestamps are UTC ISO-like text using SQLite `strftime`.
- Embedding columns are `BLOB` placeholders for Turso vector data.

## Deferred Features

The baseline does not create Postgres-only physical structures:

- pgvector HNSW/IVF indexes and dimension maintenance.
- `pg_trgm` and generated `tsvector`.
- FTS custom indexes in the primary MVCC file.
- PGlite live-query hooks.
- historical user-data migrations or backfills.

Those are separate migration phases with explicit capability checks.
