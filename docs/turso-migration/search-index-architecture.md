# Turso Search Index Architecture

## Current Verdict

The Turso capability spike is ready for the next migration phase only if Brainstrike does not require Turso FTS custom indexes to live in the same MVCC-enabled database file as the primary writable store.

This readiness is a capability and planning checkpoint. It does not mean production Turso search repositories are implemented yet; the next runtime/bootstrap slices must expose the selected search ownership mode before any search tool or UI path can rely on it.

The verified capabilities are:

- Turso filesystem store opens and closes from Node.
- Basic SQL, transactions, and MVCC concurrent writes work with `BEGIN CONCURRENT` retry handling.
- Native vector storage and exact top-k distance queries work.
- Turso FTS custom indexes work in a non-MVCC database.
- Turso FTS custom indexes fail in MVCC mode with `Custom index modules are not supported in MVCC mode`.

That last item is not a blocker for the product migration by itself. It is a storage ownership constraint.

## Required Contract

The primary Turso store owns durable application state and must use MVCC for concurrent writes.

Search indexing must be explicitly owned by one of these paths:

- a separate Turso search-index store that is not MVCC-enabled and can be rebuilt from primary state,
- a Turso-compatible non-FTS search implementation with clear capability checks,
- or a future Turso runtime where FTS custom indexes work inside MVCC, proven by the capability spike.

Do not silently replace indexed search with an unbounded scan. If a search index is unavailable, the bootstrap/capability report must say so directly and the affected tool or UI path must fail closed with a diagnostic.

## Migration Touchpoints

- `packages/db/src/bootstrap/turso-capability-spike.ts`: source of truth for current Turso runtime capability evidence.
- `packages/db/src/search/hybrid-search-service.ts`: currently models FTS and vector as repository-provided sources; keep this shape, but Turso repositories must report whether FTS snippets/ranking are available.
- `packages/db/src/search/grep-search-service.ts`: current PGlite path relies on trigram candidate prefilter plus authoritative JavaScript matching. Turso must provide an indexed candidate source or expose bounded scan limits explicitly.
- `packages/db/src/repositories/drizzle/*`: current repositories are Postgres/PGlite Drizzle shaped. Turso will need dialect-specific repositories rather than SQL string compatibility.
- `packages/db/src/drizzle/migrate.ts`: current migration runner is PGlite/Postgres specific. Turso migration work should add a separate migration ledger instead of forcing existing generated SQL through libSQL.
- `apps/desktop/src/db-main.ts`: desktop remains the likely owner for filesystem Turso runtime and bootstrap reporting.

## Next Implementation Step

The Turso profile bootstrap contract now opens the primary MVCC store and returns a typed capability report with `search.ownershipMode = "split-search-index-store"` before production repository wiring. See `docs/turso-migration/profile-bootstrap.md`.

Next, introduce the Turso owner client/adapter behind the desktop DB host. Do not route query, search, or UI paths through Turso until the host returns an initialized Turso execution surface instead of the current fail-closed bootstrap-only report.
