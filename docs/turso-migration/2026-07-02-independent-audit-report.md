# Independent Audit: PGlite → Turso Migration (`feature/turso-migration`)

**Date:** 2026-07-02
**Branch audited:** `feature/turso-migration` @ `f9e487d58` (HEAD at audit time)
**Base:** `main` @ merge-base `82d52166`
**Auditor:** Independent adversarial review (not the implementing agent), grounded entirely in this session's own file reads, test reads, and live docs.turso.tech/turso.tech fetches — not training-data recall.

> Every claim below traces to a specific file, line range, or command output produced in this session. Where the underlying implementation was not personally re-read, this report says so explicitly rather than inferring confidence from the ledger's prose.

---

## 1. Scope & Methodology

### 1.1 What was actually reviewed

- **139 commits**, **360 files changed**, **+54,535 / −3,054 lines**, spanning PRs **#1304 → #1440** over **11 days** (2026-06-21 → 2026-07-02). `main` is only 3 commits ahead of the branch's merge-base (unrelated cosmetic fixes), so this is cleanly "main + the migration."
- File concentration: `packages/db` (88 files), `apps/desktop` (59), `packages/app-shell` (48), `packages/vector-management` (42), `packages/db-explorer` (30), `packages/preferences` (19), `packages/agent` (17), `packages/file-explorer-ui` (16), `packages/embeddings` (10).
- Dependencies: `@tursodatabase/database@^0.6.1` (runtime dep — the actual engine used everywhere in production), `@tursodatabase/sync@^0.6.1` (declared, but **imported in exactly one file**, `turso-capability-spike.ts`, only for a package-existence probe — never a live sync connection), `@libsql/client@^0.17.4` (devDependency, likewise **imported in exactly one file**, the same capability spike, only to probe `drizzle-orm/libsql` resolvability). Confirmed by a repo-wide grep, not sampling.
- The team's own doc set is genuinely unusual in quality: `docs/turso-migration/migration-ledger.md` (the live backlog, 651 lines, updated the same day as HEAD), plus `schema-baseline.md`, `search-index-architecture.md`, `profile-bootstrap.md`, `capability-spike-results.md`, and `touchpoint-primer.md`. The capability-spike result recording `Custom index modules are not supported in MVCC mode` is a **real, independently reproducible** error from the actual engine, not something copied from Turso's docs — this review re-confirmed the spike code that produced it.

### 1.2 Audit method

This was run as a 10-area, two-pass adversarial workflow (20 subagent runs, ~1,000 tool calls, ~3.6M tokens of subagent work):

1. **Audit pass** — one agent per architectural area (listed below) read the actual source/tests for that area and checked every ledger claim against the code, not against the ledger's own description of itself.
2. **Verify pass** — a second, independent agent per area was handed the first agent's draft findings and instructed to *try to refute them* by re-reading the same files itself, correct wrong line citations, and either strengthen, weaken, or delete each finding based on its own read.

This caught real errors in the first pass (e.g., a file misattributed to `main.ts` when the code actually lives in `db-main.ts`; a claim that MVCC's beta status was "mentioned elsewhere in the ledger" that turned out to be false on a full-document grep; a test-coverage claim that undercounted because it searched for `@libsql`/`createClient` string literals in a codebase that actually uses `@tursodatabase/database`). Those corrections are folded into the findings below and called out inline where they change severity.

The 10 areas: **(1)** shared DB provider & runtime capability gates, **(2)** UI snapshot replacements for PGlite live queries, **(3)** background indexing & embedding host, **(4)** assistant search & retrieval, **(5)** Mastra memory & assistant persistence, **(6)** schema authority & maintenance, **(7)** owner client / job queue / concurrency & QoS, **(8)** factory reset & profile cleanup, **(9)** dependency & build cleanup + non-negotiable-rule sweep, **(10)** CI sharding & test-proof quality.

### 1.3 What this report is not

It is not a request for the implementing team to stop or revert anything. The migration's own fail-closed discipline is, on the evidence gathered here, largely doing its job — most of the "invariant" violations this review went looking for turned out to be either absent or caught by a throw somewhere in the chain. The value of this report is in the minority of places where that discipline has a real, reachable gap, and in naming a vendor-maturity risk that no document in this repository currently states out loud.

---

## 2. Headline Findings

Ranked by severity. File:line citations are preserved from the underlying agent evidence; all were independently re-read at least once during the verify pass.

### [HIGH] Turso's own docs call the concurrency mechanism this migration is built on "not production ready" — and nothing in this repo's Turso doc set says so

Three independent review areas (Mastra memory, schema/maintenance, and the dependency sweep) separately found the same gap without being told to look for it by each other:

- `packages/db/src/turso/owner-client.ts` hard-requires `PRAGMA journal_mode='mvcc'` at construction (`applyTursoMvccJournalMode`, ~L509-515) and **throws** if the pragma doesn't read back as `mvcc` — there is no non-MVCC code path. Every non-exclusive transaction uses `BEGIN CONCURRENT` (~L228).
- `docs/turso-migration/capability-spike-results.md` records `sql.concurrent-writes-mvcc` as a `Required` check, `passed`, with no maturity caveat.
- A full grep of every file in `docs/turso-migration/` for `mvcc`, `beta`, `concurrent`, and `production ready` turns up exactly one relevant hit (`migration-ledger.md:186`), and that passage is about write-*parallelism* architecture, not about whether MVCC itself is safe to depend on.

This session independently fetched Turso's own current documentation and blog (not recalled from training data): Turso's public materials describe `BEGIN CONCURRENT`/MVCC concurrent writes as **beta**, explicitly stating *"not production ready, do not use it for critical data right now."* Turso-backed Mastra workflow storage — which is what makes tool-approval suspend/resume durable — depends on this exact mechanism (`supportsConcurrentUpdates()` in `packages/agent/src/turso-mastra-memory/workflows-store.ts:229-233`).

To be precise about what is *not* claimed: the code's behavior given this dependency is correct — it fails closed (throws) rather than silently degrading, and in the single-owner-client production topology, `BEGIN CONCURRENT` currently provides no real multi-writer parallelism anyway (see the queue/concurrency finding below), so the practical exposure today is narrower than "beta engine corrupting production data." What's missing is disclosure: nobody who reads only this repo's own migration documentation would learn that the foundational concurrency primitive is a vendor-labeled beta feature.

**Recommendation:** add one paragraph to `migration-ledger.md` (or a new `docs/turso-migration/risk-register.md`) naming this explicitly, with a decision on what "production ready" means for Brainstrike's own release gate given the vendor's own caveat.

### [HIGH] `useModelRegistryDbClient()` is the one DB-provider hook with no runtime gate, and its only consumer ships a double defect under Turso

`packages/db/src/db-provider.tsx`'s `useModelRegistryDbClient()` (~L1881-1904) returns the raw execution handle whenever `ctx.ready && !ctx.error` — unlike every sibling hook in the same file (`useBrainstrikeDbClient`, `useAssistantMemoryDbClient`, etc.), it has **no branch on `runtime.engine`**.

Its only consumer, `packages/preferences/src/stores/model-registry-store.ts`, has two independently-confirmed defects on the same write path:

1. `toggleProvider`/`toggleModel` (~L300-351) issue `UPDATE providers/models SET is_enabled = $1, updated_at = $2 WHERE id = $3` — Postgres numbered placeholders. `packages/db/src/turso/owner-client.ts`'s `queryTursoSql`/`execTursoSql` (~L383-407) do **zero** placeholder-dialect translation before handing params to `@tursodatabase/database`. Every dedicated Turso repository in the codebase instead correctly uses SQLite `?` placeholders.
2. `enabled` is a raw, uncoerced JS `boolean` (function signature at ~L62-63) bound directly into that statement — with **no `? 1 : 0` conversion anywhere in the 405-line file** — against a column declared `is_enabled INTEGER NOT NULL DEFAULT 0 CHECK (is_enabled IN (0, 1))` (`packages/db/src/turso/schema-baseline.ts:280,296`).

Either defect alone would likely fail; together they make failure near-certain by construction. The failure is then swallowed by a bare `try/catch` that logs and silently reverts the optimistic UI toggle (`fetchRegistry(db)`, ~L322-326, 347-350) — a silent-degrade under Turso, exactly what non-negotiable rule #1 and invariant #1 prohibit, on a live, reachable write path (any provider/model enable-disable toggle in Settings).

The only test covering this path, `packages/preferences/src/settings/models/__tests__/model-selection-page.turso-registry.test.tsx`, mocks `toggleModel` itself (`vi.fn().mockResolvedValue(undefined)`) and never exercises real SQL — this is exactly the mock-only-test pattern migration rule #7 exists to prevent, and it is why the defect shipped undetected.

**Recommendation:** give `model-registry-store.ts` the same `{db, runtimeEngine}` typed-hook treatment as the other stores, rewrite the SQL with `?` placeholders and explicit `enabled ? 1 : 0` coercion (or a dedicated Turso repository method), and replace the mock-only test with one that runs against a real `@tursodatabase/database`-backed test client (the pattern already exists in `packages/db/__tests__/turso-file-record-repository.test.ts`).

### [HIGH] Turso writes are serialized by two independent, priority-blind FIFO queues stacked across a process boundary — and the stack is untested end-to-end

The real `TursoOwnerClient` is only ever constructed inside a forked Electron **utility process** (gated by `isUtilityProcessRuntime()`, `apps/desktop/src/db-main.ts:313-320`; client created at ~L1801). The Electron **main** process — where `ipc-domains/db-ipc.ts`'s `ipcMain.handle` registrations and the `DefaultDatabaseWorkScheduler` (`packages/db/src/database-work-scheduler.ts`) both live — never touches the owner client directly; it calls `getDbHostManager().runTursoEmbeddingWorkerQueueOperation(...)` / `runTursoVectorQueueAction(...)` (`apps/desktop/src/db-host-manager.ts:651-676`), an async RPC over `utilityProcess.postMessage` to the other process.

That means there are genuinely **two** separate, mutually blind, priority-unaware FIFO serialization points:

1. The main-process scheduler, which only orders *when an IPC call is dispatched*.
2. The owner client's own `runExclusive` queue inside the utility process, which orders *actual DB operations once they arrive there* — and the main-process scheduler has no visibility into this queue's depth or state at all.

A foreground query that the scheduler prioritizes ahead of a queued background job can still stack up behind an already-in-flight background transaction inside the utility process, invisibly to the scheduler. The QoS diagnostics the ledger cites as the trigger for "reopen the separate-connection design only if diagnostics show material blocking" are read from *inside* the utility process and only reach an operator after a further IPC round-trip — i.e., the signal that would tell you this is happening is itself one process-hop removed from the component that would need to act on it.

No test in the reviewed set exercises the full two-process, two-queue stack together: `db-ipc.test.ts`'s Turso-channel tests mock `DbHostManager` entirely (proving only that arguments are forwarded correctly), and `db-host-entry-turso-owner-requests.test.ts` exercises a real owner client inside a simulated utility-process message loop but never involves the main-process scheduler or `db-ipc.ts`.

*(This is a re-verification of an open question flagged in a prior review session dated 2026-06-29, at which point far fewer commits existed. That earlier review's other flagged gap — asymmetric write-retry coverage across `TursoJobQueue` methods — is now confirmed **fixed**: `withTursoWriteRetry` wraps every mutating queue method, verified line-by-line.)*

**Recommendation:** either add an integration test that drives both the main-process scheduler and the utility-process owner-client queue together under load, or explicitly document the two-queue topology as an accepted design tradeoff with a named follow-up trigger (not just "reopen if diagnostics show blocking" — a concrete threshold).

---

### [MEDIUM] findings, grouped by theme

**Ledger accuracy / staleness** (the ledger is good, but not infallible — several sections describe work as more or less complete than it is):

- The "known production touchpoints" list for UI live-query replacement (ledger §2) is stale for 4 of 7 named files: `use-quick-open-files.ts` and `use-file-mentions.ts` are fully ported (capability-gated, repository-snapshot fallback, invalidation listener) despite being listed as still-open. Conversely, `use-cross-root-cost.ts` and `use-om-segment-row.ts` **are** correctly gated with real Turso snapshot reads, but neither has any invalidation/refresh trigger after the initial fetch — confirmed via full `useEffect` dependency-array reads and a grep for `setInterval`/`addEventListener` in both files (both empty). A sibling file's own code comment (`assistant-ui-panel-wrapper.tsx:1310`, *"this effect only fires on repo/thread change"*) independently corroborates this is a known structural pattern, not an isolated oversight — but it means the cost-tracking panel and the observational-memory context-meter segment can go stale for the life of a thread/scope selection under Turso.
- `packages/preferences/src/settings/tools/unified-tools-settings.tsx`'s live-query seam (`operations.toolsLiveQuery`) is never populated by either production caller (`apps/web`/`apps/desktop` settings pages) — confirmed by reading both call sites in full. It's currently harmless (the hook always runs `enabled:false`), but it's the **one** file of the seven with zero runtime-engine-aware gating logic, unlike every other ported hook. If a future PGlite-only feature wires this without adding the same gating pattern, it would silently no-op under Turso rather than throw — the exact failure mode invariant #1 forbids, latent rather than active today.
- Ledger §3 states *"Ready Turso profiles can... run failed-job retry/repair controls without opening a PGlite handle"* citing `EmbeddingJobQueueTracker`/`QueueHud`. On direct read, `QueueHud`'s retry gate duck-checks for `repairUnclaimableQueued`/`requeueFailed`, which the Turso read-model (`createTursoJobQueueReadModel`) doesn't expose — so `QueueHud`'s retry button is *always disabled* for Turso, proven by the component's own test (`'disables retry button when queue stats are read-only'`). The overall app-level retry capability genuinely exists and works (via a different component, `vector-status.tsx`, through the desktop Turso vector-queue-service IPC bridge) — but `QueueHud` itself, which has zero production mount sites today (grep-confirmed), doesn't have it. Low current impact, but worth fixing the ledger's phrasing before `QueueHud` is ever wired into a real screen.
- Ledger §7 (Factory Reset) never mentions that a **second**, parallel data-wipe path exists: the `db:clearAll` IPC channel (`apps/desktop/src/ipc-domains/db-ipc.ts:728-809`) runs a SQL-only transaction wipe directly against the live handle, with **no** reset barrier, no `stopBackgroundRuntimes()`, no filesystem deletion — confirmed by a full read of the handler and a grep showing it never calls `runScheduledDatabaseWork`/the reset barrier that `db:resetLocal` uses. This is a pre-existing (non-Turso-specific) pattern, but for Turso specifically it means "Clear Database" (wherever it's wired in the UI) never runs the barrier-coordinated, embedding-host-aware reset path the ledger describes as *the* reset story.

**Capability checks that are correct today but not continuously re-verified:**

- `packages/db/src/bootstrap/turso-capability-spike.ts` is the *only* code in the repo that actually re-proves `Custom index modules are not supported in MVCC mode` against a real engine connection — and it is imported nowhere except its own test. The production bootstrap gate, `turso-profile-bootstrap.ts`, sets `search.ownership` to a **hardcoded** `'passed'`/`'split-search-index-store'` constant (~L99-104, 133) rather than re-running the probe. The architecture is correct today because a human decided it was, not because the running app checks it on every start — so a future Turso engine upgrade that silently changed FTS/MVCC compatibility (in either direction) would go undetected.

**Type-safety gaps at real seams:**

- `apps/desktop/src/db-main.ts` declares `getDatabase(): Promise<any>` and `initializeMainDatabase(): Promise<any>` (both biome-ignored as a deliberate "compatibility facade"). That `any` flows unnarrowed into `DesktopMastraMemoryDatabaseContext.database` and then into `createTursoMastraMemory({ database: ... })`, whose parameter is statically typed `TursoMastraSqlClient` — TypeScript cannot check this assignment. Traced to the real runtime object (`RemoteDbClient` in `db-host-manager.ts`), which does structurally satisfy the interface today, so this is not a live bug — but it is a real, load-bearing `any` at exactly the seam non-negotiable rule #6 is about ("don't call a generic handle Turso-capable without a real execution client behind it"). The correctness of that rule currently rests on duck-typing at runtime, not a compile-time contract.
- A related, narrower gap: `db-host-manager.ts`'s client-side `#transaction` (the RemoteDbClient object fed into Mastra memory) has no visible reentrancy guard the way the lower-level `TursoOwnerClient.transaction()` does — whether calling `.transaction()` again from inside an open transaction would actually self-deadlock depends on host-process behavior not present in the reviewed files. Flagged as an open question, not a confirmed defect.

**Testing gaps:**

- The only test for the Turso branch of `resetLocalDatabaseInternal` (WAL/SHM sidecar cleanliness) runs under `vi.mock('node:fs', ...)` — no real `@tursodatabase/database` file is ever created or deleted in that test. Mitigated in practice because the reset design deletes the whole profile directory recursively (`rmSync(appDataDir, {recursive:true})`) rather than targeting `turso-primary.db` by name, so any WAL/SHM sidecar the beta engine creates is swept up regardless — but the specific claim "reset leaves no stale Turso files behind" is asserted by design reasoning, not proven by a real-engine test.
- `apps/desktop/src/__tests__/renderer/components/desktop-turso-embedding-worker-storage.test.ts` mocks the base Turso storage factory entirely (with methods that throw if called), proving only that the desktop wrapper delegates to the IPC bridge correctly — not that the underlying `TursoJobQueue` mutations are correct from that call site. The end-to-end proof does exist, just in a different file (`packages/db/__tests__/job-queue-turso-runtime.test.ts`, which really does race 5 independent owner clients against a shared on-disk file).
- `scripts/affected-unit-tests.mjs`'s dependent-package-expansion safe-list treats the whole `packages/db/src/repositories/` directory as "safe to skip re-running downstream tests," but only special-cases the barrel file (`repositories/index.ts`) for the opposite treatment — not the underlying `repository-factory.ts` whose logic the barrel re-exports. On investigation this does **not** narrow `@brainstrike/db`'s own test coverage (an unclassified file falls back to running all 5 unit lanes / 7 coverage lanes), and no current downstream consumer reaches `repository-factory.ts` except through the barrel — so the realized risk is narrow, but the rule itself is inconsistent with its own stated intent.

### [LOW/INFO] worth knowing, not urgent

- The `scanLimited` grep fallback path (no extractable trigram literal) has **no supporting index** for its `ORDER BY fr.path, fc.chunk_index` — the result set is correctly row-count-bounded (satisfying "no silent unbounded output"), but the underlying scan cost is not eliminated, only capped after the fact. A real performance cliff on large workspaces, understated by the word "bounded."
- `assertTursoExecutionClient` (embedding-host-runtime.tsx) is a shape/duck-type check, not the stricter branded check (`isTursoBrainstrikeDbExecutionClient`) used for the equivalent gate in the search/retrieval tools. Currently safe because the caller derives `runtimeEngine` independently, but the function name overstates what it verifies.
- The CI-sharding rewrite (`scripts/affected-unit-tests.mjs`, `test-lanes.mjs`/`coverage-lanes.mjs` refinements — 13 commits, 2026-06-22 to 2026-06-24) was interleaved with Turso feature PRs in the same 3-day window rather than landing as its own reviewable unit. 8 of 106 numbered ledger PRs are explicitly CI-sharding titled (~7.5%, not "roughly a third" as an early pass estimated) — a real but modest blast-radius/review-process coupling, not a code defect (both lane-check scripts run clean).
- `unified-tools-settings.tsx`, `use-cross-root-cost.ts`, and `use-om-segment-row.ts` aside, the UI copy for "hybrid search" (`search-mode-bar.tsx`, `search-config-panel.tsx`) carries no caveat that the underlying lexical scorer is a gram-index heuristic, not Tantivy-style ranking — pre-existing, engine-neutral wording that predates this migration, not worsened by it.

---

## 3. Modern Turso Idiom & Vendor-Maturity Cross-Check

This section is grounded in live fetches of `docs.turso.tech` and `turso.tech/blog` performed during this session, not recalled model knowledge.

| Turso concept | What the current docs say | What this codebase does | Verdict |
|---|---|---|---|
| Embedded replicas | Writes go to the **remote primary by default**; local file only reflects committed remote writes unless `offline:true`. `@libsql/client/web` doesn't support local file URLs. | Not used. The codebase's own `docs/turso-migration/migration-ledger.md` "Turso Docs Guardrail" section states this distinction correctly, and the actual owner client (`connect()` from `@tursodatabase/database` against a local file path) never constructs an embedded-replica or `syncUrl` client. | **Correct** — the team clearly read the real docs, not an idealized picture. |
| Turso Sync | `@tursodatabase/sync`'s `connect()` is genuinely local-first: explicit `push()`/`pull()`, "last push wins" conflict resolution. | `@tursodatabase/sync` is a declared dependency but is **imported in exactly one file** (`turso-capability-spike.ts`), only for a package-existence check — never a live sync connection anywhere in production. | **Not actually used yet.** Fine for a greenfield single-device app today; worth noting if multi-device sync is ever a roadmap item, since the dependency being present could otherwise read as "already wired." |
| MVCC / `BEGIN CONCURRENT` | Documented by Turso itself as **beta**, "not production ready, do not use it for critical data right now." | Hard-required at owner-client construction (throws if not applied); every non-exclusive transaction uses it; Turso-backed Mastra workflow storage (tool-approval suspend/resume) depends on it. | **Real vendor-maturity risk, undisclosed in this repo's docs** — see Headline Finding #1. |
| Native vector search (`vector32()`, `vector_distance_cos/l2/dot`) | Documented, stable (non-beta), DiskANN-indexed feature. | `TursoFileChunkRepository.searchSimilar()` writes `vector32(?)` blobs and queries with the documented distance functions, proven against a real local engine in `turso-file-chunk-repository.test.ts`. | **Correct and idiomatic.** |
| FTS custom indexes vs MVCC | Documented (and, separately, independently reproduced by this codebase's own capability spike) as incompatible: `Custom index modules are not supported in MVCC mode`. | Search avoids native FTS entirely in favor of a gram-index + `instr()` substring-guard design (`file_chunk_content_grams`/`file_record_name_grams`), which is genuinely index-backed for the literal-prefilter path. | **Architecturally correct**, but the capability-spike check that justifies the choice is dead code outside its own test (see Medium finding above) — correct by decision, not continuously verified by the running app. |

---

## 4. Invariant Checklist Scorecard

Aggregated across all 10 review areas. "Not applicable" means the area's files didn't exercise that invariant, not that it was skipped.

| # | Invariant | Overall verdict | Basis |
|---|---|---|---|
| 1 | No silent fallback Turso→PGlite; unsupported paths throw | **Partial** | Architecture-wide discipline is real and mostly holds (live-query paths, embedding runtime, search tools, retrieval all throw correctly). One confirmed live violation: the model-registry write path (Headline Finding #2) degrades silently instead of throwing. One narrower gap: dimension-index-maintenance startup wraps its own exhaustive-switch throw in a catch that converts it to the same silent-skip outcome as a recognized-unsupported runtime — currently unreachable (2-member union) but not a hard guarantee. |
| 2 | No remote round-trip in hot paths (embedded-replica trap) | **Pass** | Every Turso construction site uses `connect()` from `@tursodatabase/database` against a local file path; `@libsql/client` has exactly one, non-live consumer repo-wide. Strongly verified, not just sampled. |
| 3 | Queue: CAS claim, lease tokens, bounded retries, real multi-client tests (no `FOR UPDATE SKIP LOCKED`) | **Pass** | Confirmed atomic `UPDATE...WHERE...RETURNING` claims, lease-token guards on every lifecycle transition, `withTursoWriteRetry` now wraps every mutating queue method (a prior gap from an earlier review is fixed), and a genuine 5-independent-owner-client race test proves no double-claim across 50 jobs. Caveat: the "multi-client" test runs all clients in one Node process, not separate OS processes — untested for true cross-process contention, which is exactly the topology production uses (Headline Finding #3). |
| 4 | Search: no FTS-in-MVCC, no silent unbounded scan | **Pass, with a live-enforcement gap** | The chosen gram-index architecture is correct and matches the reproduced MVCC/FTS incompatibility. But the capability-spike check that reproduced it is disconnected from the live bootstrap gate (Medium finding above), and the no-prefilter grep fallback is row-count-bounded but not scan-cost-bounded. |
| 5 | Live queries: `liveQuery=false` for Turso, explicit snapshot+refresh, never silent polling | **Partial** | The gating itself is airtight (type-level exclusion of `live` from `TursoOwnerClient`'s interface, IPC-layer throw as defense-in-depth). But 2 of the 5 production snapshot hooks (cost tracking, OM segment row) have no invalidation trigger after their initial fetch — correctly avoids PGlite live query, but can go stale for the life of a selection. |
| 6 | Schema baseline: greenfield, checksum-gated, rejects legacy migration tables, fails closed on drift | **Pass** | Deeply verified: checksum comparison throws on drift, `_migrations`/`__drizzle_migrations` presence throws, a genuine v5→v6 upgrade test exists (though it only exercises the seed-preservation path since v5→v6 has no DDL delta). Mastra's own tables use a separate, narrower greenfield-only mechanism (no checksum gate) — acceptable given its DDL is idempotent `CREATE TABLE IF NOT EXISTS`, but worth naming as a second, less strict mechanism. |
| 7 | Owner-client `transaction()` forbids re-entering the outer client | **Pass** (core) / **Open question** (one layer up) | The core `TursoOwnerClient` guard is unusually solid: both a runtime `AsyncLocalStorage` check *and* a structural guard (the inner transaction-scoped client object literally has no `.transaction` method to call). Proven by a real timing-race test. One layer up, `db-host-manager.ts`'s `RemoteDbClient` (used by Mastra memory) has no visible client-side reentrancy guard of its own — whether the separate DB-host process would actually deadlock on a second concurrent transaction id is unverified from the files in scope. |
| 8 | No `any`; no Turso types leaking through the neutral contract | **Partial/Fail** | The engine-neutral contract types themselves (`BrainstrikeDbExecutionClient`, etc.) are clean. But `apps/desktop/src/db-main.ts` has a recurring, real `any` (`let db: any`, `getDatabase(): Promise<any>`) that is threaded, unnarrowed, into at least one statically-typed consumer (`TursoMastraSqlClient`) — a genuine gap at exactly the seam the "no generic handle passed off as Turso-capable" rule is meant to close, currently safe only because the runtime object happens to satisfy the shape. |

---

## 5. What's Genuinely Well Done

For balance, since an adversarial review skews toward what's wrong: several things here reflect real engineering discipline, independently verified rather than assumed.

- **The owner-client self-deadlock guard is doubly enforced** — both a runtime check and a structural one (the transaction-scoped client object has no `transaction` method to misuse in the first place). Proven with an actual `Promise.race` timing test, not just an assertion.
- **The retry-coverage gap flagged in an earlier review (2026-06-29) is now fixed.** Every mutating `TursoJobQueue` method — enqueue, claim, complete, heartbeat, fail, cancel, prune, expire, retry — is wrapped in the bounded write-contention retry helper. This was checked line-by-line, not sampled.
- **The multi-client job-queue race test is real**, not decorative: 5 independent `createTursoOwnerClient` connections against one shared on-disk file, racing to claim/complete 50 jobs, asserting zero double-completion.
- **The dual-lane-registry bug class that caused a real prior incident (issue #1101 — a test registered in only one of two separate CI lane lists) is now structurally impossible to reintroduce**, not just avoided by discipline: `db-test-lane-manifest.mjs` is a single shared manifest that both `test-lanes.mjs` and `coverage-lanes.mjs` import from, and a test can't resolve to a unit lane without also resolving to exactly one coverage lane. All new Turso test files were independently confirmed present in both.
- **The embedded-replica-vs-Sync distinction is correctly understood and correctly avoided** — a subtle point that's easy to get wrong from partial documentation, and the team's own guardrail doc states it accurately.
- **Native vector search usage matches the documented, stable feature set** and is proven against a real local engine in tests, not mocked.
- **The visible renderer is correctly kept out of direct `TursoJobQueue` construction** — every production construction site is either inside the desktop utility process or a shared factory whose renderer-side override structurally cannot reach the base implementation (proven by that override's own test using throw-if-called mocks for the base methods).

---

## 6. Documentation Debt

Independent of anything in the code: **`AGENTS.md` — this repository's own "living document," which its own text says "must be kept accurate" — contains zero mentions of Turso**, verified by `grep -ci turso AGENTS.md` returning `0` on this exact branch. This is despite the migration's own planning document, `docs/turso-migration/touchpoint-primer.md` (item 16), explicitly listing *"replace PGlite extension invariant with Turso runtime capability invariant"* and *"no PGlite-only invariant remains as live guidance"* as required verification steps before this work is done. The `PGLITE EXTENSION INVARIANT` section in `AGENTS.md` still reads as if PGlite were the only storage engine in the codebase.

This matters beyond tidiness: `AGENTS.md` is the document this project's own conventions say both humans and AI agents should treat as the primary source of truth. An agent (or engineer) picking up unrelated work elsewhere in the codebase today would have no way to learn from `AGENTS.md` that a second storage runtime, a capability-gated bootstrap contract, an owner-client process topology, or any of the invariants this report checked against even exist.

---

## 7. Recommendations, Roughly In Priority Order

1. **Fix the model-registry write path** (Headline Finding #2) — this is the one confirmed, reachable production bug in this review. Small, contained fix: typed hook + `?` placeholders + boolean coercion + a real-engine test.
2. **Name the MVCC beta risk explicitly** somewhere in `docs/turso-migration/` — one paragraph, with an explicit decision about what "ready" means given the vendor's own caveat, since this is currently a silent dependency of tool-approval-resume durability.
3. **Decide whether the two-process queue topology needs an integration test or just an explicit, monitored acceptance** (Headline Finding #3) — the current "reopen if diagnostics show blocking" plan has no concrete trigger threshold and no test that could ever hit it.
4. **Either wire the capability-spike probe into the live bootstrap gate, or explicitly document that `search.ownership` is a one-time human decision, not a continuously re-verified one** — right now a reader of the bootstrap report can't tell the difference.
5. **Add invalidation triggers to the two snapshot hooks that lack them** (`use-cross-root-cost.ts`, `use-om-segment-row.ts`) or explicitly document the staleness window as accepted.
6. **Reconcile `db:clearAll` with the reset-barrier story**, or route it through the same barrier `db:resetLocal` uses.
7. **Update `AGENTS.md`** to describe the Turso runtime, its capability-gating model, and its non-negotiable rules — this is both a real gap and the cheapest fix on this list.
8. Lower priority: tighten the `db-main.ts` `any` bindings with a discriminated union instead of `Promise<any>`; correct the `QueueHud`/ledger retry-capability mismatch before that component is ever wired into a screen; replace the mocked reset-cleanliness test and the mocked desktop-embedding-worker-storage test with real-engine equivalents (patterns already exist elsewhere in the same test suite to copy from).

---

## Appendix A: Areas Reviewed and File Sets

| Area | Primary files/dirs reviewed |
|---|---|
| Shared DB provider & runtime gates | `packages/db/src/db-provider.tsx`, `use-live-query.ts`, `architecture/db-runtime-selection.ts`, `turso/owner-client.ts`, `turso/schema-baseline.ts`, `packages/preferences/src/stores/model-registry-store.ts`, `apps/desktop/src/ipc-domains/db-ipc.ts` |
| UI live-query snapshot replacements | `packages/db-explorer/src/{database-demo-panel.tsx,use-database-demo-data.ts}`, `packages/preferences/.../unified-tools-settings.tsx`, `packages/app-shell/src/{use-quick-open-files.ts,use-file-mentions.ts,cost-tracking/use-cross-root-cost.ts,use-om-segment-row.ts}` |
| Background indexing & embedding host | `apps/desktop/src/renderer/components/{embedding-host-runtime.tsx,embedding-worker-provider.tsx,desktop-turso-embedding-worker-storage.ts}`, `packages/vector-management/src/*`, `packages/embeddings/src/worker/*` |
| Assistant search & retrieval | `apps/desktop/src/assistant-server/{assistant-tools.ts,grep-search-tool.ts,retrieval-tool.ts}`, `packages/db/src/search/*`, `packages/db/src/repositories/turso-file-chunk-repository.ts`, `packages/db/src/bootstrap/turso-capability-spike.ts` |
| Mastra memory & assistant persistence | `apps/desktop/src/assistant-server.ts`, `packages/agent/src/turso-mastra-memory/*`, `packages/app-shell/src/assistant-memory-repository.ts` |
| Schema authority & maintenance | `packages/db/src/turso/{schema-baseline.ts,schema-ledger.ts}`, `packages/db/src/services/{scheduled-database-maintenance.ts,dimension-index-maintenance.ts}`, `apps/desktop/src/{db-main.ts,dimension-index-maintenance-scheduler.ts,database-maintenance-scheduler.ts}` |
| Owner client, queue & concurrency/QoS | `packages/db/src/turso/{owner-client.ts,connect-options.ts}`, `packages/db/src/queue/turso-job-queue.ts`, `packages/db/src/database-work-scheduler.ts`, `apps/desktop/src/{db-main.ts,db-host-manager.ts,ipc-domains/db-ipc.ts}` |
| Factory reset & profile cleanup | `packages/preferences/.../factory-reset-{helpers.ts,panel.tsx}`, `apps/desktop/src/{db-main.ts,desktop-reset-platform.ts,desktop-factory-reset.ts}` |
| Dependency/build cleanup + non-negotiable sweep | `apps/desktop/package.json`, `apps/desktop/vite.config.mts`, `packages/db/src/wasm-loader.ts`, repo-wide greps for fallback/placeholder/`any` patterns |
| CI sharding & test-proof quality | `packages/db/scripts/{test-lanes.mjs,coverage-lanes.mjs,db-test-lane-manifest.mjs}`, `scripts/affected-unit-tests.mjs`, `.github/workflows/test.yml` |

## Appendix B: External Sources Consulted Live (Not Training-Data Recall)

- `docs.turso.tech/features/embedded-replicas/introduction`
- `docs.turso.tech/sync/usage`
- `docs.turso.tech/sdk/ts/reference`
- Turso vector-search documentation and blog posts (`turso.tech/vector`, `turso.tech/blog/turso-brings-native-vector-search-to-sqlite`)
- Turso concurrent-writes/MVCC documentation and blog posts (`docs.turso.tech/tursodb/concurrent-writes`, `turso.tech/blog/beyond-the-single-writer-limitation-with-tursos-concurrent-writes`)
- `@tursodatabase/database` npm package description and beta-status framing
