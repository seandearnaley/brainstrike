# Mastra Code UI LibSQL Reverse Engineering

Date: 2026-06-21

Source reviewed:

- Repository: [mastra-ai/mastra-code-ui](https://github.com/mastra-ai/mastra-code-ui)
- Commit: [`c254853f6c6e52f78b22ca056e733a07e113ebf8`](https://github.com/mastra-ai/mastra-code-ui/commit/c254853f6c6e52f78b22ca056e733a07e113ebf8)
- Local clone used for inspection: `/tmp/mastra-code-ui`
- Installed packages from the locked install:
  - `mastracode@0.5.1`
  - `@mastra/core@1.9.0`
  - `@mastra/libsql@1.6.3`
  - `@mastra/memory@1.6.0`
  - `@libsql/client@0.15.15`
  - `libsql@0.5.22`

## Executive Summary

`mastra-code-ui` is a useful coding-agent reference for how a Mastra Harness can be wired to LibSQL-backed storage, memory, threads, and resource scoping. It is not direct proof that Brainstrike can replace PGlite with the new `tursodatabase/turso` engine.

The implementation path is:

1. The Electron app calls `createMastraCode({ cwd, extraTools })`.
2. The `mastracode` package resolves a project/resource identity and storage config.
3. It creates one `LibSQLStore`.
4. That same store is passed into Mastra `Memory` and `Harness`.
5. Harness streams agent turns with `{ thread, resource }` memory scope.

Remote Turso is not a special storage mode in this code. It is a LibSQL URL plus optional auth token through `@libsql/client`. The local default is file-backed LibSQL, not the new `@tursodatabase/database` package.

For Brainstrike, the main takeaway is architectural, not translational: Mastra persistence can be isolated behind a store injected into Harness/Memory, but Brainstrike should not copy Mastra Code UI's fallback behavior, imperative migrations, or silent empty-result paths.

## What Was Actually Verified

The pass used three tracks:

- app-level Electron wiring in `/tmp/mastra-code-ui/src`,
- installed `mastracode` package internals in `/tmp/mastra-code-ui/node_modules/mastracode`,
- installed `@mastra/libsql` internals plus a small runtime probe against a local file database.

The runtime probe initialized `LibSQLStore`, inspected the created SQLite schema, created a `LibSQLVector` index, upserted one vector, and queried it successfully. This verifies package behavior in a Node process with the installed package set. It does not verify Electron packaging, browser execution, the new Turso engine, or Brainstrike-scale indexing.

## App-Level Wiring

The Electron app is thin:

- `src/electron/main.ts` imports `createMastraCode` from `mastracode`.
- It calls `createMastraCode` with `cwd` and two extra tools: `navigate-browser` and `computer`.
- It receives `harness`, `mcpManager`, `hookManager`, `authStorage`, `resolveModel`, and `storageWarning`.
- It logs `storageWarning` if one is returned.
- It manages session lifecycle, project/worktree switching, PTYs, MCP startup, browser tooling, and UI IPC.

Important boundary: the app repo itself does not instantiate `LibSQLStore`. The exact database construction, Mastra memory construction, resource scoping, and Harness wiring live in the published `mastracode` package.

The app contains storage helper code that mirrors the README's storage story:

- `MASTRA_DB_PATH` can override the local file path.
- `MASTRA_DB_URL` plus `MASTRA_DB_AUTH_TOKEN` can select a remote LibSQL URL.
- project `.mastracode/database.json` and global `~/.mastracode/database.json` can configure storage.
- local default paths live under platform app-data directories.

However, from app source alone this helper code is not the final proof of storage wiring because `main.ts` delegates to `createMastraCode()` without passing a storage object. The installed package implements the real resolution path.

## `createMastraCode()` Internals

The installed ESM implementation is in:

- `/tmp/mastra-code-ui/node_modules/mastracode/dist/chunk-WKPHD54B.js`
- `/tmp/mastra-code-ui/node_modules/mastracode/dist/chunk-SM3QCOA7.js`

The relevant flow:

1. Detect project identity.
2. Apply an optional `resourceId` override.
3. Resolve storage from explicit config or config discovery.
4. Create one storage object.
5. Build dynamic `Memory` from that storage.
6. Create the code agent and subagents.
7. Construct `Harness` with `resourceId`, `storage`, `memory`, `stateSchema`, subagents, modes, workspace, model resolution, and thread locks.
8. Return the Harness and related managers.

The resource ID is the app-level partition key. Harness creates and lists threads scoped by the current resource unless explicitly asked for all resources. This is the most relevant pattern for Brainstrike assistant persistence: keep the app/resource identity outside model request text and thread it through the storage/memory layer.

The store is not injected into individual tool request context. Harness and Memory own persistence, while tools receive contextual IDs such as `threadId` and `resourceId`.

## Storage Resolution

The package-level storage resolution priority is:

1. explicit config passed to `createMastraCode`,
2. environment/global settings,
3. project `.mastracode/database.json`,
4. global `~/.mastracode/database.json`,
5. local file-backed LibSQL default.

For LibSQL, storage construction is:

- `new LibSQLStore({ id: "mastra-code-storage", url, authToken })`

Remote Turso-style usage is therefore a URL/auth-token configuration over `@libsql/client`. There is no `@tursodatabase/database` use in this inspected path.

PostgreSQL support exists, but it falls back to local LibSQL with a warning when connection information is missing or the PG connection fails. That is an explicit anti-pattern for Brainstrike. Brainstrike's storage migration must fail closed when the selected engine cannot be opened or validated.

## Memory And Observational Memory

`mastracode` builds `new Memory({ storage, options: { observationalMemory: ... } })` from the same storage object passed to Harness.

Observational memory scope comes from:

1. `MASTRA_OM_SCOPE`,
2. project/global database config,
3. default `thread`.

One implementation detail should not be copied: the package keeps a module-global memory cache keyed by observation threshold, reflection threshold, and OM scope, not by storage instance. That is convenient for their app, but it is unsafe as a general Brainstrike pattern because Brainstrike has explicit profile/workspace/state ownership boundaries.

## Thread Locks

`mastracode` passes thread lock callbacks into Harness. The implementation is PID-file based under app-data `locks`: check existing PID liveness, throw if alive, otherwise write the current PID.

That is not equivalent to an atomic DB lease or an exclusive filesystem create. It is sufficient as a local coding-agent guard, but not a pattern to reuse for Brainstrike's durable embedding queue or any correctness-critical state transition.

## `@mastra/libsql` Store Behavior

`@mastra/libsql@1.6.3` exports a composite `LibSQLStore` and `LibSQLVector`. It depends on `@libsql/client`, not the new `@tursodatabase/database` package.

The store supports either:

- `{ id, url, authToken }`, or
- `{ id, client }`.

The store URL shorthand does not expose `syncUrl`, `syncInterval`, encryption, or offline options. `LibSQLVector` exposes `syncUrl` and `syncInterval`, but the composite store path does not.

The store creates domain stores for Mastra concepts such as memory, workflows, observability, agents, datasets, experiments, MCP, workspaces, skills, blobs, and scores.

Schema management is imperative:

- domain stores call `CREATE TABLE IF NOT EXISTS`,
- drift is handled with `ALTER TABLE ADD COLUMN`,
- `jsonb` maps to SQLite `TEXT`,
- timestamps map to `TEXT`,
- booleans map to integer-like storage,
- there is no Brainstrike-style numbered migration ledger.

This is a major difference from Brainstrike's migration discipline. If Brainstrike uses Mastra's adapter directly, it should be isolated to Mastra-owned tables or wrapped with explicit startup validation. It should not become the general app schema migration mechanism.

## Actual Runtime Probe Schema

The local probe initialized `LibSQLStore` and created tables including:

- `mastra_threads`
- `mastra_messages`
- `mastra_resources`
- `mastra_observational_memory`
- workflow, agent, workspace, scorer, dataset, experiment, and related Mastra tables

Representative observed DDL:

```sql
CREATE TABLE mastra_messages (
  id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL,
  content TEXT NOT NULL,
  role TEXT NOT NULL,
  type TEXT NOT NULL,
  createdAt TEXT NOT NULL,
  resourceId TEXT
)
```

```sql
CREATE TABLE mastra_threads (
  id TEXT PRIMARY KEY,
  resourceId TEXT NOT NULL,
  title TEXT NOT NULL,
  metadata TEXT,
  createdAt TEXT NOT NULL,
  updatedAt TEXT NOT NULL
)
```

```sql
CREATE TABLE mastra_observational_memory (
  id TEXT PRIMARY KEY,
  lookupKey TEXT NOT NULL,
  scope TEXT NOT NULL,
  resourceId TEXT,
  threadId TEXT,
  activeObservations TEXT NOT NULL,
  metadata TEXT,
  createdAt TEXT NOT NULL,
  updatedAt TEXT NOT NULL
)
```

The exact OM table has additional buffering/reflection fields in the installed package; the key point is that OM lookup is indexed by a `lookupKey` derived from `thread:<threadId>` or `resource:<resourceId>`.

## Vector Behavior

`LibSQLVector` creates tables with:

```sql
CREATE TABLE <index> (
  id SERIAL PRIMARY KEY,
  vector_id TEXT UNIQUE NOT NULL,
  embedding F32_BLOB(<dimension>),
  metadata TEXT DEFAULT '{}'
)
```

It then creates:

```sql
CREATE INDEX <index>_vector_idx ON <index> (libsql_vector_idx(embedding))
```

Upsert uses `vector32(?)` and `ON CONFLICT(vector_id) DO UPDATE` inside an interactive write transaction.

Query behavior in the installed package is important:

- `queryVector` is required.
- metadata-only vector query is rejected.
- similarity is hardcoded as cosine through `vector_distance_cos`.
- filter predicates are JSON expressions over `metadata`.
- direct regex filters throw; regex is not implemented in this inspected package.
- the query orders by computed similarity and limits results.

Although the package creates a `libsql_vector_idx`, this inspection is not enough to prove the index accelerates Brainstrike's workload. Brainstrike still needs `EXPLAIN`/benchmark evidence on realistic chunk counts and dimensions.

## Transaction And Retry Behavior

The libSQL client exposes individual `execute`, atomic `batch`, and interactive transactions. Write transactions map to a write-locking mode.

`@mastra/libsql` wraps many write helpers with bounded retries for lock-like errors. The vector path also uses write transactions and retry handling.

This is useful, but it is not enough for Brainstrike's durable queue. Brainstrike queue correctness depends on lease ownership, stale-worker rejection, atomic embedding writes plus job completion, and observable bounded conflict handling. Those properties must be designed and tested directly against the selected runtime.

## Silent Degradation To Reject

Several inspected paths are not compatible with Brainstrike's no-silent-degradation rule:

- malformed or unreadable database config can be ignored by returning `null`,
- PostgreSQL failure can fall back to local LibSQL with a warning,
- some memory list operations catch storage errors and return empty results,
- thread delete/update operations are not consistently transactional,
- local file WAL/busy-timeout setup is attempted asynchronously and warning-only.

These choices may be acceptable for a coding-agent app trying to keep running. Brainstrike should reject them for the migration. Missing storage capability, failed migration, failed memory read, failed vector index creation, or failed queue operation must be visible and typed.

## What Transfers To Brainstrike

Useful patterns:

- keep the app shell thin around a storage-backed agent runtime,
- inject one explicit store into Mastra Harness and Memory,
- use `resourceId` as a durable partition key for project/profile/workspace scope,
- keep thread/resource IDs in Harness/Memory context rather than model text,
- initialize MCP/tools around the Harness lifecycle, not inside DB code,
- treat remote LibSQL/Turso URLs as configuration over the same store interface,
- run a concrete local probe to inspect real DDL instead of trusting README claims.

## What Does Not Transfer

Do not copy these as-is:

- treating `@mastra/libsql` as a full PGlite replacement for Brainstrike app state,
- using imperative Mastra table creation as Brainstrike's app migration ledger,
- relying on LibSQL remote URL support as proof of new Turso Database concurrency,
- using PID-file locks for DB-critical leases,
- returning empty memory/thread lists after storage errors,
- falling back from a failed selected backend to a different local backend,
- assuming `libsql_vector_idx` is used effectively without a workload benchmark,
- assuming file-backed LibSQL can run in Brainstrike's browser-local path.

## Impact On Migration Plan

Add a Mastra-specific baseline step before the Turso capability spike:

- verify current Brainstrike Mastra memory contracts,
- prototype `@mastra/libsql` only as a Mastra persistence adapter, not the whole app DB,
- compare direct `@mastra/libsql` use against a Brainstrike-owned Mastra storage adapter,
- decide whether Mastra-owned tables can live in a separate LibSQL/Turso database or must share the main Brainstrike DB,
- make every fallback in the inspected reference fail-closed if adopted.

This pass strengthens the migration plan rather than reversing it. The correct next step is still Phase 0 capability work against the actual target packages and runtimes. `mastra-code-ui` narrows the Mastra/Harness integration questions, but it does not answer Brainstrike's PGlite replacement questions for schema, queue, search, live invalidation, browser storage, or new-engine concurrency.
