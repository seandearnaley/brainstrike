# Workspace Search — Design Spec

**Date:** 2026-07-08
**Status:** Approved (brainstorm complete, pre-implementation)
**Feature:** A Search tab beside the Explorer tab in the context-explorer right panel: VS Code-inspired workspace search over the indexed corpus, with checkbox curation of files/chunks into Tapestry.

---

## 1. Product decisions (settled with user)

| Question | Decision |
|---|---|
| Primary goal | True 50/50: navigation (click → open at line) and context curation (checkbox → Tapestry) are both first-class, with physically separate affordances. |
| Search modes | Two explicit modes: **Text** (VS Code-style literal/regex, case, whole-word — backed by `GrepSearchService`) and **Semantic** (natural language → `HybridSearchService` FTS+vector RRF). |
| Unindexed files | **Index-only v1** with an honest coverage banner. Desktop's existing live-grep dual pass (assistant-server `runLiveGrep`) is a designed-for fast-follow, not v1: every result node carries `provenance: 'index'` from day one. |
| Scope filter | **Always workspace-only.** The collection picker chooses *which index* to search; it never widens scope beyond current live workspace roots. Out-of-workspace index rows never render. |
| Replace | Out of scope. v1 is read-only. |
| Placement | **Tab strip inside the Explorer right panel** (`Explorer \| Search`) — a net-new pattern for `IdeLayout` panel content, matching VS Code's sidebar mental model. |

## 2. Architecture

New package **`packages/workspace-search`** (`@brainstrike/workspace-search`), three layers, dependency direction core ← ui ← composition:

```
packages/workspace-search/src/
  core/
    workspace-search-executor.ts   # headless: mode → service dispatch, cancellation, result shaping
    search-result-model.ts         # WorkspaceSearchResult types (file/match/chunk nodes, provenance)
    workspace-search-store.ts      # session-lived zustand: query, mode, toggles, collectionId,
                                   # expandedIds, results, status (NO checkedIds — derived, see §4)
  panel/
    workspace-search-panel.tsx     # tab content: input, toggles, picker, banner, tree
    search-input-bar.tsx           # query box + Aa / .* / \b toggles (net-new UI)
    search-mode-toggle.tsx         # Text | Semantic segmented control
    search-collection-picker.tsx   # embedding_sets dropdown (hidden when only Workspace Index exists)
    search-coverage-banner.tsx     # coverage honesty strip
    search-results-tree.tsx        # TreeTable composition (paged windowing, tri-state checkboxes)
  bridge/
    curation-selection-bridge.ts   # checked nodes ↔ workspace-context-curation-store
```

**Composition:** the tab strip lives in **app-shell** (`ExplorerSearchTabs`, mounted where `root-layout-content.tsx:268` renders `<FileExplorerPanel />` today), NOT inside `file-explorer-ui` — `workspace-search` imports the curation store from `@brainstrike/file-explorer-ui/preview`, so `file-explorer-ui` importing `workspace-search` back would be a package cycle. App-shell already depends on both sides. The search panel is lazy-mounted (`React.lazy`) so the embedder/hybrid deps stay code-split. Active tab persists in `context-explorer-layout-store` (preferences, version bump); query/results are session-only.

**Modified existing code (all additive):**
- `packages/db`: `GrepCandidateOptions`/`GrepSearchOptions`, `ChunkSearchOptions`, `FTSSearchOptions`, and `HybridSearchOptions` gain `rootIds: readonly string[]` scoping; `GrepCandidate`/`GrepMatch` gain `chunkId`, `chunkStartLine`, `chunkEndLine`; **`ElectronFileChunkRepository` gains `findGrepCandidates`** (it has `searchSimilar`/`fullTextSearch` but no grep candidate path — without it desktop-renderer Text mode cannot run).
- `packages/vector-management`: the embedder-resolution machinery (hosted/local `SearchEmbedder`, device-loss retry, visibility dispose) is **extracted from db-explorer's `use-semantic-search-executor.ts` into a shared `useSearchEmbedder`**; db-explorer is refactored to consume it (its tests stay green). Both db-explorer and workspace-search then share one embedder implementation.
- `packages/preferences`: `context-explorer-layout-store` gains `explorerActiveTab: 'explorer' | 'search'`.

**Not touched:** `OptimizedFileTree`, `FileExplorerPanel` internals, the collection-browser search UX, assistant server tools, Electron main.

## 3. Search execution & data flow

Both modes run **renderer-side against the DB** on both platforms (the collection-browser executor pattern; no new IPC).

**Text mode** → `GrepSearchService.search()`:
- `pattern`/`isRegex`/`caseSensitive` from toggles; whole-word = client-side `\b…\b` regex wrap.
- Debounced as-you-type (~250 ms), min 3 chars.
- `scanLimited` (regex without a ≥3-char literal) surfaces as a "broad pattern — results limited" notice.

**Semantic mode** → embed query → `HybridSearchService.search()`:
- Query embedding via the db-explorer `SearchEmbedder` resolution (hosted client, or local WASM/WebGPU with device-loss retry). Model/dimensions come from the **selected set** (dimension mismatch throws by design).
- Fires **on Enter only** (embedding cost); input shows "press Enter to search" affordance.
- `includeHeadline: true` for `ts_headline` snippets.

**Cancellation:** every dispatch carries AbortSignal + monotonic request seq; non-latest results dropped; mode/collection/toggle changes cancel in-flight work. AbortError is not an error.

**Workspace-only filter:** `rootIds` = roots with `status='live'` from the renderer root-identity context.
- Removing a root cascades its `file_records`; the filter's real work is scoping custom collections and excluding `needs-regrant`/`disconnected` roots.
- Legacy `root_id IS NULL` rows are **excluded** (not attributable to a current root); the coverage banner makes an un-resynced index legible.
- Files deleted within a live root may linger until resync — accepted for index-only v1; `provenance` reserves the dual-pass upgrade path.

**Result shaping:** chunk-grained hits grouped by `fileRecordId` into file nodes (path + root badge when multi-root). Text: files by path, children = match lines with context. Semantic: files by best `rrfScore`, children = chunks by score (headline, line range, score). `truncated` → "Show more" row over the services' offset/limit paging.

**Coverage banner:** reads `collection_indexing_stats` for the selected set, cross-checked against the vector-status store (dirty-gating gotcha, #1115): "indexing in progress" (live counts + progress) vs "partial/stale" (static counts + link to vector-status controls) vs complete (banner collapses). Two denominators when they diverge: chunked files (Text coverage) vs embedded chunks (Semantic coverage).

## 4. Results tree & selection bridge

**Tree:** shared `TreeTable`, `windowingStrategy: 'auto'` + `autoWindowingContext: 'search'` (paged), `nodesArePreFlattened`. Node types: file (icon, path, root badge, count, tri-state checkbox); text match (highlighted line, line number, dim context); semantic chunk (line range, headline, tokens, score — modeled on collection-browser chunk rows).

**Affordances:** row click navigates (workspace tab host / CodeSurface scrolled to line); checkbox curates. Physically separate.

**Selection unit = chunk**, in both modes. A text match's checkbox selects **its containing chunk** (hence `GrepMatch.chunkId` + range). Multiple checked matches in one chunk dedupe to one range. Rationale: Tapestry consumes line ranges; a lone matched line is rarely useful context; identical semantics across modes.

**Existing stores are the single source of truth for checked state** (revised from the earlier snapshot-merge idea after reading the code: the preview panel REBUILDS `contextSnapshot` from the file-explorer selection store, so a second snapshot producer would be clobbered on the next rebuild — and a file absent from the explorer selection never renders in Tapestry at all):
- The bridge writes to the same two stores the Explorer's own checkboxes drive: **file membership** → the `@brainstrike/file-explorer` selection store (compositeKey = `encodeFileSelection(adapterRootId, path)`, the identical mechanism as an explorer checkbox); **chunk ranges** → `setTapestryRangesForKey(compositeKey, mergedRanges)` (insert + coalesce overlaps). The preview panel remains the snapshot's ONLY producer.
- No `checkedIds` in the search store. Checkbox state is derived: file node checked ⇔ its compositeKey is in the explorer selection; chunk node checked ⇔ file selected AND (no ranges exist for the key = whole file, or its range fully covered by active ranges); partially covered ⇒ indeterminate.
- Check chunk → ensure file selected + merge its range. Uncheck chunk → remove exactly the ranges it covers; `userModified` ranges are never touched. Uncheck file → remove from selection + clear search-added ranges for its key.
- Chunk ranges take effect in Tapestry's ranges mode (`useTapestryRanges`); the panel footer notes this rather than mutating another surface's toggle.

**Token feedback:** panel footer shows "~N tokens selected" from `selectedSourceApproxTokens`.

**Select-all:** header tri-state operates on loaded (paged) results only, labeled with the affected count ("Select 42 shown").

**Dual-pass future slot:** live-only matches (no chunks) will render with disabled checkbox + "not indexed yet" tooltip — navigation works, curation requires the index.

## 5. Collection picker, coverage & platform differences

**Picker:** `EmbeddingSetsRepository.listEmbeddingSpaces({ includeStats })` behind a live query. Hidden when only the Workspace Index exists (quiet text label instead); dropdown at ≥2 sets. Options show name, "Managed" badge (`system_role='workspace-index'`), model, coverage. Selection is session-lived; resets to Workspace Index. Note surfaced in UI: chunks are duplicated per set, so switching collections switches the **Text corpus** too, not just the vector space.

**Semantic gating (no silent fallback):** hosted model w/o key → toggle disabled "Requires <provider> key (Settings)"; local runtime unavailable → disabled with reason; zero embedded chunks → structured "index not ready" empty-state with coverage numbers. Text mode is never gated by embedding state.

**Desktop vs web:** identical modes/tree/bridge/picker/banner. Web-only: `needs-regrant` FSA roots excluded from `rootIds`; banner adds "N folders need access restore" linking to the existing restore flow. Desktop-only future: live-grep dual pass. Known inherited gap (not solved here): visible-renderer query embedding can contend with the hidden host's GPU during background indexing — pre-existing collection-browser behavior; coordinating through the foreground gate is a follow-up.

## 6. Error handling

- Regex validated client-side pre-dispatch (`new RegExp` try) → inline input error, no request.
- Embedding failures: device-loss single retry (existing pattern); surviving failures → inline error card with named cause + Retry. Key auth failures say so.
- Structured degradations rendered as notices, never swallowed: `scanLimited`, `truncated`/`candidatesTruncated` ("Show more"), `skippedMissingLineMetadata` ("N results need a rebuilt index").
- Bridge range math is pure functions. Scoped logger `createLogger('WorkspaceSearch')`.

## 7. Testing (RED/GREEN TDD)

- **`packages/db` real-PGlite integration:** `rootIds` scoping across hybrid/FTS/vector (live-root hit, disconnected-root miss, NULL-root exclusion); `GrepMatch` chunk enrichment. Register new `packages/db/__tests__` files in **both** `test-lanes.mjs` and `coverage-lanes.mjs` (#1101 trap).
- **`packages/workspace-search` unit:** executor (dispatch, debounce-vs-Enter, seq staleness, cancellation); **bridge** (coalescing; merge preserves preview-panel entries; uncheck removes only search-added ranges, `userModified` untouched; derived tri-state); UI (tree states, rollup, banner states, gating reasons, picker visibility).
- **E2E:** one web smoke + one desktop smoke (open Search tab → text search seeded content → check chunk → Tapestry range asserted). Deeper scenarios → nightly regression.
- **Manual:** built desktop app over CDP (`connectOverCDP` recipe) for the real-GPU semantic path.
- Exit bar: build + lint + typecheck + unit green in the same run.

## 8. Out of scope / follow-ups

- Search-and-replace.
- Disk-scan (live) search: desktop dual-pass via `runLiveGrep` behind a renderer-reachable seam; web has no live pass.
- Foreground-gate coordination for visible-renderer query embeddings (pre-existing gap).
- Include/exclude glob filters (VS Code parity nicety — add post-v1 if wanted).
- Activity-bar entry point (second entry point deferred; tab strip is the v1 entry).
- **Header select-all (§4)** — user-approved deferral; per-row tri-state
  checkboxes only in v1 (no group/header "select all matches").
- **Show-more paging (§3)** — user-approved deferral; truncated results state an
  honest "Results limited to first N matches" instead of an active pager. Wire
  `onShowMore` + offset paging when adding it.
- **Line-targeted `openFileInTab`** — controller `onOpenFile` drops the `line`
  arg (`IdeFileEditorContext` accepts only the compositeKey). Extend that seam to
  scroll the opened tab to the match line.
- **Nightly seeded-fixture E2E** — the results→selection round trip (seed an
  indexed fixture → Search → assert a treegrid result row + checkbox drives
  selection); the fast smokes only assert mount/wire + honest error state.
- **Assistant grep tool carries chunk metadata** — `GrepMatch` now includes
  `chunkId`/`chunkStartLine`/`chunkEndLine` (needed by workspace-search text
  mode); consider stripping these in the assistant tool-result mapping so they
  don't spend the tool-output token budget.
- **Root-barrel import partially defeats code-split** — app-shell statically
  imports `@brainstrike/workspace-search` (controller + the factory-reset store
  registration in root-layout-content), pulling the panel into the main bundle
  and defeating the lazy split in `explorer-search-tabs.tsx`. A `core` subpath
  export (store/model only) would let always-mounted code register without the
  panel/UI graph.
- **Picker zero-sets label** — the collection picker's empty-state copy when no
  embedding sets exist.

## 9. Key existing seams (reference)

- `packages/db/src/search/grep-search-service.ts` — `GrepSearchOptions` (`embeddingSetId`, `rootId`), `GrepSearchResult` flags.
- `packages/db/src/search/hybrid-search-service.ts` + `rrf.ts`; `FileChunkRepository.fullTextSearch` (`file-chunk-repository.ts:508`), `searchSimilar` (`:327`), `findGrepCandidates` (`:620`).
- `packages/db/src/repositories/embedding-sets-repository.ts` — `listEmbeddingSpaces`, `getOrCreateWorkspaceIndexSet`; `WORKSPACE_INDEX_SYSTEM_ROLE` (`models/embedding-set.ts`).
- `packages/ui/src/tree-table/*` — `TreeNode<T>`, `autoWindowingContext: 'search'`, tri-state `CheckboxState`.
- `packages/ui/src/collection-browser/use-collection-tree.ts` — chunk-node rendering precedent.
- `packages/file-explorer-ui/src/workspace-context-curation-store.ts` — `setContextSnapshot`, `setTapestryRangesForKey`, `WorkspaceContextCuratedFile`, `TapestryRange`.
- `packages/db-explorer/src/hooks/use-semantic-search-executor.ts` — embedder resolution + device-loss retry pattern.
- `packages/app-shell/src/roots/root-identity-context.tsx` — live-root resolution.
- `apps/desktop/src/assistant-server/{grep-search-tool,live-grep}.ts` — dual-pass provenance model (fast-follow reference).
