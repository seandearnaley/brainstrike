# Turso Bootstrap Research Orchestration

Date: 2026-06-21

Status: specialist research synthesis. Ten read-only explorer agents inspected the current Brainstrike codebase and the Turso migration notes. No code was changed by the agents.

Use this with:

- `docs/turso-migration/2026-06-20-pglite-to-turso-exploration.md`
- `docs/turso-migration/2026-06-21-mastra-code-ui-libsql-reverse-engineering.md`
- `docs/superpowers/plans/2026-06-21-turso-bootstrap-contract.md`

## Executive Position

Brainstrike should improve bootstrapping before attempting the Turso storage migration. The best next architecture move is a strict profile bootstrap contract backed by a repeatable capability probe and a typed diagnostics report.

The current system already has strong pieces: strict PGlite extension loading, desktop DB profile ownership, stale migration ledger rejection, workspace index self-heal, reset diagnostics, and real Mastra persistence tests. The missing piece is a single readiness authority. Today a profile can look connected while model catalog, assistant memory, workspace index, invalidation, or runtime capability is only partially initialized.

The new bootstrap rule should be:

> A Brainstrike profile is not ready until one authoritative DB owner has opened the selected local runtime, proved required capabilities, migrated the schema, seeded required system data, initialized assistant memory and model catalog checks, bootstrapped workspace index state when enabled, and published a sanitized startup diagnostics report.

No fallback from Turso to PGlite. No fallback from desktop IPC to direct renderer DB ownership. No empty-result storage reads after bootstrap failures. No polling-only live invalidation marked as ready.

## Agent Roster

| Agent | Research thread | Result |
| --- | --- | --- |
| Fermat | Bootstrap capability probe | Proposed a Phase 0 CLI plus JSON/Markdown report covering engine open/close, migration, vector, FTS/grep, transactions, queue, invalidation, runtime split, assistant smoke, and package versions. |
| Peirce | Profile bootstrap contract | Defined readiness phases and argued for a single `profileBootstrap` snapshot instead of scattered readiness states. |
| Meitner | Mastra bootstrap isolation | Recommended Brainstrike-owned Mastra adapter in the main DB as the default path; separate LibSQL/Turso Mastra DB only as an experiment with full lifecycle ownership. |
| Halley | Fail-closed config loading | Inventoried fallback/default paths that can mask failed storage/bootstrap state. |
| Anscombe | Schema baseline generator | Recommended a Turso-native baseline schema and new schema ledger instead of historical migration porting. |
| Helmholtz | Boot-time diagnostics | Proposed a typed `StartupDiagnosticsReport` and privacy constraints. |
| Jason | Seed data strategy | Classified migration seeds, app seeds, preference defaults, and runtime-derived state. |
| Bohr | Reset and recovery | Proposed explicit reset/recovery actions and a profile generation barrier. |
| Cicero | Electron/web split | Confirmed the common contract plus runtime-specific ownership model. |
| Nash | Bootstrap observability tests | Proposed a test matrix asserting declared capabilities rather than just app startup. |

## Cross-Agent Conclusions

### 1. Bootstrap Is A Product Contract

Current startup has multiple readiness concepts:

- `DbProvider.ready` can mean the provider mounted, not that the database is usable.
- Desktop DB host `init` returns only `{ initialized: true }`.
- Model registry failures can be stored as state errors rather than blocking broader startup.
- Assistant memory tables are lazily initialized on repository use.
- Workspace index bootstrap runs after preferences/repositories exist.
- Diagnostics are distributed across DB, desktop, queue, reset, and app-shell surfaces.

The Turso migration should replace this with one profile bootstrap verdict:

- `uninitialized`
- `resolving-profile`
- `opening-store`
- `probing-capabilities`
- `migrating-schema`
- `seeding-system-data`
- `hydrating-preferences`
- `initializing-model-catalog`
- `initializing-assistant-memory`
- `initializing-workspace-index`
- `ready`
- `blocked`
- `failed`

`blocked` is for user-actionable requirements. `failed` is for unrecoverable startup failure. `retrying` can exist internally for bounded lock/busy recovery, but it must not report ready.

### 2. The Capability Probe Should Gate Phase 0

The probe should be a separate CLI and testable library, not a side effect of app startup.

Proposed files:

- `packages/db/scripts/bootstrap-capability-probe.mts`
- `packages/db/src/bootstrap-probe/report.ts`
- `packages/db/src/bootstrap-probe/engine-open-close.ts`
- `packages/db/src/bootstrap-probe/migration-ledger.ts`
- `packages/db/src/bootstrap-probe/vector-capability.ts`
- `packages/db/src/bootstrap-probe/fts-grep-capability.ts`
- `packages/db/src/bootstrap-probe/transaction-concurrency.ts`
- `packages/db/src/bootstrap-probe/queue-race.ts`
- `packages/db/src/bootstrap-probe/invalidation.ts`
- `packages/db/src/bootstrap-probe/runtime-split.ts`
- `packages/db/src/bootstrap-probe/assistant-memory-smoke.ts`
- `packages/db/src/bootstrap-probe/package-versions.ts`

Required probe behavior:

- explicit selected engine, no fallback engine;
- non-zero exit for any required `fail` or `unknown`;
- JSON report is the source of truth;
- Markdown report is rendered from the JSON;
- all timings, package versions, runtime surface, command, and blockers are recorded;
- no secret, content, embedding, path, prompt, or raw DB row leaks in shareable mode.

### 3. Desktop And Web Share A Contract, Not An Implementation

Desktop should keep the current ownership shape:

- Electron main coordinates lifecycle, profile/root resolution, hidden hosts, diagnostics, and shutdown order.
- Electron utility process owns the DB engine.
- Visible renderer and hidden embedding/LLM hosts talk through preload IPC.
- Renderers must not open a second desktop DB owner.

Web should keep a separate runtime implementation:

- browser worker owns the local persistent DB;
- IndexedDB/OPFS/local persistence must be proven for the selected Turso package;
- reset and invalidation semantics must account for browser storage deletion and reload persistence.

The shared layer should be a bootstrap contract:

- runtime descriptor,
- storage descriptor,
- owner descriptor,
- capability report,
- migration/schema status,
- seed status,
- invalidation strategy,
- diagnostics and reset hooks.

### 4. Mastra Should Stay In The Main DB Unless Proven Otherwise

The current assistant memory repository creates Mastra memory schema plus Brainstrike run/event tables with foreign keys into `mastra_threads`. Hydration collapses Mastra snapshot rows, dedupes tool calls, re-times tool invocations from run events, and interleaves run events.

Splitting Mastra storage creates split-brain risk unless Brainstrike moves the run/event tables and repository reads with it. The safer default path is:

- keep Mastra tables in the main profile DB;
- port the existing PGlite Mastra adapter shape to the Brainstrike DB contract;
- run existing live Mastra loop tests unchanged against the new store.

Direct `@mastra/libsql` remains useful as an experiment, not as the default. If tested, it must be wrapped to fail closed on storage errors and must not own Brainstrike app migrations.

### 5. Turso Baseline Should Be Fresh, Not A Historical Port

The schema is currently deeply Postgres/PGlite-specific: `pg-core`, `jsonb`, `uuid`, `timestamptz`, arrays, `tsvector`, pgvector, generated Postgres expressions, `FOR UPDATE SKIP LOCKED`, and Postgres FTS.

Because Brainstrike is greenfield, the Turso path should generate a final baseline schema:

- new Turso/SQLite schema module;
- new schema ledger such as `__brainstrike_schema_migrations`;
- no replay of transitional PGlite migrations;
- deterministic seed steps for provider/model catalog and default presets;
- stale PGlite or unknown Turso ledger means reset-required, not migration guessing.

Acceptance checks for generated SQL:

- no `CREATE EXTENSION`;
- no `jsonb`;
- no `uuidv7()::text`;
- no `tsvector`;
- no `GIN`;
- no `pg_trgm`;
- no PL/pgSQL;
- no Postgres arrays;
- no `FOR UPDATE SKIP LOCKED`.

### 6. Seeds Must Be Classified

Fresh profile data should be minimal.

Migration seeds:

- provider/model catalog final rows;
- default view filter presets;
- schema ledger metadata.

App seeds:

- workspace-index embedding set when background indexing is enabled and no managed collection exists.

Preference defaults:

- assistant selected model/provider settings;
- assistant memory defaults;
- embedding preferences;
- background indexing preferences;
- vector UI active embedding set pointer.

Runtime-derived state that should start empty:

- roots;
- file records;
- chunks;
- token cache;
- job queue rows;
- assistant threads/messages/resources;
- observational memory;
- assistant run events;
- local runtime model discovery;
- downloaded model flags;
- backfill progress;
- collection stats except a zeroed workspace-index stats row.

Open seed questions:

- whether `ollama` and `lmstudio` should get DB provider rows or remain runtime-only;
- why embedding preferences default to `jinaai/jina-embeddings-v2-base-code` while workspace indexing uses MiniLM;
- whether Mastra memory/run-event schema becomes normal baseline schema or remains repository initialized.

### 7. Reset Needs Named Operations

The current UI has factory reset and narrower clear-data paths. Turso bootstrap should make reset operations explicit:

- **Factory Reset Device:** delete active profile DB, queues, indexed data, model catalog toggles, Mastra memory, assistant runs/events, token caches, stored folder handles, renderer storage, Electron settings, API keys, tool prefs, runtime/model caches. Preserve logs, reset diagnostics, quarantined backups, and other profiles.
- **Recover Corrupt Profile DB:** preserve API keys, preferences, logs, stored folder handles, and model artifacts; quarantine corrupt profile DB; create fresh DB; migrate; reseed catalog; show a visible rebuilt notice.
- **Clear Workspace Index:** delete roots, file records, chunks, embedding sets, index stats, and workspace jobs; reset workspace-index prefs/status; preserve API keys, assistant preferences, Mastra memory, general UI prefs, and source files.
- **Forget Stored Folders:** clear File System Access handles and restore state; do not delete indexed DB rows unless paired with workspace-index clear.

Turso reset also needs a profile generation barrier. Every worker/job write must carry the active profile generation so stale workers cannot write vectors, queue completions, or sync state after reset.

### 8. Fail-Closed Config Needs A Boundary

Not every fallback is bad. Optional UI sensors can return partial data. But anything claiming DB, indexing, search, or assistant readiness must be fail-closed.

High-risk fallback/default patterns found:

- desktop mode can fall from requested IPC to direct PGlite when bridge is missing;
- `DbProvider` can set `ready=true` after initialization failure;
- browser PGlite storage has OPFS/IDB convenience fallback;
- migration helpers can return `{ success: false }` instead of throwing;
- missing live query source can return empty rows;
- embedding config falls back to a default model;
- provider/model preferences fall back before DB registry loads;
- workspace indexing can look idle when no bootstrap work happened.

Good model:

- assistant resilience config defaults only when absent and throws on malformed present values.

The boundary should be a typed `BootstrapConfigError` with codes:

- `engine`
- `profile`
- `rootPath`
- `capability`
- `migration`
- `queue`
- `live`
- `providerCatalog`
- `workspaceIndex`

### 9. Diagnostics Must Be Typed And Sanitized

The proposed startup diagnostics report should be a typed, versioned object. A compact shape:

```ts
interface StartupDiagnosticsReport {
  reportVersion: 1;
  collectedAt: string;
  runtime: {
    platform: 'desktop' | 'web';
    selectedPackage: {
      kind: 'pglite' | 'turso-database' | 'turso-sync' | 'libsql-client';
      packageName: string;
      packageVersion: string;
      selectionSource: 'build' | 'runtime-config' | 'capability-spike';
    };
  };
  database: {
    owner: 'electron-utility-process' | 'browser-worker';
    profile: string | null;
    schema: {
      expectedVersion: number;
      appliedVersion: number;
      pending: readonly string[];
      staleLedger: boolean;
    };
    capabilities: {
      vector: CapabilityResult;
      fts: CapabilityResult;
      grep: CapabilityResult;
      transactions: CapabilityResult;
      invalidation: CapabilityResult;
      queueLeases: CapabilityResult;
    };
  };
  mastra: {
    storeKind: 'pglite-brainstrike' | 'libsql-mastra' | 'turso-brainstrike';
    tablesReady: boolean;
    vectorStoreReady: boolean;
    workflowStoreReady: boolean;
    messageDialect: 'mastra-v2-parts';
  };
  workspaceIndex: {
    enabled: boolean;
    managedCollectionBound: boolean;
    defaultSetReady: boolean;
  };
  privacy: {
    mode: 'local-ui' | 'shareable';
    redactedFields: readonly string[];
  };
  errors: readonly BootstrapDiagnosticError[];
}

interface CapabilityResult {
  status: 'ok' | 'failed' | 'unknown';
  required: boolean;
  strategy: string;
  reason?: string;
}

interface BootstrapDiagnosticError {
  code: string;
  stage: string;
  message: string;
}
```

The shareable report must exclude raw paths, filenames, file content, embeddings, raw DB rows, prompts, provider keys, and stable path/content hashes.

### 10. Observability Tests Should Assert Capabilities

Do not add only more "app launches" tests. Add a startup capability report and test that report.

Test layers:

- unit contract tests for required capability status;
- DB provider tests for `initializationStatus` and failed capabilities;
- desktop DB main tests for missing extensions/migration/sync failure;
- DB host protocol tests requiring init to return the startup report;
- real-engine integration tests for current PGlite and future Turso;
- workspace bootstrap tests declaring `workspaceIndex.defaultSet=ok`;
- assistant memory tests declaring memory tables/run-event/vector readiness;
- diagnostics tests proving fallback data cannot synthesize overall `ok`;
- web smoke E2E asserting worker-owned capabilities;
- desktop smoke E2E asserting utility-process-owned capabilities.

## Recommended Next Work

Do these in order:

1. Implement the typed startup report and fail-closed bootstrap verdict on current PGlite first.
2. Add the capability probe CLI and report renderer.
3. Extend desktop/web startup tests to assert the report.
4. Add schema baseline generator research code for Turso only after package selection is proven.
5. Run the Turso package capability spike and compare `@tursodatabase/database`, `@tursodatabase/sync`, and `@libsql/client`.

This intentionally improves bootstrapping before the actual storage conversion. It also gives the team a better failure surface if the Turso spike exposes a blocker in vector search, queue transactions, browser storage, sync, or invalidation.

## Source Links

- [Turso TypeScript SDK quickstart](https://docs.turso.tech/sdk/ts/quickstart)
- [Turso TypeScript SDK reference](https://docs.turso.tech/sdk/ts/reference)
- [Turso sync usage](https://docs.turso.tech/sync/usage)
- [Turso embedded replicas](https://docs.turso.tech/features/embedded-replicas/introduction)
- [Turso multiprocess access](https://docs.turso.tech/sql-reference/multiprocess-access)
- [Turso extensions](https://docs.turso.tech/sql-reference/extensions)
- [Turso sync conflict resolution](https://docs.turso.tech/sync/conflict-resolution)
- [Turso CDC](https://docs.turso.tech/tursodb/cdc)
