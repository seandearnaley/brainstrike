# Handoff: Remaining Simplification Work

## Branch: `codex/harden-import-chunking` (PR #777)

## Context

This branch started as chunking lifecycle hardening (graceful stop, retry loops) but evolved into a major search infrastructure fix. The search pipeline was fully functional at the database layer but the UI was not displaying results due to two architectural mismatches:

1. **Paginated records**: The collection browser tree was built from paginated file records (50/page). Search results span ALL pages. Files on other pages had no tree nodes, so the tree showed "No matching results" despite the search executor returning 20+ results.

2. **Lazy chunk loading**: Even within a page, chunk nodes only exist in the tree after a file is expanded. Search returns chunk-level `nodeId`s (`chunk-<id>`) that don't exist until expanded.

**The fix**: When in semantic search mode with results, `treeData` is built directly from search results (which contain `fileRecordId`, `fileName`, `filePath`, `content`, `chunkId`) — bypassing paginated records entirely. This lives in `packages/db-explorer/src/components/collection-browser-view.tsx` in the `treeData` useMemo.

## Critical Lessons Learned (for agents)

### 1. The E2E test was passing with the wrong assertion text

The `getEmptyStateMessage` function in `packages/ui/src/collection-browser/collection-browser.tsx` (line 116) renders:
```
"No matching results found. Try adjusting your search query or threshold."
```
But the parent component's `emptyMessage` prop in `collection-browser-view.tsx` (line 900) had:
```
"No matching results found. Try adjusting your query or threshold."
```
Note: **"search query"** vs **"query"**. The E2E test was checking the wrong string and always passing. All assertions now use the correct text from `getEmptyStateMessage`.

### 2. The `devicePref` store migration returned undefined

`packages/preferences/src/stores/vector-preferences-store.ts` — the Zustand persist `migrate` function returned `undefined` when `persistedState` was falsy (old/missing store). This left `devicePref` as `undefined` during hydration. Fixed to return explicit defaults. The `?? 'webgpu'` fallbacks in the search hooks were then removed as redundant.

### 3. `window.once` + `removeListener` is a no-op

In `apps/desktop/src/window-lifecycle-utils.ts`, `window.once('closed', onClosed)` wraps `onClosed` internally. When the timeout fires and calls `window.removeListener('closed', onClosed)`, it passes the original reference which doesn't match the internal wrapper. Changed to `window.on` so `removeListener` actually works.

---

## Remaining Work

### Item 1: Deduplicate `loadChunkDetail` double-fetch on chunk selection

**Files**: `packages/db-explorer/src/components/collection-browser-view.tsx`

**Problem**: When a user clicks a chunk node, two independent async fetches for the same chunk fire:
- The `useEffect` at ~line 432 fires on `selectedNodeId` change and calls `loadChunkDetail(selectedNodeId)` to populate `selectedChunkDetail` for the inspector panel.
- The `handleSelect` callback at ~line 737 also calls `loadChunkDetail(originalId)` to supply the `onChunkSelect` external callback.

**Fix approach**: Remove the `loadChunkDetail` call from `handleSelect`. Instead, add a separate `useEffect` that watches `selectedChunkDetail` and calls `onChunkSelect` when it resolves:
```typescript
useEffect(() => {
  if (selectedNodeType === 'chunk' && selectedNodeId && selectedChunkDetail && onChunkSelect) {
    onChunkSelect(selectedNodeId, selectedChunkDetail);
  }
}, [selectedChunkDetail, selectedNodeId, selectedNodeType, onChunkSelect]);
```
This also eliminates the `isMountedRef` pattern (line 696) which was only needed because `handleSelect` did fire-and-forget `loadChunkDetail`.

**Risk**: Medium. The `onChunkSelect` callback timing changes slightly (fires after the effect, not inline). Verify no callers depend on synchronous-feeling behavior.

### Item 2: Add in-flight deduplication to `ensureFileChunksLoaded`

**File**: `packages/db-explorer/src/components/collection-browser-view.tsx`, ~line 418

**Problem**: `ensureFileChunksLoaded` has no dedup for in-flight requests. If `handleExpandAll` triggers expansion of 50 files simultaneously, and none have chunks cached, 50 parallel `loadFileChunkSummaries` calls fire. If the user clicks expand-all twice before the first batch returns, those 50 files get fetched again.

**Fix approach**: Add a `Map<string, Promise<DatabaseFileChunkSummary[]>>` ref keyed by `fileRecordId`:
```typescript
const inflightChunkLoads = useRef(new Map<string, Promise<DatabaseFileChunkSummary[]>>());

const ensureFileChunksLoaded = useCallback(async (fileRecordId: string) => {
  if (!loadFileChunkSummaries) return [];
  const loaded = chunks.filter((c) => c.fileRecordId === fileRecordId);
  if (loaded.length > 0) return loaded;
  const existing = inflightChunkLoads.current.get(fileRecordId);
  if (existing) return existing;
  const p = loadFileChunkSummaries(fileRecordId).finally(() => {
    inflightChunkLoads.current.delete(fileRecordId);
  });
  inflightChunkLoads.current.set(fileRecordId, p);
  return p;
}, [chunks, loadFileChunkSummaries]);
```

**Risk**: Low. Pure dedup, no behavioral change.

### Item 3: Unify `CollectionBrowserPaginationState` with `DatabaseRecordPagination`

**Files**:
- `packages/db-explorer/src/components/collection-browser-view.tsx` (defines `CollectionBrowserPaginationState`)
- `packages/db-explorer/src/use-database-demo-data.ts` (defines `DatabaseRecordPagination`)

**Problem**: Two interfaces describe the same pagination state with slightly different shapes. `CollectionBrowserPaginationState` adds callback props (`onPageChange`, `onPageSizeChange`) that `DatabaseRecordPagination` doesn't have. Adding a field to one requires remembering to update the other.

**Fix approach**: Either:
- Extend `DatabaseRecordPagination` with callback props in a new type
- Or make `CollectionBrowserViewProps` accept `DatabaseRecordPagination` plus separate callback props

**Risk**: Low. Interface refactor only, no runtime changes.

### Item 4: Extract shared `ElectronE2eFileSystemFixture` type

**Files**:
- `apps/desktop/src/ipc-handlers.ts` (interface at ~line 72)
- `apps/desktop/e2e/embedding-worker-renderer.test.ts` (interface at ~line 32)

**Problem**: The same fixture interface is declared twice with slightly different types (`SerializableFileNode[]` vs `unknown[]` for `directoriesByPath`). Changes to one won't be caught in the other since they cross the IPC/evaluate boundary.

**Fix approach**: Create `apps/desktop/e2e/types/e2e-fixture-types.ts` with the shared interface. Import in both files.

**Risk**: Low. Type-only change.

---

## Architecture Notes for Search

### How search results display works (post-fix)

```
User clicks Query
  -> SemanticSearchContext.executeSearch()
  -> SemanticSearchExecutor.searchExecutor()
     -> ensureEmbedderReady() (initializes local ONNX model)
     -> embedder.embedQuery(text) (generates 384-dim vector)
     -> hybridSearch or vectorSearch (pgvector + optional FTS)
     -> returns SemanticSearchResult[] with fileRecordId, fileName, content, chunkId
  -> setSearchResults(results) in context
  -> CollectionBrowserView reads searchResults from context
  -> treeData useMemo detects searchMode === 'semantic' && hasSearched && searchResults.length > 0
  -> Builds tree nodes directly from searchResults (bypasses paginated records)
  -> CollectionBrowser renders the search-derived tree
```

### Key files

| File | Role |
|------|------|
| `packages/db-explorer/src/contexts/semantic-search-context.tsx` | React context holding transient search state |
| `packages/db-explorer/src/hooks/use-semantic-search-executor.ts` | Creates the search executor (model init, embedding, DB query) |
| `packages/db-explorer/src/components/collection-browser-view.tsx` | Wires search results to tree data; the `treeData` useMemo is the critical integration point |
| `packages/ui/src/collection-browser/use-collection-tree.ts` | Transforms flat data into hierarchical tree; handles semantic filtering |
| `packages/ui/src/collection-browser/collection-browser.tsx` | Renders tree with `getEmptyStateMessage` (the "No matching results" source of truth) |
| `packages/db-explorer/src/use-database-demo-data.ts` | Paginated data loading; `cachedChunks` are only populated for expanded files |

### WebGPU / device preference

- The app targets **WebGPU** for embedding inference (no WASM fallback in production)
- E2E tests use WASM because headless Electron lacks WebGPU fp16 support
- `devicePref` comes from `useVectorPreferencesStore` — the store migration guarantees it's always `'webgpu'` (never `undefined`)
- The embedding worker (hidden renderer) and search embedder (visible renderer) each create their own ONNX sessions
- `backgroundThrottling: false` is set on hidden renderer windows to prevent Chromium from freezing the GPU context

### E2E test structure for search

Three search-specific E2E tests in `apps/desktop/e2e/embedding-worker-renderer.test.ts`:

1. **`end-to-end: import, embed, then vector search returns correct results`** — Small fixture (2 files), validates full pipeline including DB-level diagnostics
2. **`search renders file nodes when chunks are lazily loaded (many-file collection)`** — 100 files (exceeds page size), validates search results display across pagination. **This test was proven to FAIL without the treeData fix and PASS with it.**
3. **`search works when vector-preferences store has no devicePref (stale migration)`** — Writes a version-1 store without `devicePref`, verifies renderer survives migration and search works

All three assert the correct empty-state text (`"your search query or threshold"`) and check `resultCount > 0` via `getDatabaseDemoSemanticSearchSnapshot`.

---

## Commits on this branch (this session, chronological)

| Commit | Description |
|--------|-------------|
| `be09aba5` | Main lifecycle fix: `waitForWindowDestroyed`, `createWindow` retry loop, E2E stabilization |
| `111cd2ec` | Bot review: TOCTOU guard, retry uses closed-event, `.trim()` hoisted |
| `a6ac4e5f` | Bot review: `delete process.env` fix, `useEffect` throw -> `logger.error` |
| `4c728803` | Extract shared `waitForWindowClosed`, cache E2E loader import |
| `e600adb8` | Register listener BEFORE `destroy()`, clean up dangling listener, clear cached import on rejection |
| `098f3446` | Fix search crash: ensure `devicePref` never undefined during hydration |
| `01640330` | Add end-to-end search validation test |
| `cab8bf37` | Add FTS/tsvector diagnostics to search E2E test |
| `3f91d09f` | Fix search: build tree from search results to bypass pagination |
| `f55f8211` | Fix embedding status (`hasEmbedding: true`) and clean up dead `loadFileChunkSummaries` effect |
| `5ced192e` | Simplify: fix listener leak, embedding status fast-path, remove redundant fallbacks, single-pass iteration |
