# Workspace Search panel — evidence

Supports `docs/agents/explorer-search-tapestry.md` § "WORKSPACE SEARCH".
Read before changing the Explorer|Search panel, its session store, its result tree, or the chunk-selection bridge.

The record below is the pre-distillation contract text for this topic,
extracted verbatim (`sed -n '5,116p' docs/agents/explorer-search-tapestry.md`,
2026-09-21). It is historical: correct a wrong fact inline, otherwise append.

## Record (verbatim)

## WORKSPACE SEARCH

The Explorer|Search panel (`packages/workspace-search`, composed by
`packages/app-shell/src/use-workspace-search-controller.ts` +
`explorer-search-tabs.tsx`).

- **Renderer-only execution.** BOTH modes (text/grep and semantic) query the DB
  from the renderer via the platform repositories — NO assistant-server
  dependency. Text mode uses `GrepSearchService`; the controller prefers the
  platform `chunkRepository` when it exposes `findGrepCandidates` (desktop's
  ElectronFileChunkRepository) and falls back to a query-only PGlite
  `FileChunkRepository` on web.

  > CORRECTED 2026-09-21: the capability-sniffing fallback above is gone.
  > `use-workspace-search-controller.ts` always builds
  > `createGrepSearchService(chunkRepository)` on the platform repository; the
  > query-only PGlite web fallback was removed, and no `findGrepCandidates`
  > detection remains.
- **Always workspace-scoped.** Every query passes `rootIds` = live mounted
  workspace roots (`rootIdentity.workspaceDbRootIds`); legacy NULL-root rows are
  excluded. Empty rootIds = no results (never an unscoped scan).
- **Root attribution in results.** File rows show their root badge whenever the
  workspace mounts MULTIPLE roots (`workspaceRootCount` threaded from the panel
  into `SearchResultsTree`), not merely when the result set happens to span >1
  root — in a forest, a single-root result set is otherwise unattributable.
  Falls back to result-set root diversity when the count is not provided.
- **In-flight invalidation.** The session store (`workspace-search-store.ts`)
  carries a monotonic `generation`; `beginSearch` + every mode/collection/toggle
  change (and `clearResults`) increment it, and `resolveResults`/`failSearch`
  no-op unless the generation still matches — a superseded run can never clobber
  fresher state. A text query shrinking below the 3-char minimum calls
  `clearResults` (drops stale matches + bumps the generation so the in-flight
  longer-query run cannot resurrect them).
- **Tree shape (chunk-first).** Text mode is `file → chunk → match`
  (`build-tree-nodes.ts` groups matches by `chunkId`, node id `c:${chunkId}`):
  the CHUNK row carries the only child checkbox (bridge `toggleChunk`/`chunkState`
  keyed by `chunkId`), match rows (`m:${chunkId}:${line}`) are navigation-only
  leaves. Semantic mode stays `file → chunk`. The chunk is the single visible
  selection unit — a per-match checkbox flipped its chunk siblings. `resolveResults`
  default-expands file ids AND every text `c:${chunkId}`. Every row reserves the
  expand-toggle column (`reserveToggleSpace` default) so file (depth 0) and chunk
  (depth 1) checkboxes align per level at `depth*20 + 28`px — a leaf chunk without
  the reserved spacer would indent LEFT of the file checkbox (pinned in
  `search-results-tree.test.tsx`).

  > CORRECTED 2026-09-21: the per-level offset is `depth*20 + 24`px, not 28.
  > `INDENT_WIDTH` is 20 and the toggle/spacer element is `size-6` (24px) in
  > `packages/ui/src/tree-table/tree-table-row.tsx`; the "28px" comment inside
  > `search-results-tree.tsx` is stale the same way. The RULE — every row
  > reserves the toggle column so levels align — is unchanged.
- **Line-/range-targeted open.** Row click → `onOpenFile(compositeKey, target?)`
  where `target = { line; selection? }` (match rows pass `{ line }`; chunk rows
  ALSO pass `selection: { startLine, endLine }`) → controller
  `openFileInTab(compositeKey, { line, selection? })` (ide-layout seam) →
  the workspace tabs controller (`workspace-tabs-context.tsx`, BST-1258)
  records a one-shot view target (transient, non-persisted
  `targets` slice of `editor-view-state-store`) → `CodeSurface` `initialLine`
  scrolls to the match, and `initialSelection` scrolls to AND selects the chunk's
  full line range (a real read-only CodeMirror selection, so the block is
  highlighted and ready to ⌘C). `initialSelection` wins over `initialLine`/
  restored scroll. `FileTabBody` clears the store target for that key once
  `content` has rendered (consuming it exactly once) — so a later
  tab-switch-away-and-back or close/reopen, which remounts `CodeSurface` (keyed
  on `compositeKey`), reads no target and falls back to the restored scroll
  position instead of re-applying the stale target.
- **Bridge invariant (set-based, no silent data loss).** The selected-chunk SET
  is the SOURCE OF TRUTH (`chunk-selection-store.ts`: session-lived
  `selectionsByKey[compositeKey][chunkId] = {chunkId,startLine,endLine}`). Tapestry
  ranges are a ONE-WAY derived OUTPUT — after every set mutation
  `use-search-selection-bridge.ts` re-emits `deriveSearchRanges(setValues)` (spans
  sorted + merged into the minimal covering set, stamped `origin:'search'`)
  alongside the preserved non-search ranges. Because ranges are output-only,
  merging is now SAFE (checkbox state reads the set, never the ranges) — this is
  the fix for the old subtraction-bleed defect where unchecking one overlapping
  chunk flipped its sibling. Chunk checkboxes are BINARY (`chunkState` by
  `chunkId`); the file checkbox is the ONLY tri-state (`fileState`: whole-file
  `checked` when selected with empty subset, `indeterminate` when a chunk subset
  exists, else `unchecked`). Whole-file minus one chunk is now expressible:
  unchecking a chunk under a whole-file selection CONVERTS to "every sibling result
  chunk except this one" (`toggleChunk`'s 4th arg is the file's full result-chunk
  list). Search still writes ONLY explorer file-selection + its own
  `origin:'search'` ranges; it preserves every range with `origin !== 'search'`
  on the same file verbatim through every mutation. There is no default/auto-created
  range to preserve (see TAPESTRY below) — a rangeless file is simply whole-file.
  An emptied search set writes no `[]` residue: the curation store deletes the
  key so absence-of-ranges = whole-file everywhere (empty ≡ absent).
  Round trips are idempotent: emptying the chunk subset (or the last chunk) also
  deselects the file. The curation store's snapshot producer remains the
  preview panel.
- **Not-ready sync guard.** `syncTapestryRanges` (`tapestry-range-sync.ts`) never
  clamps or records a `totals` baseline for a file whose `contentStatus !==
  'ready'` — pre-content `totalLines` is an untrusted placeholder that would
  otherwise squash a bridge-written `[1,8)` span to `[0,1)`. Ranges only
  reconcile (clamp to the real total) once content lands; there is no
  default-range stretch step (see TAPESTRY below — rangeless files stay
  rangeless).
- **Mode is user intent — never auto-rewritten; the SUBMIT is gated, not the
  mode.** The semantic gate (`use-semantic-availability.ts`, sole honest
  precondition: confirmed-zero `embeddedChunkCount` on the effective set)
  blocks ENTERING semantic in the toggle (aria-disabled button + named tooltip
  reason). It must NOT silently revert an already-selected semantic mode: the
  toggle stays mounted behind inactive tabs (forceMount latch) and availability
  is a live async signal that transiently reads unavailable mid re-embed
  (`clearEmbeddings` writes `embedded_chunk_count = 0` to
  `collection_indexing_stats` until the queue re-embeds) — an auto-revert
  flipped semantic → text in the background with nothing restoring it. NULL
  joined stats (no `collection_indexing_stats` row) are "unknown",
  optimistic-available — never coerced to 0. Because the toggle no longer
  reroutes the mode, the SUBMIT path itself must gate: `WorkspaceSearchPanel`'s
  `onSubmit` blocks a gated-semantic Enter/Retry and surfaces the reason in the
  error card, PRESERVING the mode. This is load-bearing — the semantic executor's
  hybrid search has an FTS arm scoped only by `embedding_set_id` (NOT
  `embedding IS NOT NULL`, `file-chunk-repository.ts` `fullTextSearch`), so an
  ungated semantic run against a zero-embedding set would silently return
  lexical-only results (a silent fallback), never an error. Pinned in
  `search-mode-gating.test.tsx` (entry gate + no-revert) and
  `workspace-search-panel.test.tsx` (submit gate).
- **Session-only.** The store is not persisted; it is reset on factory reset via
  the `registerFactoryResetSessionStore` seam (app-shell registers it — see
  FACTORY RESET CONTRACT). The active Explorer|Search tab persists in
  context-explorer-layout-store v3 (`explorerActiveTab`).

When changing this flow, update this section and the paired tests.
