# Multi-Root Phase 3: Root-Scoped Import & Sync Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Background imports write `file_records.root_id` (consuming the Phase 2 registry mapping), making file data root-correct while the UI stays single-active-root.

**Architecture:** Per-batch `rootId` threads through the managed-cache write path: `ApplyManagedCacheBatchArgs.rootId` → `INSERT ... root_id` (one new column in the SQL, validated at the IPC boundary on desktop). The sync service gains a `resolveDbRootId(rootPath)` dependency backed by the roots-reconciliation result (a promise that ALWAYS settles; missing mapping → `null` + loud warn, never a hang, never a silent wrong id). Plus an isolated feature-detected `FileSystemObserver` in the web adapter's `watchDirectory`.

**Explicitly NOT in scope (dossier findings):** job-queue dedupe keys (chunk UUIDs are per-file-record → root-scoped automatically); watcher `Map<RootId>` (file-explorer layer, Phase 4); `file_token_cache.folder_id` (UI display key, unrelated to root_id); `FileImportInput`/foreground import path (separate path, Phase 4+); `applyManagedCacheReplacements` (UPDATE by id — root never changes on replace); `backfillEmbeddingSetAssignments` (root_id set at insert time).

**Tech Stack:** TypeScript strict, PGlite, Electron IPC, Vitest.

**Context (verified by design dossier — trust these file:line references):**
- Background import chain: `WorkspaceCollectionSyncProvider` → `runRootFolderCacheImport` (workspace-collection-sync-import.ts:618) → `applyBackgroundImportBatch` (:329) → `args.applyManagedCacheBatch({ embeddingSetId, changes })` (:367) → web local or desktop IPC → `applyManagedCacheBatch` in packages/db/src/managed-cache/apply-managed-cache-batch.ts → `insertManagedCacheImports` (INSERT at :337-348, `IMPORT_COLUMNS` at :206-219, currently no `root_id`).
- `ApplyManagedCacheBatchArgs` (:38-41) is `{ embeddingSetId, changes }`; a `parseManagedCacheBatchArgs` validator guards the IPC boundary — extend it for the new optional field.
- Sync service: `ResolvedSyncContext` (workspace-collection-sync-service.ts:133-138) has `activeRootPath`/`rootPath` strings; `WorkspaceCollectionSyncServiceDependencies` is where `resolveDbRootId` goes; the provider constructs the service in a `useMemo` (workspace-collection-sync-provider.tsx:438-509) and already mounts `useRootsReconciliation`.
- Registry: `reconcileRoots` (packages/app-shell/src/roots/root-registry.ts) returns `{ dbRootIdByAdapterRootId: Map<adapterRootId, dbRootId> }`; the hook (use-roots-reconciliation.ts) currently discards it. NOTE: the registry and hook DO have tests (root-registry.test.ts — 5 cases; use-roots-reconciliation.test.tsx — 5 cases); update them, don't recreate.
- KEY identity detail: the sync service only knows the active root by PATH (`rootDirectoryHandle.path`), not by adapter RootId. The mapping consumers need **path → dbRootId**, built from the `restoreRoots()` descriptors (`descriptor.handle.path` → `mapping.get(descriptor.rootId)`).
- Timing: reconciliation is async fire-and-forget; the first sync can start before it resolves. Policy (no-silent-fallbacks compliant): `resolveDbRootId` AWAITS the reconciliation promise (which always settles — on error it resolves to an empty map and the hook already error-logs); a missing entry yields `null` + `logger.warn` once per path; rows then get `root_id = NULL` exactly like today (zero regression), and the 029 `source_root_path` identity still applies.
- Dual-index safety (dossier §2): different roots ⇒ different `source_root_path`, so the 029 index can't cross-collide; new rows satisfy both indexes. `insertManagedCacheImports` has no ON CONFLICT — unchanged.
- House rules: TDD; no `any`; never `git checkout` files you didn't author; pre-commit formats; db tests under packages/db/__tests__ must be in BOTH lane registries (Task 1 adds none — managed-cache tests live in existing registered files; verify with the lane checks anyway).

---

### Task 1: db layer — root_id through the managed-cache batch

**Files:**
- Modify: `packages/db/src/managed-cache/apply-managed-cache-batch.ts`
- Modify: the desktop IPC surface for `db:applyManagedCacheBatch` IF the args validator lives separately (grep `parseManagedCacheBatchArgs` call sites — apps/desktop ipc-domains and/or preload typing; follow where the type crosses)
- Test: extend the existing managed-cache batch test file (find it: `grep -rl "applyManagedCacheBatch" packages/db/__tests__/ packages/db/src/**/__tests__/ 2>/dev/null`)

- [ ] **Step 1 (failing tests):** In the existing managed-cache test file, add:
  - `applyManagedCacheBatch({ embeddingSetId, rootId: 'root-db-1', changes: [importChange] })` → the inserted `file_records` row has `root_id = 'root-db-1'` (real-PGlite test if the file uses one; otherwise assert the SQL/params like its siblings).
  - omitted `rootId` → row has `root_id IS NULL` (back-compat).
  - validator: `parseManagedCacheBatchArgs` accepts `rootId: string`, accepts absent, REJECTS non-string (e.g. number) with a thrown error (no silent coercion).
  Note: a `roots` row must exist for FK integrity in real-PGlite tests — insert one in the fixture (`INSERT INTO roots (id, kind, display_name) VALUES ('root-db-1', 'path', 'fixture')`).
  Run → fail.

- [ ] **Step 2 (implement):**
  - `ApplyManagedCacheBatchArgs` gains `readonly rootId?: string | null;` (per-batch — all changes in a batch share one root).
  - `parseManagedCacheBatchArgs`: validate `rootId` is `string`, `null`, or `undefined`; else throw (match the validator's existing error style).
  - `insertManagedCacheImports`: add `'root_id'` to `IMPORT_COLUMNS` and `args.rootId ?? null` to each row's values (it's per-batch, same value every row). Thread `rootId` from `applyManagedCacheBatch` into both the import path and — explicitly NOT — the replacements path (UPDATE doesn't set root_id; add a one-line comment saying so).
  - If the desktop IPC handler/preload types the args separately (electron-api.ts or ipc-domains), extend that typing identically.

- [ ] **Step 3 (verify):** `cd packages/db && pnpm test` (all lanes; retry a failed lane once in isolation) + `pnpm run test:db:check-lanes && pnpm run test:coverage:db:check-lanes` + `pnpm --filter @brainstrike/db build`. If the desktop IPC surface changed: `cd apps/desktop && pnpm vitest run src/__tests__/ipc-domains/`.

- [ ] **Step 4 (commit):** `feat(db): root_id on managed-cache imports` + trailer `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.

---

### Task 2: app-shell plumbing — rootId through the import call chain

**Files:**
- Modify: `packages/app-shell/src/background-indexing/workspace-collection-sync-import.ts`
- Test: `packages/app-shell/src/background-indexing/__tests__/workspace-collection-sync-import.test.ts` (extend)

- [ ] **Step 1 (failing test):** in the import test file, cover: `runRootFolderCacheImport({ ..., rootId: 'root-db-1' })` → the `applyManagedCacheBatch` mock receives `rootId: 'root-db-1'`; and absent → receives `rootId: null` (or absent — pick ONE convention: pass `rootId: args.rootId ?? null` explicitly so the assertion is deterministic). Run → fail.

- [ ] **Step 2 (implement):** add `rootId?: string | null` to the args of `runRootFolderCacheImport` (:618) and `applyBackgroundImportBatch` (:329); include it in the `applyManagedCacheBatch(...)` call (:367) as `rootId: args.rootId ?? null`. `PreparedCacheChange` stays untouched (per-batch, not per-record).

- [ ] **Step 3 (verify):** `cd packages/app-shell && pnpm vitest run` — green; build clean.

- [ ] **Step 4 (commit):** `feat(app-shell): thread rootId through background import batches` + trailer.

---

### Task 3: mapping exposure + sync service wiring

**Files:**
- Modify: `packages/app-shell/src/roots/use-roots-reconciliation.ts` (+ its test)
- Modify: `packages/app-shell/src/roots/root-registry.ts` ONLY if a small helper is cleaner (prefer hook-local)
- Modify: `packages/app-shell/src/background-indexing/workspace-collection-sync-service.ts` (+ its test/helpers)
- Modify: `packages/app-shell/src/background-indexing/workspace-collection-sync-provider.tsx`

Design (locked):
- The hook builds **`dbRootIdByPath: Map<string, string>`** from the `restoreRoots()` descriptors + `dbRootIdByAdapterRootId` (key: `descriptor.handle.path`; value: `mapping.get(descriptor.rootId)`; skip descriptors the registry skipped — they're simply absent from the mapping).
- The hook exposes `resolveDbRootId(rootPath: string): Promise<string | null>` via a ref-stable callback: it awaits an internal promise that ALWAYS settles (resolve with the map on success, an empty map on the already-logged error path), then returns `map.get(rootPath) ?? null`, warning once per unmapped path (module-level `Set` of warned paths).
- `WorkspaceCollectionSyncServiceDependencies` gains `resolveDbRootId: (rootPath: string) => Promise<string | null>`. `ResolvedSyncContext` gains `dbRootId: string | null`, resolved inside `resolveContext` (await the dep with `context.rootPath`). `runSyncPass` passes `rootId: context.dbRootId` into `runRootFolderCacheImport`.
- Provider: pass the hook's callback into the service deps. The service `useMemo` deps gain the (ref-stable) callback — it must NOT change identity per render (useCallback with empty/stable deps), so the service is not reconstructed when the mapping resolves; the await inside resolveContext handles the timing instead.

- [ ] **Step 1 (failing tests):**
  - Hook test additions: (f) `resolveDbRootId` resolves to the db id for a known path after reconciliation completes; (g) resolves `null` + warn for an unknown path; (h) when reconciliation rejected internally (restoreRoots throws), `resolveDbRootId` still settles with `null` (no hang).
  - Service test addition (use the existing `createDeps` helper in workspace-collection-sync-service-test-helpers.ts): with `resolveDbRootId: vi.fn().mockResolvedValue('root-db-1')`, a sync pass calls the import with `rootId: 'root-db-1'`; with `mockResolvedValue(null)` → `rootId: null`.
  Run → fail (type errors on the new dep are the expected red).

- [ ] **Step 2 (implement)** per the locked design. Keep the hook's existing once-guard and error-logging exactly as-is; the only change is capturing the result into the settling promise + building the path map.

- [ ] **Step 3 (verify):** `cd packages/app-shell && pnpm vitest run` (whole package); build clean. Any provider-test fallout: follow sibling mock patterns, report changes.

- [ ] **Step 4 (commit):** `feat(app-shell): sync passes resolve db root id from the roots registry` + trailer.

---

### Task 4: web FileSystemObserver (feature-detected live re-index)

**Files:**
- Modify: `packages/file-system/src/adapters/web-adapter.ts` (`watchDirectory`)
- Test: extend `packages/file-system/src/__tests__/web-adapter.test.ts`

- [ ] **Step 1:** READ the current `watchDirectory` implementation in web-adapter.ts first (the dossier did not capture its body). If it is a no-op/polling stub, wrap: when `typeof FileSystemObserver !== 'undefined'` (Chrome 133+), construct `new FileSystemObserver(callbackAdapter)`, `observe(handle._internal, { recursive: true })`, map observer records to the existing `FileSystemChange[]` shape, return a disposer calling `observer.disconnect()`; otherwise return the EXISTING behavior unchanged (explicitly not a silent fallback — the capability is feature-gated, document with a comment). TypeScript: `FileSystemObserver` has no lib.dom types yet — declare a minimal ambient type locally (follow how the file already augments FSA types, e.g. showDirectoryPicker declarations in packages/types/src/file-system.ts).
- [ ] **Step 2 (tests):** with a stubbed `globalThis.FileSystemObserver` class: watchDirectory uses it (observe called with the internal handle; emitted records reach the callback mapped correctly; disposer disconnects). Without the stub: existing behavior intact (assert no throw + previous semantics).
- [ ] **Step 3 (verify):** `cd packages/file-system && pnpm vitest run`; build clean.
- [ ] **Step 4 (commit):** `feat(file-system): FileSystemObserver-backed directory watching on web` + trailer.

---

### Task 5: sync from main, full verification, push + PR

- [ ] **Step 1:** `git fetch origin`; if main moved: update `feat/multi-root-1-db-foundation` from origin/main first, then merge upward through phase 2 into this branch (bottom-up; watch migration numbers + lane registries). Report drift handled.
- [ ] **Step 2:** `pnpm dlx ultracite fix` (expect no-op) + affected suites green package-local in one run each: db, app-shell, file-system, desktop (`pnpm test`), file-explorer-hooks; `pnpm turbo run build` for the affected filter set; both db lane checks.
- [ ] **Step 3:** push `feat/multi-root-3-queue-sync`; `gh pr create --base feat/multi-root-2-adapter-api` titled `feat: multi-root phase 3 — root-scoped background imports`; body: summary (root_id written per batch, mapping race policy, dedupe-keys-unchanged rationale, FileSystemObserver) + test plan incl. manual checks (boot desktop → import a folder → `file_records.root_id` populated and matching the `roots` row; web Chrome 133+: edit a file in a granted folder → re-index triggers without manual refresh) + the Generated-with-Claude-Code footer.

## Deferred to later phases
- Forest UI, folderStates/token-cache re-keying, watcher map, multi-root restore banner (Phase 4).
- Citations rootId (Phase 5). Snapshot tier + PWA prompt (Phase 6).
- Retiring `source_root_path` + the 029 index (after Phase 4 when nothing reads it).
