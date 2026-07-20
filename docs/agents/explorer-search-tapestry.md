# Explorer Surfaces: Workspace Search, Markdown Viewer, Tapestry, Live Refresh

> Extracted from AGENTS.md (2026-07-12). Read before changing the Explorer|Search panel, file-tab markdown preview, per-file range model, or the tree live-refresh pipeline. Keep updated with the code.

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
- **Line-/range-targeted open.** Row click → `onOpenFile(compositeKey, target?)`
  where `target = { line; selection? }` (match rows pass `{ line }`; chunk rows
  ALSO pass `selection: { startLine, endLine }`) → controller
  `openFileInTab(compositeKey, { line, selection? })` (ide-layout seam) →
  `workspace-tab-host` records a one-shot view target (transient, non-persisted
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

---

## MARKDOWN VIEWER (FILE TABS)

Every file tab renders a slim `FileTabHeader` (filename + directory + actions
slot). Markdown files (.md/.markdown/.mdown/.mkd — NOT .mdx, source-only)
additionally get a Source/Preview toggle; preview is the default.

- **Surfaces:** `CodeSurface` (source) vs `MarkdownSurface`
  (packages/ui/src/markdown-surface/ — react-markdown v10 + remark-gfm +
  remark-math/rehype-katex + rehype-slug; shiki fences share the chat's cached
  highlighter via packages/ui/src/shiki/highlighter-core.ts; ```mermaid fences
  lazy-load mermaid). Raw HTML stays inert (no rehype-raw). Frontmatter is
  pre-extracted (packages/ui/src/markdown-surface/frontmatter.ts) into a
  properties block; invalid YAML renders visibly.
- **Mode state:** persisted per compositeKey in editor-view-state-store
  (`modes`, store version 2); preview scroll under `preview:${compositeKey}`.
  A one-shot view target (search-match open) forces source TRANSIENTLY without
  writing the store.
- **Capabilities (injected, never isElectron()):**
  `MarkdownPreviewCapabilitiesProvider` (file-explorer-ui) composed by
  app-shell's `useMarkdownPreviewCapabilitiesValue`. External links: desktop →
  `window.platform.openExternal` (allowlisted http/https/mailto in MAIN,
  apps/desktop/src/ipc-shell-handlers.ts); web → window.open noopener. Images:
  desktop → `brainstrike-asset://local/asset?path=…` (protocol handler in
  apps/desktop/src/asset-protocol.ts realpath-validates containment in mounted
  DB roots; CSP img-src includes the scheme); web → FS Access handle →
  object URL (revoked on unmount). Remote http(s) images are BLOCKED in the
  renderer (visible placeholder) — untrusted file content must not trigger
  network requests, independent of CSP. Every failure is visible (placeholder,
  toast, or error block) — no silent fallbacks.
- **Crash safety:** MarkdownPreviewErrorBoundary offers "Open in source".
- **Binary files:** the content worker stores the `BINARY_CONTENT_MESSAGE`
  sentinel (`@brainstrike/types`, exact-match — indexing/import guards key on
  it) as the tab's content; `FileTabBody` renders `BinaryFilePreview`
  (file-explorer-ui/components) instead of a code surface. Its buttons are a
  projection of the shared context-action registry (`file.reveal-in-os`,
  `file.open-in-default-app`, one copy-path variant) — same capability gating
  as the right-click menu, so web builds without fs bridges just show fewer
  buttons, and failures toast + log (no silent fallbacks). Paired test:
  `file-explorer-ui/src/shell/__tests__/file-tab-body-binary.test.tsx`.

When changing this flow, update this section and the paired tests.

---

## TAPESTRY

The per-file range model spans Explorer, Search, Tapestry, and every context
consumer (report generator, `listWorkspaceContext`, token meters).

- **Per-file rule, no global toggle.** "Files are membership, ranges are
  refinement, no ranges = whole file" — unconditional everywhere
  (`useTapestryRanges` retired). Selecting a file is membership ONLY; nothing
  seeds a materialized whole-file range. `syncTapestryRanges`
  (`tapestry-range-sync.ts`) never creates ranges for a rangeless key, only
  clamps existing ones once content is ready. Tapestry renders a rangeless
  selected file as an implicit whole-file state (soft tint, "Whole file"
  label, no drag handles); the first drag or a Search chunk check creates
  explicit ranges.
- **Reset means clear manual clips.** `TapestryControls`' "Clear manual clips"
  action → `TapestryView`'s `onResetRanges` → `preview-panel.tsx`'s
  `handleResetTapestryRanges` removes every visible file's user-owned ranges
  (including `userModified`) but preserves the latest `origin:'search'`
  ranges. A file with no remaining ranges returns to implicit whole-file
  context; Search remains the sole owner of its derived clips.
- **`origin:'search'` is one-way derived.** Workspace Search's chunk-selection
  set drives it (see WORKSPACE SEARCH's bridge invariant above); hand-edit
  machinery never writes or reads it, and any `userModified` ranges on the
  same file survive every search mutation untouched.
- **Spatial precision and context actions.** The overview is deliberately
  bounded for large files; the pointer-following code lens and click-pinned
  precision selector resolve exact lines against ready content. Only one
  pinned selector may own the gallery at a time. Tapestry right-click actions
  use immutable `tapestry-document` / `tapestry-range` targets projected by
  the shared `ActionContextMenu`; range color, include/exclude, exact-create,
  and clear actions are surface-local registry actions with explicit
  `ActionOutcome` failures. Never reintroduce hand-rolled Radix menus here.
- **Four deliberate default-user behavior changes (spec-approved; do not "fix"
  back):** (a) `report-generator.ts` framing flips from a whole-file
  `<selection>` wrapper to bare `<file>` for untouched files (content
  identical); (b) `rangeAdjustedFilesCount`/`activeRangeFilesCount` stop
  counting untouched (rangeless) files; (c) `outputApproxTokens` is the file's
  real token count instead of `null` when rangeless; (d) token meters/
  summaries lock to the single "Output" presentation (no per-mode toggle).
- **Key files:** `packages/file-explorer-ui/src/utils/tapestry-range-sync.ts`,
  `packages/file-explorer-ui/src/preview/preview-panel.tsx`,
  `packages/utils/src/report-generator.ts`,
  `apps/desktop/src/assistant-server/assistant-tools.ts` (`listWorkspaceContext`
  `detail: true` gate for per-file ranges).

When changing this flow, update this section and the related tests.

---

## EXPLORER TREE LIVE REFRESH

One pipeline keeps the visible tree, forest roots, and the background indexer
in sync with on-disk changes. Do not add a second event channel or a polling
fallback.

- **Watch sources (capability-gated, NO polling fallback).** Desktop: the
  renderer adapter's `watchDirectory`
  (`apps/desktop/src/renderer/adapters.ts`) starts a MAIN-process recursive
  watcher over IPC — `fs:watch` / `fs:unwatch` invokes + one-way
  `fs:watch-event` pushes (`apps/desktop/src/ipc-domains/file-system-watch-ipc.ts`,
  engine shared with notes-vault via `@brainstrike/file-system/electron`:
  **@parcel/watcher is the ONLY engine on every platform** (BST-568 slice 4
  removed chokidar and the recursive-fs.watch path) with an explicit per-OS
  backend — `fs-events` on macOS, `inotify` on Linux, `windows` on Windows —
  selected in `parcel-backend.ts` (unsupported platform/binding throws typed
  errors, never falls back). One native subscription per root; subscribe is
  bounded by a 10s timeout with late-resolution cleanup; event paths are
  re-rooted from kernel realpaths onto the handle path; deletes and
  unstat-able paths normalize to the safe `directory`/`removed` invalidation
  shape; backend callback errors (e.g. FSEvents dropped-events) degrade to a
  root-level invalidation with log-once semantics while the subscription
  stays alive. The 150ms/500-item batcher and `fileFilter.shouldIgnorePath`
  apply (DEFAULT_IGNORE_PATTERNS also feed native-level ignore globs — same
  names, never broader). Typed watcher health
  (`starting|healthy|degraded|failed|stopped`) flows over one-way
  `fs:watch-health` pushes scoped to the owning WebContents (no root-path
  field on the wire); `fs:watch-retry` is MANUAL-only with escalating
  1s/5s/30s throttling and single-flight per watchId; terminal/non-retryable
  failures are retained by the MAIN registry, rejected by the retry API, and
  never render a retry action;
  `fs:watch-telemetry` exposes compact counters. Watchers are keyed by `watchId`, owned by the
  requesting `WebContents` (push to owner only, non-owner unwatch rejected
  without an ownership oracle). The per-owner cap `MAX_FS_WATCHERS_PER_OWNER`
  counts live PLUS reserved (in-flight) watchers — a slot is reserved before
  the `stat` await so concurrent `fs:watch` calls can't race past the cap. The
  owner reaper is attached BEFORE any async setup and covers all three teardown
  shapes — `destroyed`, `render-process-gone` (crash; WebContents survives),
  and `did-navigate` (reload); because `did-navigate` leaves the WebContents
  alive, the reap removes ALL three listeners when any one fires (else they
  pile up across reloads → MaxListenersExceededWarning). A post-setup
  `isDestroyed` re-check stops a watcher whose renderer died mid-setup.
  On the RENDERER side, every `watchDirectory` funnels through ONE shared
  `onWatchEvent` subscription that fans out by `watchId` — a per-watch listener
  would put O(roots) listeners on the single channel. The matching shared
  health subscription is installed BEFORE invoking `fs:watch`; it retains only
  the latest transition for each still-in-flight `watchId`, then resolves and
  replays that transition after the invoke response maps the id to its root.
  This ordering prevents synchronous `starting` or setup-failure transitions
  from disappearing in the invoke round trip. The temporary buffer and shared
  listener are cleared when no mapped or in-flight watches remain. E2E mock
  paths get inert watchers. Web: `WebFileSystemAdapter.watchDirectory` uses
  `FileSystemObserver` (Chrome 133+; absent → warn + no-op disposer). Chrome
  emits `changedHandle: null` for `disappeared` records — the adapter maps
  those to `kind:'directory'` removals (the safe invalidation shape) and drops
  location-less `errored`/`unknown` records without crashing the batch. A
  missing capability always means "visibly unwatched", never a silent poll.
- **Event shaping.** `useFileSystemWatcher` (file-explorer-hooks) watches every
  mounted root; `use-file-system-context.ts` debounces dispatches (300ms
  trailing + 1s max-wait so a continuously-busy root cannot starve dispatch)
  into ONE `FILE_EXPLORER_REFRESH_EVENT` (`source:'watcher'`,
  `scope:'incremental'`, per-root `FileSystemChange[]`).
- **Consumers.** (1) Background indexer
  (`workspace-collection-sync-provider.tsx`) — path-scoped DB re-index
  (mtime+hash skip). (2) Tree: `use-file-tree-refresh-events.ts`, mounted by
  EVERY `FileTreeProvider` (focused root AND each forest RootSection):
  watcher/incremental → re-enumerate only the LOADED parent directories of
  added/removed changes in that provider's root (deduped; unloaded dirs skip —
  they enumerate on expand). Root-level membership changes (including a change
  reported for the root path itself) use `refreshTree`, and that root reload
  is AWAITED before per-directory refreshes (no clobber races); `modified`
  changes never touch the tree (content freshness is the indexer's job). Root
  matching is durable-id-first: the path fallback applies only when the
  provider has no RootId — two same-named web roots share a path, so a path
  match across durable ids would refresh the wrong root. watcher/**full**
  (OVERFLOW — `FileSystemObserver` `unknown`, events possibly missed) fully
  re-enumerates the named root via `refreshTree`; unlike manual/full this is
  NOT gated by `skipManualFullEvents` (nothing refreshes an overflow directly,
  so the outer authority provider must react too, else a single-root workspace
  never reloads).
- **Manual refresh contract.** `file-explorer-panel.tsx` `handleRefresh`
  awaits `refreshFileExplorer()` (the OUTER provider) and dispatches the full
  event only on SUCCESS — a cancelled or failed refresh must not trigger
  downstream full syncs (pinned by the panel tests). The outer, non-nested
  provider is the panel's direct refresh authority and sets
  `skipManualFullEvents` (nested detection via the inherited forest index
  registry), so it ignores the event it just caused; every nested forest
  RootSection provider reacts — that is what makes the toolbar Refresh reach
  every forest root, including the focused root's VISIBLE section.
- **Paired tests:**
  `packages/file-explorer-ui/src/tree/__tests__/use-file-tree-refresh-events.test.tsx`,
  `apps/desktop/src/__tests__/ipc-domains/file-system-watch-ipc.test.ts`,
  `apps/desktop/src/__tests__/renderer/adapters.test.ts` (watchDirectory),
  `packages/file-explorer-hooks/src/__tests__/use-file-system-watcher.test.ts`,
  `packages/file-system/src/__tests__/electron-watchers.test.ts`.

When changing this flow, update this section and the paired tests.

---


## EXPLORER TREE LIVE REFRESH

Watcher-driven refresh of the Explorer tree and background index (added
2026-07-19). The chain: adapter `watchDirectory` →
`use-file-system-watcher.ts` (per-root lifecycle) →
`use-file-system-context.ts` (debounce + dispatch) →
`FILE_EXPLORER_REFRESH_EVENT` (`file-explorer-refresh-event.ts`) →
`workspace-collection-sync-provider.tsx` (background index sync).

- **Change events are debounced; signals are not.** Incremental
  `FileSystemChange[]` batches collapse per-root through a 300ms trailing
  debounce into one `scope:'incremental'` / `source:'watcher'` event. Watcher
  HEALTH travels on a separate channel: `FileSystemWatchSignal`
  (`packages/types/src/file-system.ts`), the optional third argument to
  `watchDirectory`.
- **`overflow` = events may have been missed.** The web adapter maps WICG
  `FileSystemObserver` `unknown` records to it. The context handler drops that
  root's pending incremental changes and IMMEDIATELY dispatches a one-shot
  `scope:'full'` / `source:'watcher'` event naming only the affected root
  (deduped per root within the debounce window so a burst can't storm). BOTH
  consumers act on watcher+full+named-roots: the sync provider runs a per-root
  FULL resync, and the tree consumer (`use-file-tree-refresh-events.ts`)
  fully re-enumerates the named root via `refreshTree` (see LIVE REFRESH
  above). Other roots keep their state; overflow never fans out
  workspace-wide.
- **`errored` = the watch is dead.** WICG `errored` records (and `observe()`
  setup failures — both async rejection and synchronous throw) disconnect the
  observer INSIDE the adapter, then signal. The context handler error-logs and raises a destructive toast
  ("Folder watching stopped") — the root stays connected but unwatched, and
  there is NO auto-restart (a silent retry loop would hide the failure).
  Manual Refresh remains the recovery path. **NO SILENT FALLBACKS:** both
  conditions are always warn-logged in the adapter even when no signal
  handler is attached; never revert to dropping these records.
- **Feature gate, not fallback.** `watchDirectory` is always present on the
  web adapter and no-ops when `FileSystemObserver` (Chrome 133+) is absent;
  capability detection is the caller's job.
- **Paired tests:** `packages/file-system/src/__tests__/web-adapter.test.ts`
  (record mapping + signals), `packages/file-explorer-hooks/src/__tests__/use-file-system-watcher.test.ts`
  (signal threading), `packages/file-explorer-ui/src/__tests__/use-file-system-context.test.ts`
  (overflow one-shot / errored toast), `packages/app-shell/src/background-indexing/__tests__/workspace-collection-sync-provider.test.tsx`
  (per-root full resync scoping).

When changing this flow, update this section and the paired tests.
