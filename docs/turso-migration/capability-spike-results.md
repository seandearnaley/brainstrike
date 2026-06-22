# Brainstrike Turso Capability Spike

Generated: `2026-06-22T07:48:42.216Z`
Runtime: `turso` on `node` using `filesystem` persistence
Phase: `blocked`
Ready: `false`

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
| `search.fts-mvcc-compatibility` | Required | `failed` | failed to consume stmt: Parse error: Custom index modules are not supported in MVCC mode |
| `store.close` | Required | `passed` |  |

## Blocking Issues

- Required bootstrap check failed: Turso FTS custom indexes remain usable with MVCC concurrent writes enabled
- Bootstrap phase has not reached ready: blocked
