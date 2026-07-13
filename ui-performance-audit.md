# UI Performance Audit — High-Impact Findings

**Date:** 2026-07-12
**Scope:** `packages/ui`, `packages/app-shell`, `packages/agent` (chat surface), `packages/file-explorer-ui` (+hooks/worker), `packages/db-explorer`, `packages/vector-management`, `packages/workspace-search`, `packages/preferences`, `packages/hooks`, `apps/web`, `apps/desktop` (renderer).
**Method:** Six independent audit passes (five Claude agents by surface slice + one gpt-5.6/Codex whole-surface pass), findings deduplicated and the top claims re-verified by hand against source. Library-level mitigation claims were checked against the installed `@assistant-ui` 0.14.x sources.
**Bar:** hot paths only — per stream chunk, per keystroke, per scroll/pointer frame, or O(large N). Style nits and cold paths excluded.

---

## Executive summary

The codebase avoids the classic "whole transcript re-renders per token" bug (part-level memoization, coalesced runtime snapshots, and debounced search are all in place), but **13 high-severity issues** cluster in four hot loops:

| # | Finding | Surface | Hot loop |
|---|---------|---------|----------|
| 1 | Tool-card context churn + eager `JSON.stringify` per chunk | Chat | per stream chunk |
| 2 | Shell output re-accumulated O(slices²) | Chat | per stream chunk |
| 3 | Full markdown re-parse of the growing message per chunk | Chat | per stream chunk |
| 4 | Shared TreeTable row memoization fully defeated | All tree/grid views | per render/scroll |
| 5 | Scroll events synchronously persist whole view-state store to localStorage | Editor/markdown tabs | per scroll event |
| 6 | Full-tree rematerialization ×2 per directory expand | File tree | per expand, O(workspace) |
| 7 | Tapestry file bases rebuilt for every selected file per token tick | Context Explorer | per 100 ms tick |
| 8 | Tapestry range drag writes store per frame, re-renders whole PreviewPanel | Context Explorer | per pointer frame |
| 9 | Indexing import progress unthrottled → assistant panel re-render per file | App shell | per indexed file |
| 10 | Model download progress → app-wide store churn + localStorage per tick | App shell | per download tick |
| 11 | Indexing activity coordinator polls forever, no idle gate, identity churn | App shell | 2–3×/s, always |
| 12 | Collection browser: whole-store subscription + persist per keystroke/drag frame | DB Explorer | per keystroke/frame |
| 13 | Quick filter clones the whole retained tree per (deferred) keystroke | File tree | per keystroke, O(tree) |

The single highest-leverage fix is **#4** (one shared component, four major consumers). The chat trio (#1–#3) compounds on every agentic turn and is worst exactly when the model streams after heavy tool use. #9–#11 make the app burn CPU while indexing or idling.

**Verification status:** findings 1–6 and 9–12 were re-verified line-by-line by the coordinating reviewer; 7–8 and 13 were verified by the slice auditor with code excerpts and are consistent with the store/component wiring checked for the other findings.

---

## A. Assistant chat surface (per-stream-chunk costs)

### 1. Every tool card in the streaming turn re-renders per chunk and eagerly stringifies its full result — HIGH

**Files:**
- `packages/ui/src/assistant-ui-panel/assistant-ui-panel.tsx:517–554, 633–638`
- `packages/ui/src/assistant-ui-panel/tool-fallback.tsx:137–149, 271`
- `packages/ui/src/assistant-ui-panel/tool-duration-context.tsx` / `shell-output-context.tsx`

`LocalChainOfThought` selects `state.message.parts` (new identity per streamed chunk) and derives five values from it per chunk:

```ts
const toolActivity      = useMemo(() => summarizeToolActivity(messageParts), [messageParts]);
const activityFallbackMs= useMemo(() => runEventsSpanMs(messageParts), [messageParts]);
const toolDurations     = useMemo(() => collectToolDurations(messageParts), [messageParts]);
const shellOutputs      = useMemo(() => collectShellOutputs(messageParts), [messageParts]);
const taskList          = useMemo(() => deriveTaskListFromParts(messageParts), [messageParts]);
```

`toolDurations` and `shellOutputs` are fresh `Record` identities every chunk and feed `<ToolDurationProvider>` / `<ShellOutputProvider>`. Every `ToolFallback` reads these contexts, so **every tool card in the active turn re-renders on every text-delta chunk**, defeating assistant-ui's part-level memoization. Each render runs `formatResult(result)` — `JSON.stringify(result, null, 2)` — even while the details pane is collapsed. Tool results are budgeted at ~3,000 tokens (≈12 KB serialized; `packages/agent/src/stream/tool-output-limits.ts:15`), so a 20-tool turn can stringify ~240 KB per chunk at 20–60 chunks/s.

**Impact:** visible typing/streaming jank on agentic turns, proportional to tool count.
**Fix:** make provider values value-stable (content-key memo or ref-backed store with per-`toolCallId` subscription), and compute `formattedResult` inside the details pane behind `useMemo`, only when expanded.

### 2. Live shell output rebuilt from scratch per chunk — O(slices²) — HIGH

**Files:** `packages/ui/src/assistant-ui-panel/shell-output-parts.ts:23–50`, consumed at `assistant-ui-panel.tsx:553`.

Each streamed shell slice is a separate transient `brainstrike.shell-output` data part appended to `message.parts`. On **every** stream update (including unrelated text deltas), `collectShellOutputs` walks all parts and re-concatenates the entire accumulated output from zero (`existing.text += chunk` across all slices). With the 256 KB per-command stream cap (`apps/desktop/src/assistant-server/execute-command-tool.ts:37`), a chatty build/test command approaches ~256 KB of fresh string building per chunk, and the slice parts permanently inflate `message.parts`, making every other per-chunk O(parts) scan (findings 1, 14) slower for the rest of the turn.

**Impact:** UI stutters/freezes while a verbose `execute_command` streams; cost grows quadratically with slice count. Corroborated independently by two auditors.
**Fix:** accumulate incrementally (cache keyed on parts-array prefix length, or fold slices into a keyed external store as they arrive); subscribe each tool card only to its own entry.

### 3. Streaming markdown re-parses the full accumulated document on every chunk — HIGH

**File:** `packages/ui/src/assistant-ui-panel/markdown-text.tsx:28–34`.

`MarkdownTextPrimitive` is rendered without `defer`. Verified in the installed `@assistant-ui/react-markdown` 0.14.5: `defer = false` is the default, and the internal `useDeferredValue` on the text is only used when `defer` is set. So each chunk synchronously runs the full remark/GFM parse over all text accumulated so far. The existing `memoizeMarkdownComponents` + shiki `delay={50}` mitigations spare unchanged rendered blocks and highlight churn — **they do not avoid the parse**, which grows linearly with message length (quadratic total over a long response).

**Impact:** long responses get progressively janker while streaming, especially around tables/lists/code blocks.
**Fix:** enable `defer` (parse at deferred priority, coalescing chunks under load) — a near-one-line change — and consider bounding parse cadence while `status === 'running'`.

### 4 (chat, MEDIUM). Notification bridge scans the entire transcript twice per store update
`packages/ui/src/assistant-ui-panel/run-lifecycle-notifications.ts:122–163` — two selectors each walk every part of every hydrated message (up to 80) and `JSON.stringify` matches on **every** store update (every chunk, every composer keystroke), then re-`JSON.parse` in effects. Linear in conversation length, stacking on findings 1–2. Fix: serialize stable event ids only, or derive from the last message with a cached prefix (events are append-only). *(One auditor considered this a deliberate value-stability pattern; the pattern is fine — the per-update full-transcript walk is the cost.)*

### 5 (chat, MEDIUM). Composer keystrokes re-render the whole thread shell
`packages/ui/src/assistant-ui-panel/composer-draft-command.ts:29` subscribes `ChatThreadUI` to `state.composer.text`, so the header (`ModelPicker`, controls, context meter) re-renders per keystroke. Message rows are protected by the library's memo; the un-memoized header subtree is not. Fix: move the subscription into a leaf bridge component.

### 6 (chat, MEDIUM). History collapse is CSS-only; all hydrated messages fully mount
`packages/ui/src/assistant-ui-panel/overrides.css:503–506` hides all but 8 messages with `display:none`, but React still mounts, parses markdown for, and syntax-highlights all 80 hydrated messages on thread open, and hidden rows keep their per-update selector subscriptions. Fix: window with `ThreadPrimitive.Unstable_MessageById` / `unstable_useThreadMessageIds`, or skip mounting collapsed rows.

### 7 (chat, MEDIUM, opt-in). Developer detail mode is quadratic per chunk
`assistant-ui-panel.tsx:105–142` + `assistant-run-timeline.tsx:120–126` — each run-event row runs two O(total parts) scans per store update → O(rows × parts) per chunk in Developer detail mode. Fix: one shared pass building an id→status map per update.

---

## B. Shared TreeTable (all tree/grid surfaces)

### 8. Row memoization is fully defeated: unstable `onClick` on every row, plus per-render re-measurement — HIGH

**Files:**
- `packages/ui/src/tree-table/use-tree-keyboard.ts:525–535`
- `packages/ui/src/tree-table/use-tree-table-handlers.ts:122–151, 203–210`
- `packages/ui/src/tree-table/tree-table.tsx:1064–1071, 1095`
- `packages/ui/src/tree-table/tree-table-row.tsx:426–428`

Verified line-by-line:

1. `useTreeKeyboard` rebuilds its `actions` object literal on every render (members are stable `useCallback`s; the wrapper object is not memoized).
2. `handleRowClick` lists `keyboard.actions` in its deps → **new function identity on every TreeTable render**, passed as `onClick` to every `TreeTableRow`, whose `React.memo` therefore never bails out.
3. `tree-table.tsx:1064` passes an inline `rowVirtualizer` adapter object into the handlers hook, so `measureRow` is also new each render. When `rowHeight` isn't a fixed number (the default), it's spread as a callback ref onto every row — each commit detaches/reattaches the ref, calling `rowVirtualizer.measureElement(el)` (a synchronous layout read) for every rendered row on every render.

TanStack react-virtual re-renders TreeTable on every scroll notification; focus moves and selection changes do too. Consumers hit: file explorer tree (`optimized-file-tree.tsx:1218`, thousands of nodes — leg 1), workspace-search results and file-explorer preview table (no `rowHeight` prop — **both legs**, including forced layout reads per row per render), collection browser.

**Impact:** all visible rows re-run their `column.cell` renderers on every scroll event/arrow-key move/selection change; janky scrolling and sluggish keyboard navigation in every large tree/list in the app. The careful per-node selection-store engineering in the file explorer is currently being bypassed by this upstream defect.
**Fix:** memoize the `actions` object; make `measureRow` a stable callback reading `isVirtualWindowing`/`measureElement` through refs. Two small, contained changes with app-wide payoff.

---

## C. File explorer, editor surfaces, Tapestry

### 9. Scroll events synchronously serialize + persist the whole view-state store — HIGH

**Files:** `packages/ui/src/markdown-surface/markdown-surface.tsx:95–99`, `packages/ui/src/code-surface/code-surface.tsx:249–253`, `packages/file-explorer-ui/src/shell/workspace-tab-host.tsx` (wiring), `packages/file-explorer-ui/src/stores/editor-view-state-store.ts:119–120, 127–140`.

Both surfaces forward **every native scroll event** to `setScrollTop`, which copies the full `scrollTops` record and — via zustand `persist` — `JSON.stringify`s `modes` + `scrollTops` + `selections` and calls `localStorage.setItem` synchronously. No throttle, no unchanged-value guard; cost grows with accumulated tab entries.

**Impact:** stutter while scrolling large source/markdown files.
**Fix:** keep scroll position transient during scrolling; persist a deduplicated snapshot on trailing debounce / tab switch / unmount.

### 10. Directory expand rematerializes the entire tree — twice — HIGH

**Files:** `packages/file-explorer-ui/src/utils/normalized-file-tree.ts:234–282`, `packages/file-explorer-ui/src/tree/use-lazy-file-tree.ts:1042–1052, 1392, 1543`.

Verified: `materializeNormalizedFileTree` allocates a brand-new `IFileNode` for **every node** with zero structural sharing, and `commitNormalizedTree` runs it on every state transition — including the commit that merely flips one node's `loadState` to `'loading'`, then again on success. Each commit then cascades into further O(N) passes keyed on tree identity (`buildFileNodeCache`, `fileSizes` map, `collectTreePaths`) and cold-starts the `WeakMap`-keyed memo caches because every node object is new.

**Impact:** expanding one directory in a 50k-node workspace = 2 × 50k allocations + several O(N) rebuilds; expand latency scales with workspace size, not subtree size.
**Fix:** structural sharing (reuse unchanged subtree objects, invalidate only the touched ancestor chain); skip display-tree rehydration for the loading-marker commit.

### 11. Tapestry file bases rebuilt for every selected file on every token tick — HIGH

**Files:** `packages/file-explorer-ui/src/preview/preview-panel.tsx:313–356, 408–431`, `use-preview-panel-state.ts:247–291`, `tapestry-adapter.ts:50–90`.

The per-file cache is keyed on `TableRowData` **object identity**, but `tableData` rebuilds new row objects whenever `flatListItems` changes — and `flatListItems` depends on `tokenVersion`, bumped every ~100 ms for the whole duration of background token counting. Each tick invalidates the cache for **all** files and re-runs `splitContentLines` + `buildStructureFromContent` (regex per line, two passes) over every selected file's full content, on the main thread, and invalidates `file.structure` identity, defeating the minimap SVG memo (up to 320 rects/card). Not gated by whether the Tapestry tab is even active.

**Impact:** the "select a big folder" flow janks exactly while the token meter counts up (O(total selected content) per tick).
**Fix:** key the cache on `(compositeKey, content, isLoading)`; gate base building behind `isTapestryActive`.

### 12. Tapestry range drag: store write per pointer frame re-renders the whole PreviewPanel — HIGH

**Files:** `packages/file-explorer-ui/src/tapestry/tapestry-view.tsx:420–506`, `preview-panel.tsx:178–180, 258–285, 358–406, 712–747`, `utils/context-selected-token-summary.ts:92–117`.

The drag loop is rAF-throttled, but each frame commits `setTapestryRangesByKey` (new map identity), and `PreviewPanel` subscribes to it — so **every drag frame re-renders the 1,100-line panel**, rebuilds fresh `FileTapestry` objects for all ~24 on-page cards (defeating the `Minimap` memo for 23 untouched cards), and on the deferred cadence re-splits every ranged file's content for token summaries plus rewrites the workspace-context snapshot (notifying cross-subtree subscribers).

**Impact:** clip drag/resize gets progressively laggier with more selected/ranged files.
**Fix:** per-file identity preservation in `buildTapestryFile`; reuse already-split lines; commit the store write on drag end (per-frame updates stay local).

### 13. Quick filter clones the whole retained tree per (deferred) keystroke — MEDIUM–HIGH

**Files:** `packages/file-explorer-ui/src/utils/quick-filter-tree.ts:124–157`, `shell/file-explorer-panel.tsx:525–546`, `shell/file-explorer-sidebar.tsx:404–415`.

Verified: `applyQuickFilterToTree` recursively clones every retained directory, and `collectVisibleFiles` immediately performs a second full traversal; forest mode repeats per root. `useDeferredValue` keeps typing responsive (input priority) but the deferred render itself is a single uninterruptible O(tree) pass on the main thread — none of this is offloaded to the tree worker. *(Auditors disagreed on severity: the deferral is a genuine mitigation for input latency, so this is graded on the freeze-before-results-update in very large workspaces, not on typing lag.)*

**Fix:** filter the normalized path index in the existing tree worker (return matching/ancestor IDs); avoid materializing a cloned tree then rescanning it.

---

## D. App shell, indexing, downloads, polling

### 14. Indexing import progress is unthrottled and re-renders the assistant panel per file — HIGH

**Files:** `packages/app-shell/src/background-indexing/workspace-collection-sync-import.ts:903–909`, `workspace-collection-sync-service.ts:961–972`, `assistant-ui-panel-wrapper.tsx:690–719`, `hooks/use-assistant-thread-request-data.ts:94–134`.

Verified: the import pipeline calls `onProgress` once **per file read**, `setStatus` applies every patch unconditionally with fresh `queueProgress` objects, and `AssistantUiPanelWrapper` live-subscribes to `queueProgress` → `workspaceIndex` memo → `requestData` → new `prepareRequestData` → props change on the (un-memoized) `AssistantUiPanel`. Only the *scanning* phase has a 100 ms throttle; import/chunking/embedding progress does not.

**Impact:** during initial indexing of thousands of files, the heaviest panel in the app re-renders per file — a sustained re-render storm concurrent with DB/embedding work; typing jank in the composer.
**Fix:** route `setStatus` through the existing 100–250 ms throttle pattern; read sync status via `getState()` inside `prepareRequestData` instead of live-subscribing (it's only needed at request time).

### 15. Model download progress: app-wide identity churn + localStorage write per tick — HIGH

**Files:** `packages/preferences/src/stores/model-registry-store.ts:304–315, 372–375`, `packages/app-shell/src/hooks/use-assistant-availability-with-local.ts:27`, `packages/preferences/src/components/global-download-indicator.tsx:6`, `assistant-ui-panel-wrapper.tsx:212–213`.

Verified: `setDownloadProgress` clones `downloadedModels` on **every** tick (identity churn even when no flag flips), triggering a persist `JSON.stringify` + sync `localStorage.setItem` per tick. Transformers.js progress callbacks fire many times per second for GB-scale files. Consumers include a bare `useModelRegistryStore()` (whole-store) subscription in `use-assistant-availability-with-local` — parent of the entire assistant subtree — plus the always-mounted `GlobalDownloadIndicator` and the wrapper's `downloadedModels` selector. Found independently by two auditors.

**Impact:** for the minutes a download runs, every tick re-renders the assistant wrapper + panel and writes storage, while the renderer is also decompressing the download.
**Fix:** only rebuild `downloadedModels` on the 100% transition; round progress to integer percent and no-op on unchanged; replace the whole-store subscription with narrow selectors.

### 16. Indexing activity coordinator: always-on 0.5–1 s polls, no idle gate, guaranteed re-renders — HIGH

**Files:** `packages/vector-management/src/indexing-activity-coordinator.tsx:41–43, 229–231, 282–284, 447–449`, `packages/preferences/src/stores/indexing-activity-store.ts:410–465`, consumer `packages/app-shell/src/status-items/indexing-status-item.tsx` (always mounted).

Verified: three `setInterval`s (500 ms IPC scheduler snapshot, 1 s `job_queue` aggregate scan, 1 s managed-collection stats) run unconditionally from app mount — no `isAppActive()` gate anywhere in the file — and the app disables Chromium background throttling, so they continue while the window is hidden. Every setter stamps `lastUpdatedAt: now()`, giving the snapshot a fresh identity 2–3×/s **even when nothing changed**, re-rendering the status-bar item at that cadence forever. The predecessor it replaced (`EmbeddingJobQueueTracker`, now unmounted) had both protections: visibility gating and snapshot equality dedupe.

**Impact:** continuous PGlite/IPC traffic and 1–2 Hz React churn app-wide, including when idle/backgrounded — CPU and battery drain on desktop.
**Fix:** gate all three loops on `isAppActive()`; make setters no-op on value-equal snapshots (bump `lastUpdatedAt` only on actual change) — i.e., restore the two protections the predecessor had.

### 17. Collection browser: whole-store subscription + persist on every keystroke and drag frame — HIGH

**Files:** `packages/db-explorer/src/components/collection-browser-view.tsx:389–438, 922–930`, `packages/db-explorer/src/stores/collection-browser-store.ts:162, 201–343`, `packages/ui/src/collection-browser/filter-controls.tsx:50`, `search-mode-bar.tsx:43`.

Verified: the 1,360-line view destructures the **entire store** (`useCollectionBrowserStore()` with no selector), both search inputs write per keystroke with no debounce, `onLayoutChange` writes `inspectorWidth` per pointer-move frame, and the persist middleware `JSON.stringify`s the full partialized state (including `expandedIds`, which can hold thousands of entries after Expand All) + sync `localStorage.setItem` on every `set()`. Scoped selectors already exist in the store (`collectionBrowserSelectors`) but are unused.

**Impact:** typing in either search box or dragging the inspector splitter janks the app's primary data-grid surface.
**Fix:** use the existing scoped selectors; drop `searchQuery`/`semanticQuery` from `partialize` (or debounce persistence); commit `inspectorWidth` on drag end.

### 18 (MEDIUM). Hidden Prompt Workbench re-renders on every composer keystroke
`packages/app-shell/src/connected-prompt-manager.tsx:299–301` subscribes to the live draft text with no `suggestionsEnabled` gate, and `agent-sidebar-panel.tsx` keeps the Prompts tab force-mounted after first activation — so after visiting Prompts once, every chat keystroke reconciles the hidden 1,262-line workbench indefinitely. Fix: select `''` unless `suggestionsEnabled && activeThreadId`.

### 19 (MEDIUM). Perpetual rAF loop keeps the desktop renderer awake
`apps/desktop/src/renderer/components/root-layout-content.tsx:155–262` — a frame-stall diagnostic re-arms `requestAnimationFrame` unconditionally forever, forcing Chromium to produce BeginFrames at vsync even when fully idle (and skewing the frame-health numbers it reports). Fix: sample in short bursts from the existing 15 s interval, or use `PerformanceObserver('longtask')`.

### 20 (MEDIUM). Collection-browser text search lowercases every field (incl. full chunk content) ×3 passes
`packages/ui/src/collection-browser/use-collection-tree.ts:250–289, 427–434` — per query change, three independent traversals each re-lowercase every searchable field including full chunk content (multiple MB for large collections). Typing stays responsive via deferral, but the deferred pass freezes before results update. Fix: precompute one lowercase searchable string per node at tree build; share one match set.

### 21 (MEDIUM). Log viewer re-sorts and re-stringifies the whole buffer per log record
`packages/preferences/src/settings/system/log-viewer-components/log-viewer.tsx:367–436` — every notification re-sorts up to 2,000 records and rebuilds `tableData` with `JSON.stringify` per row for all filtered rows, though only ~50 render. O(n²) during bursts — exactly when users open it to debug imports. Fix: lazy per-cell serialization; batch subscription updates.

---

## Latent traps (not currently hot, worth removing)

- **Dead hooks that would be perf bugs if ever wired** (no consumers today): `packages/db-explorer/src/use-pending-chunks.ts` (unbounded `job_queue` SELECT every 2 s + fresh `Set` identity per poll), `packages/db-explorer/src/hooks/use-file-collection-status.ts` (LIMIT-less GROUP BY live query over all files × chunks), `packages/db-explorer/src/hooks/use-search-functionality.ts`.
- **`EmbeddingJobQueueTracker`** is well-built (visibility gate + equality dedupe) but unmounted; its replacement dropped both protections (finding 16). Either re-home the protections or delete the tracker.

---

## What's in good shape (verified, no action needed)

- **Streaming runtime core:** snapshots coalesce with back-pressure (`local-runtime-adapter.ts`), finished part objects keep identity across snapshots, the data-stream runtime adapter is identity-stable — no per-token runtime rebuilds, and no per-chunk DB writes (history `append()` is a deliberate no-op; Mastra owns persistence).
- **Workspace search:** exemplary — 250 ms debounce + 3-char minimum, generation tokens dropping stale completions, hard result caps with explicit paging, windowed TreeTable.
- **File-tree selection:** per-node external store + `useSyncExternalStore` with stable snapshots; selection toggles re-render only affected cells (once finding 8 restores row memoization).
- **Tree virtualization & worker flattening:** virtual windowing with stable path keys; worker flattening above 10k nodes.
- **Terminal:** pty data written imperatively to xterm, no React state per chunk; resize debounced.
- **Quick-open / file mentions / prompt suggestions:** all debounced and abort-gated.
- **db-explorer data grids:** page-scoped LIMIT/OFFSET, embedding columns never selected, live queries paused during import; vector queue state disables its six live queries during import/backfill to dodge invalidation storms.
- **Panel/IDE layout resize:** rAF-coalesced with deferred persistence.

---

## Suggested fix order

1. **#8 TreeTable memo defeat** — two small changes, benefits every tree/grid surface at once.
2. **#3 markdown `defer`** — near-one-line, big streaming win; then **#1 + #2** together (same component cluster, shared fix shape: stable per-toolCallId stores).
3. **#16 + #15 + #14** — the "app burns CPU while indexing/downloading/idling" cluster; all three are throttle/equality-guard fixes with existing in-repo patterns to copy.
4. **#9 scroll persist + #17 collection browser** — same fix shape (debounced persistence, scoped selectors).
5. **#10 tree rematerialization, #11/#12 Tapestry, #13 quick filter** — larger structural changes in file-explorer-ui; #10 first (it multiplies everything else in that surface).

---

*Audit passes: 5 × Claude (slice-scoped, evidence-required prompts) + 1 × gpt-5.6/Codex (independent whole-surface). All high-severity findings were either re-verified by hand or independently reported by ≥2 auditors; the two auditor disagreements (markdown re-parse severity, quick-filter severity) were settled by reading the installed library source and are noted inline.*
