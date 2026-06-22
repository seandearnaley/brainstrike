# Brainstrike Turso Capability Spike

Generated: `2026-06-22T08:48:32.597Z`
Runtime: `turso` on `node` using `filesystem` persistence
Phase: `ready`
Ready: `true`

## Package Versions

- `@libsql/client`: `0.17.4`
- `@tursodatabase/database`: `0.6.1`
- `@tursodatabase/sync`: `0.6.1`

| Check | Requirement | Status | Message |
| --- | --- | --- | --- |
| `package.tursodatabase-database` | Required | `passed` | Installed @tursodatabase/database@0.6.1. |
| `package.tursodatabase-sync` | Required | `passed` | Installed @tursodatabase/sync@0.6.1. |
| `package.libsql-client` | Required | `passed` | Installed @libsql/client@0.17.4. |
| `package.drizzle-libsql-adapter` | Required | `passed` | Resolved drizzle-orm/libsql. |
| `store.open` | Required | `passed` |  |
| `sql.crud` | Required | `passed` |  |
| `sql.transaction` | Required | `passed` |  |
| `sql.concurrent-writes-mvcc` | Required | `passed` |  |
| `search.vector-distance` | Required | `passed` |  |
| `search.fts-index` | Required | `passed` |  |
| `search.fts-mvcc-compatibility` | Optional | `failed` | failed to consume stmt: Parse error: Custom index modules are not supported in MVCC mode |
| `architecture.split-search-index` | Required | `passed` | Turso FTS and MVCC are both available but cannot share one MVCC-enabled database file; Brainstrike must use an explicitly owned search-index store or equivalent non-FTS search implementation. |
| `store.close` | Required | `passed` |  |
