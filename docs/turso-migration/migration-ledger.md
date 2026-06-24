# Turso Migration Ledger

Last updated: 2026-06-24 on `feature/turso-migration`.

This ledger is the working map for finishing the greenfield migration from
PGlite to Turso. It is not a go/no-go memo. Treat the "Remaining Work" section
as the implementation backlog.

## Current Branch State

`feature/turso-migration` currently contains these Turso migration slices:

- #1304 `feat(db): add profile bootstrap readiness report`
- #1305 `feat(db): add bootstrap capability probe`
- #1306 `feat(db): add runtime selection seam`
- #1307 `feat(desktop): require db host bootstrap reports`
- #1308 `Add Turso capability spike`
- #1309 `Codify Turso search index ownership`
- #1310 `Add Turso profile bootstrap contract`
- #1311 `Add Turso owner client execution surface`
- #1312 `Add Turso-neutral DB capability contracts`
- #1314 `Add Turso schema baseline ledger`
- #1315 `Route desktop Turso lazy init through bootstrap`
- #1316 `Add Turso view filter preset repository`
- #1317 `Shard affected unit tests in CI`
- #1318 `Use generic DB client aliases in Turso migration consumers`
- #1319 `Shard affected coverage in PR CI`
- #1320 `Reduce PR unit shard blast radius`
- #1321 `Use generic DB hook in file explorer UI`
- #1322 `Add Turso token cache store`
- #1323 `Wire Turso token cache provider`
- #1324 `Clear Turso token cache store on DB init error`
- #1325 `Narrow DB affected CI lanes`
- #1326 `Add Turso file record repository`
- #1327 `Add Turso embedding sets repository`
- #1328 `Narrow Turso schema affected lanes`
- #1329 `Add Turso file chunk repository`
- #1330 `Add Turso chunk job enqueue seam`
- #1331 `Narrow chunk enqueue affected CI lanes`
- #1332 `Expose Turso file record repository in provider`
- #1333 `Scope affected shard builds to planned packages`
- #1334 `Add Turso managed-cache import path`
- #1335 `Split DB affected unit lanes`
- #1336 `Add Turso job queue runtime`
- #1339 `Gate Turso provider execution surfaces`

## Turso Docs Guardrail

The current Turso docs draw a hard line between embedded replicas and Turso
Sync:

- Embedded replicas serve reads from the local file, but writes go to the
  remote primary by default and are then reflected into the local replica.
- The TypeScript client reference states that `@libsql/client/web` does not
  support local file URLs.
- Turso recommends Turso Sync for new projects that need local-first writes:
  reads and writes are local, and applications call explicit `push()` /
  `pull()`.

Migration implication: do not mark a Brainstrike path "local-first Turso" just
because it can open a local `file:` libSQL database or embedded replica. Any
latency-critical write path must either use a local Turso database with explicit
sync semantics, or be documented as remote-primary/online-bound.

Primary docs consulted:

- <https://docs.turso.tech/features/embedded-replicas/introduction>
- <https://docs.turso.tech/sdk/ts/reference>
- <https://docs.turso.tech/sync/usage>

## Implemented Runtime Shape

The branch currently has a real Turso runtime seam:

- Runtime selection uses `BRAINSTRIKE_DB_RUNTIME=turso`.
- Desktop bootstrap opens the Turso primary store and reports typed
  capabilities.
- The Turso primary store uses a greenfield baseline ledger rather than the
  PGlite/Postgres migration chain.
- The desktop DB host can open a long-lived Turso owner client.
- Live query capability is explicit and currently false for Turso.
- PGlite-only query surfaces now fail closed under Turso instead of silently
  returning stale PGlite behavior.

Current Turso repository/runtime coverage:

- `embedding_sets`
- `file_records`
- `file_chunks` for non-search persistence, exposed through the desktop Turso
  provider
- `view_filter_presets`
- `file_token_cache`
- managed-cache apply/invalidate
- chunk insert plus embedding job enqueue
- job queue claim, lease, completion, failure, retry, pending-count, and delete
- selected model/embedding-set read paths exposed through provider-safe hooks

## Non-Negotiable Migration Rules

- Do not hide missing Turso functionality behind PGlite fallbacks.
- Do not replace indexed search with unbounded SQLite scans.
- Do not treat PGlite live query hooks as available under Turso.
- Do not replay the PGlite/Postgres migration chain into a Turso profile.
- Do not move embedding or built-in local LLM work into Electron main.
- Do not call generic `db` handles PGlite-compatible unless the runtime has a
  real execution client behind the generic contract.
- Every production Turso write path needs a Turso-specific test or an existing
  runtime test that proves the Turso path, not a mock-only PGlite path.

## Remaining Work

### 1. Shared Provider And Hook Gates

Many UI blockers are now centralized at the shared DB provider layer:

- `DbProvider` initializes Turso repositories for `embedding_sets`,
  `file_records`, `file_chunks`, `file_token_cache`, and
  `view_filter_presets`.
- `useBrainstrikeDbClient()` returns a raw execution handle only for
  `runtime.engine === "pglite"`.
- `useBrainstrikeLiveQuery()` remains a PGlite live-query alias.

Remaining provider work: add a generic execution-client hook with capability
metadata so callers stop treating "raw DB handle" as "PGlite". Vector, FTS, and
grep methods on the chunk repository remain explicitly unsupported until their
search slices land.

### 2. UI Snapshot Replacements For Live Queries

PGlite live queries are not part of the Turso runtime. Any UI still depending
on `useBrainstrikeLiveQuery` needs either:

- a repository-backed snapshot loader with explicit refresh triggers, or
- an explicit unsupported state with diagnostics if live updates are required.

Known production touchpoints:

- `packages/db-explorer/src/database-demo-panel.tsx`
- `packages/db-explorer/src/use-database-demo-data.ts`
- `packages/db-explorer/src/hooks/use-document-count.ts`
- `packages/db-explorer/src/hooks/use-file-collection-status.ts`
- `packages/db-explorer/src/hooks/use-collection-embedding-coverage.ts`
- `packages/preferences/src/settings/tools/unified-tools-settings.tsx`
- `packages/app-shell/src/use-quick-open-files.ts`
- `packages/app-shell/src/use-file-mentions.ts`
- `packages/app-shell/src/cost-tracking/use-cross-root-cost.ts`
- `packages/app-shell/src/use-om-segment-row.ts`

Preferred next slice: make selected collection browsing use Turso repository
snapshots for page records, counts, chunk summaries, and export. Keep live
refresh separate.

### 3. Background Indexing And Embedding Host

The hidden embedding host still uses PGlite-oriented runtime access even though
Turso has file/chunk/job primitives.

Known production touchpoints:

- `apps/desktop/src/renderer/components/embedding-host-runtime.tsx`
- `apps/desktop/src/renderer/components/embedding-worker-provider.tsx`
- `packages/app-shell/src/background-indexing/workspace-collection-sync-provider.tsx`
- `packages/vector-management/src/embedding-runtime-provider.tsx`
- `packages/vector-management/src/vector-status/use-vector-queue-state.ts`
- `packages/vector-management/src/vector-status/vector-status.tsx`

Next slice: introduce a background-indexing/vector queue service factory keyed
by runtime. Use PGlite/Electron repositories today, and Turso file-record,
file-chunk, embedding-set, and job-queue repositories for Turso. Preserve the
hidden-renderer worker boundary.

### 4. Assistant Search And Retrieval

The assistant's grep, retrieval, and hybrid search surfaces remain the largest
PGlite capability gap. The current architecture deliberately separates primary
state from search ownership because Turso custom FTS indexes do not work in the
same MVCC primary store in the current capability spike.

Known production touchpoints:

- `apps/desktop/src/assistant-server/assistant-tools.ts`
- `apps/desktop/src/assistant-server/grep-search-tool.ts`
- `apps/desktop/src/assistant-server/retrieval-tool.ts`
- `packages/db/src/search/grep-search-service.ts`
- `packages/db/src/search/hybrid-search-service.ts`
- `packages/db/src/repositories/turso-file-chunk-repository.ts`

Concrete blockers:

- `brainstrike.grepSearch` and `brainstrike.queryEmbeddingSpace` are removed
  from Turso tool maps.
- `TursoFileChunkRepository.searchSimilar()`,
  `TursoFileChunkRepository.fullTextSearch()`, and
  `TursoFileChunkRepository.findGrepCandidates()` throw.
- Retrieval selection snapshots still use PGlite/Postgres SQL, including
  `NOW()` cleanup and `UNNEST($2::text[])`.

Preferred implementation order:

1. Implement `TursoFileChunkRepository.findGrepCandidates()` against an
   explicitly bounded or indexed candidate source.
2. Implement basic Turso vector search over stored embeddings with
   `embeddingSetId`, limit, threshold, and root filtering.
3. Add a Turso selection-snapshot writer using SQLite-compatible statements.
4. Re-enable assistant tools only for capabilities proven by the repository
   and bootstrap reports.

### 5. Mastra Memory And Assistant Persistence

The desktop assistant server still initializes PGlite Mastra memory on the
hosted-provider path. This is not just a SQL swap: tool approval suspend/resume,
message hydration, run events, local-provider desktop persistence, and stream
resilience all depend on the live Mastra loop.

Known production touchpoints:

- `apps/desktop/src/assistant-server.ts`
- `packages/agent/src/pglite-mastra-memory`
- `packages/app-shell/src/assistant-memory-repository.ts`
- `packages/app-shell/src/assistant-ui-panel-wrapper.tsx`
- `packages/app-shell/src/threads-panel.tsx`
- `packages/app-shell/src/assistant-thread-tabs-workspace.tsx`

Concrete blockers:

- `createPgliteMastraMemory()` is still the server memory factory.
- `PgliteMemoryStore`, `PgliteWorkflowsStore`, and `PgliteVectorStore` are
  still the concrete stores.
- `PgliteVectorStore` creates `vector` extension, `embedding vector`, JSONB,
  and GIN indexes.
- The renderer thread repository is named and shaped around PGlite/Postgres
  SQL, including JSONB casts.

Preferred next slice: create a Turso Mastra memory adapter or a dialect-neutral
factory. First cover storage/workflows and fail closed for vector memory until
Turso vector support lands. Then replay the existing live-loop persistence and
tool-approval tests against Turso.

### 6. Schema Authority, Maintenance, And Data Migration

The Turso path is intentionally greenfield, but the final migration still needs
clear authority boundaries.

Known production touchpoints:

- `packages/db/src/schema/index.ts`
- `packages/db/src/drizzle/migrate.ts`
- `packages/db/src/migrations/index.ts`
- `packages/db/src/architecture/db-runtime-baseline.ts`
- `packages/db/src/services/scheduled-database-maintenance.ts`
- `apps/desktop/src/main.ts`

Concrete blockers:

- Canonical Drizzle schema still defines pgvector and generated
  `to_tsvector` structures.
- Numbered migration runners remain PGlite/Postgres authority.
- There is no production PGlite-to-Turso data migration path. This is
  acceptable only while the project remains greenfield and the bootstrap path
  continues to reject PGlite migration ledgers in Turso profiles.
- Scheduled DB maintenance uses Postgres-shaped SQL and needs Turso gating or a
  Turso-specific implementation.

Preferred next slice: gate scheduled DB maintenance by runtime capability before
it can run against Turso, then add a Turso maintenance implementation only for
operations that are meaningful under SQLite/Turso.

### 7. Factory Reset And Profile Cleanup

Factory reset still contains PGlite IndexedDB/OPFS cleanup details. Turso adds
filesystem profile stores and, depending on final sync mode, may add local sync
metadata.

Known production touchpoints:

- `packages/preferences/src/settings/system/factory-reset-helpers.ts`
- `packages/preferences/src/settings/system/factory-reset-panel.tsx`
- `apps/desktop/src/desktop-reset-platform.ts`

Preferred next slice: add Turso profile store deletion to desktop reset once
the final Turso store paths and sync metadata paths are stable.

### 8. Dependency And Build Cleanup

PGlite packages, Vite aliases, type shims, and WASM packaging remain necessary
while web/PGlite and compatibility paths exist. Final removal should happen
only after the runtime audit proves no production path imports PGlite.

Known production touchpoints:

- `apps/desktop/package.json`
- `apps/desktop/vite.config.mts`
- `packages/db/src/wasm-loader.ts`
- `packages/build-utils`
- `apps/desktop/src/types/pglite*.d.ts`

Preferred next slice: keep these until the final runtime removal pass;
premature cleanup would break current PGlite-mode tests and web paths without
advancing Turso parity.

## Suggested Implementation Order

1. Collection/import slice: make db-explorer manual import and collection
   browser snapshot paths work without live query.
2. Vector queue slice: wire `TursoJobQueue` into vector-management status and
   actions with polling snapshots.
3. Assistant memory slice: add Turso Mastra storage/workflow memory and prove
   the live Mastra loop against it.
4. Search slice: add Turso grep/vector repository methods, then semantic search
   and assistant retrieval.
5. Live-query strategy slice: either implement a Turso live-query source over
   IPC or formalize snapshot+refresh alternatives per UI surface.
6. Reset/maintenance slice: Turso-aware factory reset, profile cleanup, and
   scheduled maintenance gates.
7. Final runtime audit: remove or isolate leftover PGlite-only production
   imports, dependencies, Vite aliases, and type shims.

## Verification Policy

Each implementation PR should include:

- A failing Turso-specific test before production code.
- Targeted package tests for the touched surface.
- `pnpm lint && pnpm type-check && pnpm build && pnpm test` before push.
- PR watcher loops for checks, comments, and independent review.
- Merge back into `feature/turso-migration` only after latest-head checks are
  green and all blocking comments are answered/resolved.
