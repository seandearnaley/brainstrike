# PGlite to Turso Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` for parallel implementation slices or `superpowers:executing-plans` for single-thread execution. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Convert Brainstrike's local-first storage platform from PGlite/Postgres semantics to a Turso/libSQL/SQLite-compatible architecture while preserving queue correctness, search quality, assistant persistence, live UI reactivity, and local-first latency.

**Architecture:** Build a strict Brainstrike DB contract first, prove the selected Turso runtime against real Electron and browser surfaces, then port schema, queue, search, live invalidation, desktop/web runtime wiring, and assistant memory as separate slices. Keep the desktop DB owner boundary during the migration. Treat remote/cloud sync as replication, not the hot path.

**Tech Stack:** Turso Database packages or libSQL package selected by Phase 0, Drizzle SQLite/Turso adapter, Electron DB host/utility process, browser worker/local storage, Brainstrike embedding worker, Mastra memory, Vitest, Playwright/Electron smoke verification.

## Non-negotiable Constraints

- No fallback from Turso to PGlite in migrated runtime code.
- No silent degradation from vector/FTS/indexed grep to unbounded scan.
- No remote round trip in latency-critical workspace indexing, retrieval, or assistant memory paths.
- No queue implementation is acceptable until it proves no double-claim and no stale-lease completion against the real Turso runtime.
- No live UI replacement may be polling-only unless the product explicitly accepts that regression in writing.
- Keep desktop DB ownership centralized until the Turso-backed app is correct and green.
- Do not claim Turso solves concurrency until Phase 0 measures the selected package in Brainstrike's runtime.

## Phase 0: Turso Capability Spike

**Objective:** Choose the runtime package and prove required capabilities before application porting.

- [ ] Complete the bootstrap contract groundwork first:
  - [ ] read `docs/turso-migration/2026-06-21-bootstrap-research-orchestration.md`,
  - [ ] implement or explicitly defer `docs/superpowers/plans/2026-06-21-turso-bootstrap-contract.md`,
  - [ ] require the selected Turso package to plug into the same profile bootstrap report instead of creating a second readiness path.
- [ ] Fold the Mastra Code UI reverse-engineering baseline into the spike:
  - [ ] read `docs/turso-migration/2026-06-21-mastra-code-ui-libsql-reverse-engineering.md`,
  - [ ] treat `@mastra/libsql` as a Mastra/Harness reference, not proof of new Turso engine capability,
  - [ ] prototype `@mastra/libsql` only for Mastra-owned persistence if the team wants a direct adapter comparison,
  - [ ] compare direct `@mastra/libsql` against a Brainstrike-owned Mastra storage adapter over the new DB contract,
  - [ ] document every inspected Mastra fallback that must become fail-closed in Brainstrike.
- [ ] Create an isolated branch/worktree for Turso runtime probes.
- [ ] Install candidate package set without touching production code paths:
  - [ ] `@tursodatabase/database`
  - [ ] `@tursodatabase/sync`
  - [ ] `@libsql/client` only as the mature fallback candidate to compare, not as a hidden runtime fallback.
- [ ] Create a minimal Turso database open/close probe for Node/Electron main or utility-process context.
- [ ] Create a browser bundle/local-persistence probe for the chosen package.
- [ ] Prove Drizzle adapter behavior:
  - [ ] schema declaration,
  - [ ] migration execution,
  - [ ] insert/select/update/delete,
  - [ ] transactions,
  - [ ] raw SQL for vector/FTS DDL.
- [ ] Prove transaction/concurrency behavior:
  - [ ] concurrent readers,
  - [ ] concurrent writers,
  - [ ] write conflict behavior,
  - [ ] transaction timeout/error shape,
  - [ ] retry requirements.
- [ ] Prove vector support:
  - [ ] vector insert format,
  - [ ] exact or ANN query syntax,
  - [ ] index creation,
  - [ ] dimensions matching Brainstrike model catalog,
  - [ ] filtered top-k behavior.
- [ ] Prove FTS/grep support:
  - [ ] FTS table/index creation,
  - [ ] rank and snippet/highlight behavior,
  - [ ] substring candidate prefilter,
  - [ ] case-sensitive behavior,
  - [ ] regex prefilter fallback is explicit and bounded.
- [ ] Prove live invalidation candidate:
  - [ ] CDC if available,
  - [ ] mutation-event invalidation,
  - [ ] query-key refetch timing after commit.
- [ ] Prove packaging:
  - [ ] Electron dev,
  - [ ] Electron packaged smoke if needed,
  - [ ] web dev/build,
  - [ ] native/WASM artifact handling.
- [ ] Write `docs/turso-migration/capability-spike-results.md` with exact package versions, commands, results, and blockers.

**Exit Gate:** The team has one selected hot-path local runtime and a written capability matrix. Any unsupported required capability blocks Phase 1 until resolved or explicitly redesigned.

## Phase 1: DB Contract Boundary

**Objective:** Remove PGlite-shaped assumptions from application-facing DB code.

- [ ] Define `BrainstrikeDbClient` or equivalent with:
  - [ ] `query`,
  - [ ] `execute`,
  - [ ] `transaction`,
  - [ ] `batch` or bulk input primitive,
  - [ ] `subscribe`/`invalidate`,
  - [ ] `maintenance`,
  - [ ] `diagnostics`.
- [ ] Define transaction modes and error contracts.
- [ ] Define mutation invalidation payloads.
- [ ] Replace repository imports of PGlite-specific types with contract types.
- [ ] Add adapter contract tests that can run against PGlite during transition and Turso after Phase 2.
- [ ] Keep behavior unchanged on PGlite until Turso adapter is ready.

**Exit Gate:** No app repository requires a PGlite concrete type for normal query/mutation/transaction work.

## Phase 2: Turso Schema And Migration Baseline

**Objective:** Build a Turso-native schema baseline.

- [ ] Decide greenfield reset policy and document it.
- [ ] Create Turso schema module using SQLite/Turso Drizzle primitives.
- [ ] Port core tables:
  - [ ] roots,
  - [ ] file records,
  - [ ] file chunks,
  - [ ] embedding sets,
  - [ ] job queue,
  - [ ] model catalog,
  - [ ] token caches,
  - [ ] assistant threads/runs/events,
  - [ ] Mastra memory tables.
- [ ] Replace Postgres-specific fields:
  - [ ] UUID defaults -> app-generated text IDs,
  - [ ] JSONB -> JSON text policy,
  - [ ] arrays -> join tables or JSON arrays,
  - [ ] timestamptz -> ISO text or integer epoch,
  - [ ] tsvector -> Turso/FTS table,
  - [ ] vector -> BLOB/vector table policy.
- [ ] Create Turso migration runner and migration metadata table.
- [ ] Remove runtime dependence on historical PGlite migrations.
- [ ] Add fresh DB migration tests against the real Turso runtime.

**Exit Gate:** A fresh Turso DB migrates from empty to complete schema and passes basic repository smoke tests.

## Phase 3: Durable Job Queue Rewrite

**Objective:** Reimplement queue semantics without Postgres row locks.

- [ ] Design claim algorithm with explicit transaction mode and conflict handling.
- [ ] Implement `enqueue`, `enqueueBatch`, `claimMany`, `heartbeat`, `complete`, `fail`, `cancel`, `expireLeases`.
- [ ] Replace `unnest`/array casts with Turso-compatible bulk input.
- [ ] Preserve dedupe-key semantics.
- [ ] Preserve lease token as required proof of ownership.
- [ ] Preserve atomic chunk embedding write plus job completion.
- [ ] Add race tests:
  - [ ] two workers claim same queue,
  - [ ] stale worker tries to complete after lease loss,
  - [ ] heartbeat after cancel,
  - [ ] expired lease requeue,
  - [ ] batch completion partial failure.
- [ ] Add indexing-worker integration test against Turso queue.

**Exit Gate:** Queue race suite passes against real Turso runtime. No mocks count for this gate.

## Phase 4: Search, Vector, FTS, And Grep

**Objective:** Preserve assistant and UI retrieval behavior on Turso-native indexes.

- [ ] Choose vector storage shape:
  - [ ] per-embedding-set fixed-dimension vector table, or
  - [ ] shared vector table with strict dimension constraints, or
  - [ ] other layout justified by Turso benchmark.
- [ ] Implement vector insert/update/query.
- [ ] Implement vector index creation and diagnostics.
- [ ] Implement FTS table/index, query parser, ranking, and snippet/highlight.
- [ ] Implement grep candidate prefilter.
- [ ] Preserve JS authoritative literal/regex line matching.
- [ ] Port hybrid RRF fusion to new repository outputs.
- [ ] Create retrieval parity corpus:
  - [ ] exact identifier queries,
  - [ ] natural-language FTS queries,
  - [ ] semantic top-k queries,
  - [ ] filtered embedding-set queries,
  - [ ] mixed dimensions,
  - [ ] chunk overlap dedupe,
  - [ ] path filters.
- [ ] Benchmark realistic corpus size and record latency/recall.

**Exit Gate:** Search parity report is accepted. Any ranking or recall change is documented with evidence.

## Phase 5: Runtime Wiring And Live Invalidation

**Objective:** Replace PGlite runtime construction and live subscriptions.

- [ ] Replace desktop DB internals behind `apps/desktop/src/db-main.ts`.
- [ ] Replace `db-host-manager` and `db-host-entry` implementation details while preserving IPC API shape where practical.
- [ ] Replace browser PGlite worker/storage path.
- [ ] Implement invalidation events after committed mutations.
- [ ] Port `use-live-query` to the new invalidation contract.
- [ ] Preserve hidden-host DB priority behavior.
- [ ] Preserve foreground/background scheduler pressure reporting.
- [ ] Add diagnostics for:
  - [ ] engine version,
  - [ ] feature flags,
  - [ ] open handles,
  - [ ] pending transactions,
  - [ ] vector/FTS index presence,
  - [ ] sync status if enabled.

**Exit Gate:** Desktop and web smoke paths show DB-backed UI updates without PGlite live.

## Phase 6: Assistant Memory And Mastra Stores

**Objective:** Move assistant persistence and semantic memory fully onto Turso.

- [ ] Choose the Mastra persistence strategy:
  - [ ] direct `@mastra/libsql` for Mastra-owned tables with fail-closed wrappers,
  - [ ] Brainstrike-owned Mastra storage adapter over the selected DB contract,
  - [ ] or split storage where Mastra tables live in a separate LibSQL/Turso database with explicit lifecycle ownership.
- [ ] Port `assistant-memory-repository`.
- [ ] Port `pglite-mastra-memory` to a renamed Turso/Brainstrike store.
- [ ] Port vector memory store.
- [ ] Reject or wrap any storage methods that return empty lists after storage errors.
- [ ] Keep Mastra memory cache identity scoped by profile/resource/storage instance if any cache is introduced.
- [ ] Preserve Mastra v2 content dialect.
- [ ] Preserve tool invocation result hydration.
- [ ] Preserve run event grouping/interleaving.
- [ ] Run live Mastra loop tests with real store:
  - [ ] hosted provider memory persistence,
  - [ ] local desktop provider memory persistence,
  - [ ] tool execution persistence,
  - [ ] reload hydration.

**Exit Gate:** Assistant reload behavior matches live behavior across hosted and local desktop turns.

## Phase 7: PGlite Removal

**Objective:** Remove PGlite code, dependencies, and docs once Turso is authoritative.

- [ ] Delete PGlite construction and extension-loading code.
- [ ] Remove `@electric-sql/pglite` and `@electric-sql/pglite-pgvector` dependencies.
- [ ] Rename PGlite-specific memory modules.
- [ ] Delete or archive PGlite migrations outside runtime path.
- [ ] Update AGENTS PGlite extension invariant to Turso runtime invariant.
- [ ] Update docs for:
  - [ ] search architecture,
  - [ ] embedding architecture,
  - [ ] local DB runtime,
  - [ ] assistant memory persistence,
  - [ ] sync if enabled.
- [ ] Run dead-code checks and remove orphaned helpers.

**Exit Gate:** `rg -n "PGlite|pglite|pgvector|pg_trgm|tsvector"` returns only historical docs or intentionally retained comments.

## Final Verification Gate

Run on the same commit SHA:

- [ ] `pnpm lint:ci`
- [ ] `pnpm type-check`
- [ ] `pnpm build`
- [ ] `pnpm test`
- [ ] DB lane checks:
  - [ ] `node packages/db/scripts/test-lanes.mjs check`
  - [ ] `node packages/db/scripts/coverage-lanes.mjs check`
- [ ] Targeted Turso DB migration suite.
- [ ] Targeted job queue race suite.
- [ ] Targeted vector/FTS/grep parity suite.
- [ ] Targeted assistant memory live-loop suite.
- [ ] Desktop smoke with workspace indexing.
- [ ] Assistant retrieval smoke against indexed workspace.
- [ ] Web local persistence smoke.

The branch is not done unless all relevant gates are green in one run or every skipped gate has an explicit reason accepted by the team.

## Suggested Workstream Ownership

- [ ] Runtime/package spike: owns Turso package selection, Electron/browser probes, Drizzle adapter proof.
- [ ] Schema/migrations: owns baseline schema, migration runner, table tests.
- [ ] Queue/indexing: owns durable queue, embedding backfill, worker race tests.
- [ ] Search/RAG: owns vector, FTS, grep, hybrid, retrieval parity.
- [ ] Desktop/web runtime: owns DB host, IPC, browser storage, invalidation.
- [ ] Assistant memory: owns Mastra store and hydration tests.
- [ ] Docs/removal: owns AGENTS/docs updates and PGlite cleanup.

Do not start all streams at once. Start Phase 0, then Phase 1. Once the DB contract and Turso schema baseline are stable, split Phase 3 through Phase 6 into parallel branches with clear file ownership.

## Stop Rules

Stop and redesign if any of these happen:

- The chosen package cannot run in Electron and browser surfaces required by Brainstrike.
- Vector search cannot meet required dimensions, filters, or latency.
- Queue semantics require unbounded retries or cannot prove lease ownership.
- Live invalidation cannot be made commit-bound.
- Search falls back to broad scans without explicit user/tool-visible partial flags.
- Sync conflict behavior would corrupt local authoritative state.
- The migration requires remote writes in latency-critical paths.

When a stop rule triggers, document the failing contract and propose a narrow architecture alternative. Do not keep patching around the failure.
