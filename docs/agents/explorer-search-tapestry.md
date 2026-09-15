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

---

## COLLECTION DETAILS DEBUG DRAWER

The Database panel owns the collapsed-by-default Collection details drawer
(`packages/db-explorer/src/components/collection-debug-drawer`). Its lazy body
is the diagnostic surface for file/chunk inspection, scored retrieval preview,
and incomplete embedding coverage.

- The panel's `recordPagination` plus `onRecordPageChange` callback are the
  drawer's only file-page source. The Files pager must not read the Zustand
  store independently while its subtitle and rows render panel data.
- The retrieval preview must use `useSemanticSearchExecutor` and the active
  collection repositories. It is one-shot on explicit submit and surfaces
  unavailable executors and failures visibly; never replace it with a SQL-only
  or mock-only proof.
- The drawer stays unmounted while collapsed. Its 50k-file Electron proof opens
  only after retained-memory snapshots, measures click-to-settled latency through
  both the coverage live query and the incomplete-file rollup, and enforces the
  explicit 1500 ms ceiling separately from a generous Playwright locator timeout.
  That elapsed value is an upper bound because it includes renderer IPC round
  trips and locator polling. The import/embed Electron proof verifies retrieval
  is available before input, runs a real drawer query, and requires embedded
  fixture content in the scored result list.

Paired tests:
`packages/db-explorer/src/components/collection-debug-drawer/__tests__/collection-debug-drawer-content.test.tsx`,
`packages/db-explorer/src/components/collection-debug-drawer/__tests__/collection-debug-drawer.test.tsx`,
`apps/desktop/e2e/embedding-worker-renderer.backfill-search.desktop.test.ts`, and
`apps/desktop/e2e/embedding-worker-renderer.memory.desktop.test.ts`.

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
- **Binary files:** the content worker returns an `inaccessible` structured
  result whose message is `BINARY_CONTENT_MESSAGE` (`@brainstrike/types`).
  Background indexing/import branches only on that discriminated status — it
  never classifies accessibility from message text. UI loading boundaries
  project the message to the tab's content; `FileTabBody` exact-matches it and
  renders `BinaryFilePreview` (file-explorer-ui/components) instead of a code
  surface. Its buttons are a
  projection of the shared context-action registry (`file.reveal-in-os`,
  `file.open-in-default-app`, one copy-path variant) — same capability gating
  as the right-click menu, so web builds without fs bridges just show fewer
  buttons, and failures toast + log (no silent fallbacks). Paired test:
  `file-explorer-ui/src/shell/__tests__/file-tab-body-binary.test.tsx`.

When changing this flow, update this section and the paired tests.

---

## PER-FILE EXPLORER PANE (FILE TABS, BST-1269 / BST-1318)

Every file tab hosts a navigation-only tree pane (own `FileTreeProvider` per
tab root, pane-local expansions in `file-tab-pane-store`, per-thread durable
via the workspace snapshot `editors[*].pane`).

- **Absence means OPEN (BST-1318).** A compositeKey with NO store entry
  renders the pane OPEN — the pane auto-opens with its file, revealed to the
  file's location (mount-time reveal at nonce 0). A manual close is recorded
  as an EXPLICIT `open: false` entry so it sticks per file across thread
  switches and restarts; deleting the entry instead would evaporate the
  user's choice on the next hydrate. Old snapshots without pane entries adopt
  auto-open retroactively BY DESIGN — no migration. Every store action that
  materializes an absent key (`togglePane`, `setPaneWidthPct`,
  `toggleExpandedPath`) starts from the OPEN template, and truthiness checks
  on `pane?.open` are a bug class: absent must never read as closed (a
  review-caught regression closed the auto-opened pane on breadcrumb click).
- **Docked RIGHT.** The pane is the SECOND panel of the file-tab split
  (content first), mirroring the main explorer. `widthPct` (clamped 10–70 on
  both write and hydrate) still means pane width.
- **Reveal is one-shot LOCAL state**, never persisted: `(revealNonce,
  revealPath)` keyed per activation; the header toggle and breadcrumb folder
  clicks bump the nonce (re-clicking the same target re-reveals).
- **Boot hydration preserves explicit live pane edits.** The active thread may
  restore before its PGlite workspace snapshot is available. The renderer
  coordinator suppresses saves during that initial read, diffs the complete
  live workspace against its boot baseline, and merges pane fields only for
  tabs admitted by the loaded snapshot (or preserves the live editor map
  atomically when the user changed the tab set). It then applies panes through
  the existing wholesale replacement boundary and persists the merged snapshot
  immediately. This prevents a stale `open: true` row from undoing a manual
  close without leaking a pane from another thread. The complete ordering and
  rejection contract lives in `docs/agents/assistant-persistence.md`.

Paired tests: `file-tab-pane-store.test.ts`,
`file-tab-body-pane.test.tsx`, `apps/web/e2e/file-tab-pane.test.ts`, and
`packages/app-shell/src/thread-workspace/__tests__/use-thread-workspace-coordinator.test.tsx`.
When changing pane semantics, update this section and those tests together.

---

## TAPESTRY

The per-file range model spans Explorer, Search, Tapestry, and every context
consumer (report generator, `listWorkspaceContext`, token meters).

- **Tapestry is the ONLY context preview surface (BST-1211).** The panel is a
  natural-height `PreviewPanelSummary` plus `TapestryView`; there is no tab
  strip, no Table View, and no
  `activeTab` preference. Everything the table used to own went with it: column
  visibility and widths (`context-preview-column-sizes.v1` store deleted),
  sortable headers (preview order is now the fixed ascending-`rootFolderId`
  comparator in `preview-panel.tsx`), page-size selection (Tapestry paginates at
  a constant 24/page) and the shared `PreviewViewToolbar`. Group-by, group
  collapse and the multi-select toggle live in `TapestryControls`; the
  bulk-action bar reaches Tapestry as its `selectionActionBar` prop. The stored
  `previewPanelPreferences.v1` blob keeps its key and serialized `footerMode`
  name for compatibility. A legacy finite `footerHeight` is read only to infer
  that mode using the historical rounded midpoint boundaries; retired fields
  are ignored on read and pruned on the next write. Do not reintroduce a second
  surface without re-reading this paragraph.
- **Deferred rows are not current membership.** `usePreviewPanelState` derives
  rows from selection, but `PreviewPanel` intentionally defers that large
  snapshot. After a selection shrink, the deferred snapshot may therefore
  retain many deselected rows for a render. The panel memoizes row and token
  indexes for each deferred snapshot, then looks up selected keys instead of
  filtering all deferred rows. The workspace-context snapshot projects current
  membership immediately; the expensive Tapestry/grouping/pagination pipeline
  consumes a paired deferred `{ rows, selection }` snapshot so it never sees an
  old/new intersection or resets pagination transiently. The per-file Tapestry
  cache retains entries while their row remains in the deferred index, but only
  derives or refreshes bases for the paired selected slice. A newly selected key
  stays absent until its paired deferred row arrives. Do not rebuild the token
  index on current-selection changes; the selection-bound, replacement,
  cache-retention, and dynamic-add coverage lives in `preview-panel.test.tsx`
  and `preview-panel-deferred-selection.test.tsx`.
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
  `packages/file-explorer/src/context-generation.ts`,
  `apps/desktop/src/assistant-server/assistant-tools.ts` (`listWorkspaceContext`
  `detail: true` gate for per-file ranges).
- **Context traversal boundary:** `context-generation.ts` accepts only the
  platform-neutral `FileSystemAdapter` and `DirectoryHandle`. Raw browser File
  System Access handles remain behind adapters/consumers. Async exports throw on
  malformed filters or traversal failures; the synchronous preview converts
  only known pattern-validation failures into a typed result and renders them
  visibly.

When changing this flow, update this section and the related tests.

---

## WORKSPACE INDEX TRAVERSAL

### Desktop reads are mounted-root capabilities

Electron Explorer and Workspace Index reads are authorized by the single
main-process `WorkspaceRootRegistry`; renderer handles are stamped projections,
not authority. A handle read must carry its durable `rootId`. The legacy
absolute-path read is accepted only when contained by a currently mounted root
(longest containing root wins); there is no raw-adapter fallback.

Each mounted real root owns one lazy-loaded native `SecureRoot` whose
constructor is the sole resolver: it opens the root directly (following
symlinks only at that root-establishment step, because the path comes from
the trusted folder picker or persisted store, never repository content) and
derives `canonicalPath` from the opened handle — the pinned capability is its
own identity authority, not a pre-open realpath. Target realpaths are checked
with `allowMissing:false` for containment only; the native operation receives
the original lexical relative path so even an in-root symlink is not
rewritten to its target. Enumeration and bounded reads open each descendant
component relative to the pinned handle with strict no-follow semantics.
Parent, leaf, chained-link, reparse-point, and mounted-root replacement races
therefore cannot escape. Native async work does not serialize per root: each
enumeration opens its own fresh POSIX `.` descriptor (Windows: a fresh
handle-relative reopen), so concurrent calls — within one root or across
different roots — cannot share or corrupt a cursor and no lock is held across
blocking I/O. `close()` never blocks: it revokes the capability for new
operations while operations already in flight drain against the pinned
handle.

Synthetic roots are selected only by the registration-time
`isSyntheticFileSystemPath` seam, whose production default is
`isMockFileSystemIpcPath`. Unit harnesses may opt real-looking fixture paths into
the synthetic adapter explicitly; ambient `VITEST` state is never consulted by
this trust-boundary choice. The decision is frozen by normalized presentation
path and then bound to the opened root's canonical identity; a conflicting alias
fails closed. The one classification consistently selects the synthetic
`createSecureRoot`, canonical-root resolver, and lexical read-path resolver, so a
root cannot mix synthetic and native authorization mechanics. Unit tests that
exercise native composition inject the registry's secure-root/read-path seam as
one required pair.
Legacy mock/fixture read shortcuts consult that same frozen root classification;
an explicitly native mock-prefixed root therefore stays on its mounted secure
capability. If canonical binding rejects a newly opened native capability, the
registration path closes it before propagating the conflict.

Symlink/reparse entries remain explicit file-shaped Explorer rows so indexing
attempts produce the existing visible inaccessible-file result; native reads
never follow them. Listings are bounded at 10,000 inspected entries: the
registry never throws on truncation — it appends a trailing `'truncated'`
pseudo-node (`` `Showing first ${inspected} entries` ``) to the listing it
already returns, no IPC/adapter signature change. The Explorer renders this
node as a visible, non-selectable, non-expandable tail row (mirroring the
existing `'loadMore'` pseudo-node) rather than silently dropping the partial
result or hard-failing the directory. The pseudo-node is excluded from the
tri-state checkbox rollup (`isPseudoFileNodeType`), so a truncated
directory's parent checkbox evaluates only the listed real entries — a
directory whose entire partial listing is selected reads fully `checked`,
not indeterminate, even though the listing itself is incomplete. File bytes
are bounded before crossing into JavaScript. Paired coverage:
`workspace-root-registry{,.integration}.test.ts`,
`file-system-ipc.test.ts`, and
`packages/secure-fs-native/test/secure-root.test.cjs`.

The visible Explorer loads directories lazily. Recursive Workspace Index scans
use `createBackgroundIndexingEntryPolicy` from
`packages/utils/src/background-indexing-policy.ts`; keep traversal exclusions
there rather than hiding entries after the adapter has already read them.

- **Balanced (default):** prunes common dependency and generated directories
  before recursive reads, including Python `.venv`, `venv`, and `__pycache__`
  directory segments. A bare `env` remains eligible because it is also a common
  source/config directory name and the segment alone does not prove a virtualenv.
- **Full root (explicit override):** continues to traverse those Python
  directories. The Settings description calls this out so opting in does not
  silently change scan breadth.
- **Policy changes supersede active work.** Changing Balanced/Full root restarts
  the provider sync with a fresh service run and aborts the previous run. Scan
  and import progress callbacks are run-owned: after cancellation they cannot
  overwrite status from the replacement run. Cancellation is logged as an
  expected cancellation, while non-abort import failures remain error-logged
  and visible. An Electron `readdir` already executing in the OS cannot be
  preempted; the walker checks the abort before processing its result or
  scheduling any more descendants, bounding the drain to reads already in
  flight.
- **Truncated listings surface in scans; they never skip silently.** The
  registry's `'truncated'` pseudo-node (above) is Explorer-visible, but the
  recursive scan consumers must surface it too: `walkDirectoryParallel` never
  lets the marker enter the returned tree — it reports the affected directory
  through `onDirectoryTruncated`, and a walk WITHOUT that handler fails with
  `DirectoryListingTruncatedError`, including for non-root subdirectories
  whose ordinary read errors are skipped silently. Both Workspace Index scan
  modes install the handler: the full scan wires it through
  `readFullTreeWithOptions`; the scoped watcher scan recognizes the marker
  centrally in `readDirectoryWithProgress`. Each scan logs one warning and
  reports the deduped directory count as `truncatedDirectories` in the visible
  scan summary (`PreparedChangesSummary.truncatedDirectoryPaths` →
  `WorkspaceCollectionSyncScanSummary`); the content-batch phase always
  reports an empty list because only the traversal can observe truncation.
  The debug harness returns `truncatedDirectoryPaths` so coverage audits treat
  `expectedFileCount` as a floor, not an exact total.
  **Truncation also disarms absence inference — retain, never delete, on
  partial knowledge.** "Absent from a truncated listing" is not evidence of
  deletion: full-scan missing-file reconciliation skips cached rows under any
  truncated directory (root truncation protects every row), and the scoped
  directory-removal reconciliation neither prefix-wipes a removed directory
  under a truncated prefix nor exact-invalidates unobserved entries beneath
  one (watcher-authoritative exact FILE removals still invalidate). The idle
  coverage audit returns a `truncated-root` outcome — surfaced like
  `unresolved-root`: warning + visible `waiting` status, never
  `markAuditVerified`, never a recovery sync — because a fully-indexed partial
  prefix proves nothing. Paired tests:
  `parallel-directory-walker.test.ts` (report + fail-loud),
  `workspace-collection-sync-service.test.ts` (full + scoped scan summaries;
  truncation-protected invalidation), `workspace-collection-sync-scan.test.ts`
  (scoped removal guard), `workspace-collection-sync-provider.test.tsx`
  (truncated audit never verifies complete),
  `workspace-collection-sync-status-helpers.test.ts` (status row), and
  `workspace-index-debug-harness.test.ts`.
- Workspace include/exclude filters control visible-tree filtering and
  selection. They are not the Workspace Index traversal policy; do not mutate
  custom filters to implement indexing exclusions.
- **Flattening is iterative and order-preserving.** After discovery,
  `flattenFileNodes` uses an explicit LIFO stack and pushes roots and children
  in reverse so the emitted files retain recursive pre-order DFS and sibling
  order. Do not replace it with recursion or array spreading: the paired tests
  require 100,000 levels of nesting and 100,000 files in one directory to
  flatten without call-stack or function-argument overflow.
- **Scan handles retain their platform contract (BST-499).** `IFileNode.handle`
  accepts raw browser file/directory capabilities and the canonical shared
  `FileHandle`/`DirectoryHandle` descriptors. Scoped native scans construct
  descriptors directly; rebuilding a browser directory preserves its raw
  capability in `_internal` and inherits the root's durable identity. Do not
  disguise descriptors as browser capabilities with double casts. Shared type
  assertions and `workspace-collection-sync-scan.test.ts` cover both forms.
  File reads and directory traversal normalize node handles through
  `@brainstrike/file-system/file-node-handles`: wrap raw browser capabilities
  once, preserve a descriptor's `_internal`, platform, canonical I/O path and
  durable root identity, and inherit a parent root only when the child is
  unstamped. Retain durable root stamps carried by raw browser capabilities as
  well. File-tree and token-indexing maps extract a canonical web
  descriptor's raw capability through their existing capability guard. The
  real-web-adapter processor, shared-loader and lazy-expansion regressions plus
  `file-node-handles.test.ts` pin these boundaries.
- **Chunking re-dispatch is bounded per service session (BST-1229).** A
  hash-unchanged managed-cache row with no `chunks_processed_at` stamp may be
  re-dispatched at most three times. The service-owned in-memory tracker keys
  that budget by collection id, durable root/path, file-record id, and content hash; a
  completed stamp, new record, or changed content resets it. Attempts are
  consumed only at importer handoff, after access, worker startup, and import
  QoS succeed; cancelled or failed pre-import scans do not spend the budget.
  Exhaustion counts the row as scanned-but-unchanged, removes only that row from
  later import batches, logs one explicit terminal diagnostic per exhausted
  revision, and puts Workspace Index in its visible `error` state with the file
  paths and recovery instruction. It does not block unrelated embedding
  backfill, and neither asynchronous backfill progress nor a healthy scan of
  another root can clear the terminal state.
  Partial watcher scans preserve errors for paths they did not examine and
  clear only errors covered by that scoped scan; an ignored root-self removal
  preserves the existing errors. Inaccessible content reads preserve the
  matching path errors during both scoped and full scans. Switching or disabling
  the managed collection discards errors owned by the retired collection. Each
  provider loop also reconciles the service against the complete mounted-root
  identity set. The durable adapter root ID is retained through both DB routing
  and terminal-scope reconciliation, including the `rootIdByPath` fallback for a
  legacy mounted handle without a stamped `rootId` (never project down to path
  plus nullable DB ID), so removing one root cannot leave its error attached to healthy sibling
  roots and same-path web roots cannot exchange identities. Full
  scans prune retry state for paths no longer present. If reconciliation leaves
  only mounted roots without resolved database ids, the provider replaces any
  retired root's terminal error with the explicit unresolved-root waiting status;
  a zero-syncable-target loop must not leave stale status visible. Never replace
  this with an unbounded retry. A redispatch attempt is recorded only when its
  concrete import batch enters `processChunking`, the second content read selected
  that file, and its managed-cache apply succeeded; unreadable files, failed
  applies, post-base model/worker setup failures, and cancellation or failure in
  an earlier batch must not spend untouched retry budgets. Never use a
  quiet skip. This is intentionally not persistent sync state: restarting the
  renderer grants a fresh bounded budget.

The policy test owns the preset contract. The parallel-directory-walker test
must also prove excluded directories are rejected before `readDirectory` is
called. Provider/service tests own policy-switch cancellation and stale-progress
suppression.

### Token indexing has TWO trigger sources (BST-1207, decision D2)

Separate from the Workspace Index above, per-file TOKEN counting is driven by
`useBackgroundTokenIndexerIntegration`. It has two trigger sources, and both go
through the SAME `triggerIndexing` → `planTokenIndexingDispatch` path, so the
binary/size exclusions and the indexed/in-flight de-duplication are shared:

1. **Selection** (original). Adaptive debounce; the user is waiting on it.
2. **Visible/expanded rows** (`visibleFiles` prop, implemented in
   `packages/file-explorer-ui/src/indexing/use-visible-file-token-indexing.ts`).
   Feeds the tree grid's token column for rows the user only expanded. It is
   **cached-first** — each folder's persistent cache is warmed via
   `preloadFolder`, then every key the hot cache can already answer is dropped
   and marked indexed. A warm is memoized only once `isPersisted` is true: the
   worker goes operational before PGlite does, and remembering that no-op warm
   would strand every later visible file on a full re-count. The memo is the
   parent-owned `preloadedVisibleFoldersRef`, reset with the other indexer memos
   on root change, tree clear, and `clearIndexedCache`.
   It is **capped**: the visible set is every file under an expanded directory,
   not the viewport, so one expand on a large directory can surface thousands of
   uncached files, each costing a full-content read (IPC on desktop). A pass
   dispatches at most `VISIBLE_FILE_INDEXING_MAX_PER_PASS` (500) keys and
   re-arms for the remainder — but ONLY when the previous pass consumed
   something, so a set that can never be consumed (every key parked for a
   missing handle) cannot spin. Nothing is dropped; it is deferred.
   Cooperative-yield counts in tests are derived from
   `VISIBLE_FILE_INDEXING_MAX_PER_PASS / TOKEN_INDEXER_IO_BATCH_SIZE`; do not
   copy a stale window count. Effect cleanup cancels both the debounce and the
   async continuation's re-arm whenever effect cleanup runs, so a completed
   dispatch cannot update the stale cursor after its tree unmounts or any
   dependency replacement installs a new effect that owns the next pass.
   It is **throttled** by a `VISIBLE_FILE_INDEXING_DEBOUNCE_MS` floor set to 2×
   the selection trigger's longest adaptive delay. The two debounces are
   independent, so this is a strong bias toward selection-first, NOT a
   guarantee — do not write code or docs that depend on strict ordering.
   Because the Explorer tree is lazily enumerated, "in the tree" already means
   "visible or under an expanded directory"; `collectVisibleFileSelectionKeys`
   walks the quick-filtered tree and keys by `node.rootFolderId` so forest roots
   stay distinct.

Do not add a third trigger.

Per-row metadata for the tree grid (tokens/size/type + directory rollups) is
read through `FileRowMetadataStore`
(`packages/file-explorer-ui/src/indexing/file-row-metadata-store.ts`), a
per-composite-key external store. Rules that must hold: an uncounted file reads
`pending`; a file the planner permanently retires reads `excluded` with an
`exclusionReason`. `FileRowMetadata` is a discriminated union that requires the
reason exactly when `tokens === 'excluded'`; do not weaken it back to an
optional sibling property. The reason set must stay in sync with
`planTokenIndexingDispatch` — today `'binary'` (`isBinaryFile`) and
`'too-large'` (over the shared `DEFAULT_MAX_FILE_SIZE`), both of which the
planner pushes into `indexedKeysToAdd` so their count never arrives. Adding a
new permanent retirement to the planner without adding its reason here leaves
those rows on `pending` forever AND pins every ancestor rollup to `partial`.
A directory rollup is only `complete` when the subtree is fully enumerated AND
every descendant's metadata has landed, otherwise it is an explicit `partial`
marker; excluded files contribute zero tokens and their real size without
blocking completeness. Partial reasons are explicit: `recomputing` is reserved
for deferred rollup work that is actually queued, `incomplete-subtree` covers
unloaded/capped/failed enumeration with neutral unavailable copy, and
`pending-metadata` means descendant counts have not landed. Do not label an
inert or permanently capped subtree as recomputing. A count landing for one key
must not re-render any other row.

Metadata sorting distinguishes capability from readiness. A missing
`FileRowMetadataProvider` means the surface cannot serve a persisted metadata
sort, so it warns and resets to loader order. A mounted provider with an empty
root id is only temporarily unready: skip the sort for that render, emit a
one-shot debug diagnostic (promoted to a warning if tree content is present), but preserve
the user's persisted preference. Production and the 10k-row performance test
must both use `createFileTreeSortMetadataReader`; never copy its closure into a
test.

`getDirectorySubtree` is TOTAL: anything the caller cannot enumerate answers
an `isComplete: false` subtree with `incompleteReason: 'not-enumerated'`
rather than nothing, so a cell can never throw mid-render and "this is a file"
is not confused with "this directory is not enumerated yet". Only the deferred
controller returns `incompleteReason: 'recomputing'`, and only after it has
queued the path. Because rollups are cached and the store cannot see the tree,
the caller MUST call `invalidateAll()` whenever the tree SHAPE changes (expand,
collapse, filter, refresh, root switch) — `use-file-tree-metadata-source` does
this off the row-model identity.

Invalidation has two paths and the split is load-bearing. `useFileRowMetadataStore`
returns an `onTokenResolved` that MUST be passed to
`useBackgroundTokenIndexerIntegration`: every resolved count names its own
composite key, so the store re-reads that key plus its cached ancestor rollups —
O(affected keys), whatever the tree size. The full `invalidateAll` reconciliation
exists only for bulk writes that name no key (`preloadFolder`, warm-cache
hydration), which surface solely as a `cacheVersion` bump; since that bump is
debounced at 50ms and therefore fires ~20×/s during an index run, the
version-driven pass is coalesced behind a trailing
`RECONCILE_METADATA_DEBOUNCE_MS` timer with a
`RECONCILE_METADATA_MAX_WAIT_MS` starvation bound. Operational transitions and
`FILE_EXPLORER_REFRESH_EVENT` reconcile immediately. Do not drop the
reconciliation path (a reopened workspace's already-cached counts would sit on
`pending` forever) and do not make it the per-count path. No third channel, no
polling. Paired tests:
`packages/file-explorer-ui/src/__tests__/file-row-metadata-store.test.ts`,
`packages/file-explorer-ui/src/__tests__/file-row-metadata-render-stability.test.tsx`,
`packages/file-explorer-ui/src/__tests__/use-file-row-metadata-store.test.tsx`,
`packages/file-explorer-ui/src/__tests__/use-background-token-indexer-integration-visible-files.test.tsx`.

---

## WORKSPACE WALK: IGNORE FILES ARE THE PRIMARY SIGNAL, THE POLICY IS THE FLOOR

`walkWorkspaceRoot` (`apps/desktop/src/assistant-server/workspace-file-walk.ts`)
honours the ignore-file chain when the caller passes `respectGitignore`
(BST-1427, extended by BST-1431/BST-1432), with
`createBackgroundIndexingEntryPolicy('balanced')` beneath it as a floor.

**ONE precedence order, lowest first — do not add a source without placing it
here.** Implemented by `createWorkspaceIgnoreMatcher`
(`packages/utils/src/workspace-ignore-matcher.ts`):

| # | Source | Bypassed by `includeIgnored`? |
| --- | --- | --- |
| 1 | global excludes (`core.excludesFile`) | yes |
| 2 | `.git/info/exclude` | yes |
| 3 | parent `.gitignore` chain (root inside a larger repo) | yes |
| 4 | `.gitignore` (root, then nested — deeper wins) | yes |
| 5 | `.ignore` ("hide from search, keep in git") | yes |
| 6 | `.rgignore` | yes |
| 7 | `.llmignore` (portable agent ignore file) | **NO — HARD** |
| 8 | `.brainstrikeignore` (ours; wins over the portable one) | **NO — HARD** |

**Layer groups resolve GLOBALLY; nesting resolves within a group.** Outermost
scope first inside each group (deeper wins — ripgrep's model), but every
bypassable scope is resolved before any hard one. A scope-major fold made the
agent layers bypassable by anyone who could add a nested `.gitignore` carrying
`!key.ts`, which is the opposite of what they are sold as.

**Sources that share a base compile into ONE matcher; sources based elsewhere
get their own scope with a `pathPrefix`.** Parent `.gitignore`s are anchored at
their own directory, so `workspace/vendor/` must be tested against
`workspace/vendor/x.ts`, not the `vendor/x.ts` the walk emits — concatenating
them into the root scope silently broke every slash-containing parent pattern.
Prefix rather than pattern-rewriting, because rebasing gitignore text means
reimplementing its syntax. The matcher evaluates every reachable directory
component plus the leaf through those scoped parsers (BST-1434), keeping each
containing component in one path-keyed state map. Cross-scope evaluation uses
`ignore@7.0.5`'s direct rule-manager verdict because public `test()` deliberately
returns an ignored parent's cached result for descendants; silently accepting a
different dependency shape is forbidden. This preserves separately excluded
ancestors, descendant-specific rules hidden behind a parent match, and repeated
unanchored matches after a deeper scope re-includes only the first directory.
The ordinary single-root case avoids the path-keyed map but still evaluates each
component directly so its cross-group semantics cannot differ from the scoped
path. Direct verdicts are memoized per immutable compiled matcher, recovering
the ancestor-query cache that public `test()` would otherwise provide.
Leaf-only negations still cannot bypass an ignored parent directory.

**`.git/info/exclude` is resolved through `git rev-parse --git-path`**, not
`<repo>/.git/info/exclude`. In a linked worktree or submodule `.git` is a FILE,
so the naive path does not exist and the layer silently vanishes — on a repo
where worktrees are routine.

**`core.excludesFile` is read with `cwd` at the workspace root**, and memoised
per root. Without `cwd`, `git config --get` merges the LOCAL config of whatever
directory Electron main was launched from.

**THE AGENT LAYERS ARE A HARD BOUNDARY (7-8) — do not relitigate.**
`includeIgnored` bypasses every other layer, because tools legitimately search
excluded trees. It does not bypass these. They are the only exclusion a user may
reasonably treat as a security control (credentials, customer data, a private
corpus), and a promise of "never read, index, or send" that one flag defeats is
worse than no promise, because people rely on it. Consequences that follow and
must be preserved:

- The walk asks the matcher FIRST and ALWAYS; `includeIgnored` short-circuits
  only the static policy floor beneath it.
- **`respectGitignore` does not gate them either.** It controls which BYPASSABLE
  layers are COLLECTED; the matcher is always constructed and the agent files
  always read. Gating them on a flag named for `.gitignore` was the same master
  key one level up, and `walkWorkspaceRoot` is exported — the next caller that
  omits the flag would inherit a walk with no hard boundary and no signal it
  lost one.
- **The verdict is evaluated on the file that gets READ, not the path that was
  requested.** `resolveWorkspaceAbsolutePath` returns the realpath'd target and
  the normalized request as separate fields; checking the request let an
  ordinary in-root symlink (`notes/leak.md -> ../secrets/api-key.env`) pass
  containment, be asked about under its alias, and be read from its target.
  Aliasing, not retargeting — the stable-path lock does not help. Every read
  path checks both, and the walk checks a symlink's canonical target before
  recording it.
- **The agent layers are INHERITED from parent directories**, up to the
  enclosing repository root, in the walk AND in `createAgentIgnoreGuard` — via
  the shared `repository-root.ts` so the two cannot drift. A repo-root
  `.llmignore` is the normal way a team ships one; reading only `.gitignore`
  from parents meant it did nothing once a subdirectory was opened as a root
  (BST-1436). Repo-root discovery is unconditional (a stat walk); the
  `git config` subprocesses stay gated on `respectGitignore`.
- **NO PROCESS-WIDE GUARD CACHE.** One existed for a release and is deliberately
  gone. It saved mostly-ENOENT opens and cost the primary user story: a rule
  written AFTER the first query was invisible until restart. "It cannot loosen
  on its own" is the wrong safety property — TIGHTENING is what the user is
  doing. Batch callers share one guard per operation, which bounds staleness to
  a single tool call.
- **An unreadable agent ignore file FAILS CLOSED — in the WALK as well as the
  guard.** This inverts the rule for
  every other layer, where failing open costs only a wider walk. Here, "I could
  not read the rules" resolving to "there are no rules" serves the protected
  file — the exact outcome the boundary exists to prevent, arriving through the
  door marked robustness. ENOENT is the only quiet failure.
- **Never fold verdicts across layers by hand.** Layers are concatenated in
  precedence order into ONE `ignore` instance per group. A separate instance per
  layer forces the caller to combine verdicts, and that combination is wrong
  wherever a directory-only pattern meets its negation: for `cache/one.md` under
  `.gitignore: cache/` plus `.ignore: !cache/`, the layers report
  `{ignored:true}` and `{}`, so any fold keeps the file excluded — while
  `git check-ignore` does not. Hand the ordered patterns to the parser.

- **Why gitignore leads.** A hand-maintained denylist of directory names cannot
  keep up with machine-local caches, and when it falls behind the failure is
  SILENT: a glob returns `0 matches`, not an error. Every directory that has
  actually hurt us was already gitignored — `.pnpm-store` (82,267 files here,
  1.6x the 50,000 walk cap on its own; BST-1428), `.turbo`, `.claude/worktrees`
  — and two of the three still needed a bespoke list entry. Respecting
  `.gitignore` is what ripgrep, fd, VS Code, ESLint and Prettier all do.
- **Why the floor stays.** A root that is not a git repo has no `.gitignore`,
  and `.git` itself is never gitignored. The static policy carries those alone.
- **DIRECTORIES MUST BE TESTED WITH A TRAILING SLASH** — do not relitigate. A
  directory-only pattern (`dist/`) does NOT match the bare path `dist`, because
  a bare path carries no directory signal. Asking the file form when deciding
  whether to descend returns false, the walk enters the tree, and it then
  rejects every file inside one at a time — which is the cap starvation this
  exists to prevent. `createWorkspaceIgnoreMatcher` therefore exposes `ignoresDirectory`
  and `ignoresFile` as separate methods rather than one convenience call.
- **Nested `.gitignore` files scope to their own subtree**, pushed on entry and
  popped on exit, outermost-first so a deeper file can re-include what an outer
  one ignored (git resolves last-match-wins). The presence check reuses the
  directory listing the walk already has, so directories without one cost
  nothing.
- **Implementation is the `ignore` package**, chosen deliberately and pinned by
  `workspace-ignore-matcher.test.ts`: gitignore reimplementations disagree on
  edge cases, so the behaviour depended on is asserted rather than assumed.
- **LIVE GREP DELIBERATELY DOES NOT OPT IN.** Its ripgrep pass runs
  `--no-ignore --hidden` so rg is a true SUPERSET and `policy.shouldIncludeFile`
  stays the SINGLE authority trimming both engines identically — otherwise
  results differ by whether rg is installed. Honouring `.gitignore` on the JS
  side alone breaks that parity (the `rg-vs-walk parity` case catches it);
  honouring it on both would require rg's Rust implementation and the `ignore`
  package to agree on every edge case. Making grep gitignore-aware is its own
  change: BST-1429. THE AGENT LAYERS ARE THE EXCEPTION — see below.
- Measured on this repo, walking with the FULL chain: `scanned` 6,739 → 5,560
  and `kept` 5,147 → 4,998, at 92ms → 151ms. (BST-1427 measured 88ms → 111ms
  with `.gitignore` alone.) The extra ~40ms is dominated by the one-time
  `git config --get core.excludesFile` subprocess at root-chain assembly, not by
  per-directory reads — `readDirectoryIgnoreSources` only opens names actually
  present in the listing the walk already has, so a directory declaring no
  ignore files costs a few Set lookups.

### A ZERO-MATCH GLOB STEERS TO `includeIgnored` — BUT ONLY WHEN THAT WOULD HELP

Widening the exclusion set from a fixed denylist to "whatever the repo ignores"
means `globWorkspace({pattern: 'coverage/**'})` returns a bare `{count: 0}`,
indistinguishable from "those files do not exist" — a NEW instance of the silent
failure this walk exists to remove. The walk reports what it excluded
(`onExcluded`) and the tool emits a `hint` naming `includeIgnored`.

Three rules, each load-bearing, each with a test:

- **PARTIAL matching for a pruned DIRECTORY, FULL matching for a FILE.** A
  pruned directory is reported instead of its contents, so it is only a prefix
  and `coverage` must partial-match `coverage/**`. A file is the whole path.
  Using partial for both makes the steer fire whenever ANY file was excluded,
  because bare patterns are made recursive (`secrets/**` → `**/secrets/**`) and
  under a leading `**` nearly every path partial-matches. That is why
  `onExcluded` carries `isDirectory`.
- **Never for the HARD agent layers**, via `matcher.ignoresHard`. The advice
  would be a dead end (`includeIgnored` cannot lift them), and reporting the
  path would DISCLOSE that something exists where the user asked for nothing to
  be visible — most of what `.llmignore` was bought for. `.git` is excluded from
  reporting for the dead-end half of the same reason.
- **Never when the caller already passed `includeIgnored`, or when
  `scanLimited`** — the latter's honest answer is "the walk did not finish",
  which its own note already gives.

The pre-existing "nothing matches" case (`**/*.rs`) still asserts `hint` is
undefined. Keeping it unamended is the evidence that the steer is precise rather
than firing on every empty result — a hint on every call is noise the model
learns to skip, which costs the one case that needed it.

### THE HARD BOUNDARY BINDS ON EVERY READ PATH (BST-1432)

A `.llmignore` honoured by the file lister but not by grep is not a boundary —
it is a UI convenience that reads as a security control, which is the worse of
the two failures. `createAgentIgnoreGuard`
(`apps/desktop/src/assistant-server/agent-ignore-guard.ts`) is the hard layers
made queryable by arbitrary path, because ripgrep returns a flat path list with
no directory context and cannot use the walk's push/pop matcher.

| Read path | Enforced at |
| --- | --- |
| `globWorkspace` / walk | `walkWorkspaceRoot` matcher (layers 1-8) |
| live grep — ripgrep engine | `dropAgentIgnored`, where both engines converge |
| live grep — JS-walk engine | same call site, so parity cannot drift |
| excluded-path steering probe | its bounded eligible slice, before any read |
| `readWorkspaceFile` (paged) | inside the stable-path lock |
| `readWorkspaceTextFile` (LSP inspect, rename reindex, workspace-context, `@file`) | the shared reader, so consumers inherit it |

- **Why JS-side for both grep engines**, when `.gitignore` deliberately is not:
  rg implements gitignore natively, so delegating that layer risks two
  implementations disagreeing. `.llmignore` is not an rg ignore file at all, so
  there is no second implementation to diverge from.
- **Both grep engines are filtered at ONE call site.** Enforcing inside each
  collector would make the boundary's strength depend on whether `rg` is
  installed on the machine.
- **A refused read THROWS; it never returns empty content.** Empty content
  teaches the model the file is empty and it will report that as fact — a
  fabricated claim about the user's code. The message names the ignore files so
  the user can find the rule.
- **The guard is hard-layers-only.** Applying layers 1-6 there too would
  silently make `includeIgnored` useless on every path that consults it.
- Still uncovered, deliberately and tracked: file MUTATION tools do not consult
  the guard, so an agent can still write to an agent-ignored path (BST-1433).

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
  errors, never falls back). One native subscription per owning renderer and
  resolved root; duplicate same-owner/root registrations receive distinct
  logical watchIds sharing the existing native subscription instead of
  starting Parcel again. Events and health fan out to the live logical IDs, and
  a stale disposer removes only its own ID, with sharing counted by
  `fs:watch-telemetry`. Subscribe is
  bounded by a 10s timeout with
  late-resolution cleanup; event paths are
  re-rooted from kernel realpaths onto the handle path; deletes and
  unstat-able paths normalize to the safe `directory`/`removed` invalidation
  shape; backend callback errors (e.g. FSEvents dropped-events) degrade to a
  root-level invalidation with log-once semantics while the subscription
  stays alive. The 150ms/500-item batcher and root-relative default segment
  classifier apply, plus (BST-1342) the background-indexing policy's unconditional
  excluded-path prefixes (`.claude/worktrees` and `.brainstrike/worktrees`)
  checked ROOT-RELATIVELY via
  `isExcludedBackgroundIndexingPath` — a subscription root opened inside an
  excluded tree watches normally; only nested excluded trees are silenced.
  Deliberate consequence: a NESTED worktree subtree stays VISIBLE in the
  Explorer (`fileFilter` unchanged; the token-indexer e2e still expands into
  it) but is no longer live-refreshed — external changes there appear only
  on manual re-enumeration. That is the point of the fix (run-5189: worktree
  churn flooding FSEvents drove overflow → full-refresh storms → DB-host
  saturation that killed an active run); do not "fix" the staleness back
  into a watch. The background-indexing excluded-path globs still feed the
  native layer for roots outside excluded trees — this is the load-bearing
  run-5189 overflow guard. The generic Parcel/Electron watcher remains
  default-false and retains `DEFAULT_IGNORE_PATTERNS` natively. The concrete
  MAIN-owned Explorer `fs:watch` closure is the sole production caller of
  `reportDefaultFilteredChanges:true` (never renderer/wire input). That opt-in
  retains `.git`, `node_modules`, `.pnpm-store`, `.next`, and `.turbo` at the
  native boundary: recursively observing those high-cardinality trees risks
  descriptor exhaustion or bounded subscribe-timeout failure. A force-tracked
  file inside one of them is therefore unsupported by this pipeline; lossless
  support requires a separate bounded Git-aware tracked-path watcher, not
  polling or broadening this recursive subscription.

  Parcel delivers only the bounded reportable defaults `dist`, `build`, and
  `.DS_Store` to a lightweight JS classifier. It matches the event path
  relative to the watched root, so opening a root beneath an ancestor named
  `build`, `dist`, or `node_modules` never creates a permanent filtered marker
  storm. The classifier omits detailed paths from Explorer/indexing and records
  the first matched root-relative boundary. The 150ms producer batch and the
  renderer's 300ms/1s aggregate each retain at most 64 deduped boundaries;
  excess cardinality sets explicit `filteredChangeBoundariesOverflow:true`.
  Filtered records never stat or enter the serialized event promise chain.
  Changes refreshes only registrations intersecting retained boundaries;
  overflow fails open within that durable root only. Sustained builds still
  cost one trailing/max-wait Git view refresh per affected repository, not per
  raw event and not for unrelated repositories. User-configured Explorer `excludeFilters` are later display
  projection, not watcher inputs, so those paths continue through the normal
  detailed event path. The managed-worktree exclusions remain the explicit
  exception: no detailed event and no boundary evidence, preserving their documented
  deliberate staleness. `.git` also remains natively ignored here because it is
  metadata rather than a working-tree path; the private git-metadata watcher
  owns its bounded HEAD/index/refs signal and deliberately excludes objects
  churn. A per-subscription `ignorePatterns` override exists
  (BST-1112, see `docs/agents/platform-contracts.md`) for main-owned callers
  outside this pipeline, e.g. a git-metadata watcher. It is mutually exclusive
  with coarse reporting, including the explicit `[]` override; Notes Vault
  retains default native filtering and git metadata remains marker-free.
  Typed watcher health
  (`starting|healthy|degraded|failed|stopped`) flows over one-way
  `fs:watch-health` pushes scoped to the owning WebContents (no root-path
  field on the wire); `fs:watch-retry` is MANUAL-only with escalating
  1s/5s/30s throttling and single-flight per watchId; terminal/non-retryable
  failures are retained by the MAIN registry, rejected by the retry API, and
  never render a retry action;
  `fs:watch-telemetry` exposes compact counters. Watchers are keyed by
  `watchId`, owned by the requesting `WebContents` (push to owner only,
  non-owner unwatch rejected without an ownership oracle), while native
  subscriptions are de-duplicated by `(ownerId, resolvedPath)`. The per-owner
  cap `MAX_FS_WATCHERS_PER_OWNER` counts native subscriptions; after path
  resolution, the existing-subscription lookup, cap check, and insert are one
  synchronous section, so concurrent distinct-root starts cannot race past the
  cap and an in-budget duplicate registration remains valid when the cap is
  full. `MAX_FS_WATCH_REGISTRATIONS_PER_OWNER` separately bounds the total
  logical watchIds retained for one renderer to twice the native cap; the
  synchronous post-resolution check prevents duplicate registrations from
  creating unbounded MAIN-process state and per-event IPC fan-out. The
  owner reaper is attached BEFORE any async setup and covers all three teardown
  shapes — `destroyed`, `render-process-gone` (crash; WebContents survives),
  and `did-navigate` (reload); because `did-navigate` leaves the WebContents
  alive, the reap removes ALL three listeners when any one fires (else they
  pile up across reloads → MaxListenersExceededWarning). A lifecycle generation
  rejects an in-flight watch whose path resolution finishes after the reaper
  ran; a post-setup `isDestroyed` re-check stops a watcher whose renderer dies
  during the synchronous native start.
  On the RENDERER side, every `watchDirectory` funnels through ONE shared
  `onWatchEvent` subscription that fans out by `watchId` — a per-watch listener
  would put O(roots) listeners on the single channel. The matching shared
  health subscription is installed BEFORE invoking `fs:watch`; it retains only
  the latest transition for each still-in-flight `watchId`, then resolves and
  replays that transition after the invoke response maps the id to its root.
  This ordering prevents synchronous `starting` or setup-failure transitions
  from disappearing in the invoke round trip. The temporary buffer and shared
  listener are cleared when no mapped or in-flight watches remain. E2E mock
  paths get inert watchers. The dev inline-fixture adapter likewise returns an
  inert disposer for every ACTIVE fixture-owned synthetic root; it preserves
  the wrapped adapter's capability and delegates foreign/real roots unchanged,
  so fixture names never escape to native watcher IPC as disk paths. Web:
  `WebFileSystemAdapter.watchDirectory` uses
  `FileSystemObserver` (Chrome 133+; absent → warn + no-op disposer). Chrome
  emits `changedHandle: null` for `disappeared` records — the adapter maps
  those to `kind:'directory'` removals (the safe invalidation shape); location-less
  `unknown`/`errored` records carry no change event and instead surface on the
  health-signal channel (see **Watcher health signals** below), never dropped
  silently. A missing capability always means "visibly unwatched", never a
  silent poll.
- **Event shaping.** `useFileSystemWatcher` (file-explorer-hooks) watches every
  mounted root; `use-file-system-context.ts` debounces dispatches (300ms
  trailing + 1s max-wait so a continuously-busy root cannot starve dispatch)
  into ONE `FILE_EXPLORER_REFRESH_EVENT` (`source:'watcher'`,
  `scope:'incremental'`, per-root `FileSystemChange[]`). Optional per-root
  `filteredChangeBoundaries` are bounded working-tree evidence from the same
  watch, Set-merged across the window. Explicit boundary overflow is distinct
  from watcher record loss and never changes `scope` to `full`: Git consumers
  fail open only across mounted registrations in that durable root; tree,
  background-indexing, and row-metadata consumers no-op without detailed
  changes. Mixed batches deliver both once.
- **Watcher health signals (separate channel from change events).** Change
  events carry structural deltas; watcher HEALTH travels out-of-band on
  `FileSystemWatchSignal` (`packages/types/src/file-system.ts`), the optional
  third argument to `watchDirectory`. Two conditions:
  - `overflow` — events may have been MISSED (WICG `unknown` records). The web
    adapter warn-logs and signals; `use-file-system-context.ts` drops that
    root's pending incremental changes and IMMEDIATELY dispatches a one-shot
    `scope:'full'` / `source:'watcher'` event naming only the affected root
    (deduped per root within the debounce window so a burst can't storm). Both
    Consumers below re-sync only the named root — overflow never fans out
    workspace-wide.
  - `errored` — the watch is dead (WICG `errored` records, and `observe()`
    setup failures: both async rejection AND synchronous throw). The adapter
    disconnects the observer, warn-logs, and signals; the context handler
    error-logs and raises a destructive toast ("Folder watching stopped"). The
    root stays connected but UNWATCHED, with NO auto-restart (a silent retry
    loop would hide the failure) — manual Refresh is the recovery path.

  **A BULK MAIN-PROCESS MUTATION MUST DRIVE ITS OWN RECOVERY.** The `errored`
  contract above means the watcher cannot be relied on to report a burst that
  killed it. Conversation Rewind's files-mode apply/redo therefore calls
  `packages/app-shell/src/changes/use-rewind-explorer-recovery.ts` on success:
  it dispatches the SAME `scope:'full'` / `source:'watcher'` event as the
  overflow path (one event, naming every connected root from the result's
  `rootOutcomes`) and then calls `retryWatcher` (`fs:watch-retry`) for any of
  those roots whose health is `failed`. Two rules bind here: reuse the existing
  refresh pipeline — never invent a second channel — and retry ONLY `failed`,
  never `degraded` (that subscription is alive and self-recovers; retrying it
  tears down a working watch). Refresh is dispatched BEFORE the retries and is
  not awaited by the caller: the mutation is already complete on disk, so
  nothing can be missed by re-enumerating first, while a hanging `subscribe`
  would otherwise hold the visible fix. Any future main-process bulk mutation
  outside the assistant's write tools needs the same treatment.

  **NO SILENT FALLBACKS:** both conditions are always warn-logged in the
  adapter even when no signal handler is attached; never revert to dropping
  these records.
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
  never reloads). (3) Open workspace file tabs:
  `use-workspace-open-file-refresh.ts`, mounted once by `WorkspaceTabsProvider`,
  maps the SAME event onto open composite keys. Incremental file changes match
  the exact root-relative path; directory changes match open descendants; a
  named full refresh reloads every open tab in only those durable RootIds; and
  manual/full's canonical `roots:[]` is an ALL-OPEN-TABS broadcast. Durable
  `folderId === rootId` wins; root-path matching exists only for legacy
  path-identified composite keys, with the shared Windows drive/UNC
  case-insensitive path semantics. Same relative paths in different durable
  roots never cross-refresh. Malformed persisted keys are warn-logged by count,
  never echoed with their root/path. The window listener is stable, while its
  tabs/reload callback are synchronized in the commit phase through the shared
  `useEventCallback`; watcher/IPC events arriving after commit but before
  passive effects therefore never route through the previous render.

  A matching event calls the shared content loader's `reloadFileContents`:
  cached bytes are evicted synchronously before any await, then re-read. The
  generation/active-read authority is owned ONCE by `FileExplorerProvider` and
  shared by every `useSharedFileContentLoading` instance beneath it — hook-local
  authority is invalid because all those hooks commit into the same provider
  store/cache. The LRU is constructed once per Zustand store (never at module
  scope), and provider replacement creates the store/cache and authority in
  one memoized lifecycle. A retired provider read can finish only into its
  retired store/cache; it cannot repopulate content consumed by the replacement
  provider. Per-store clears, eviction, stats, and full reset act on that same
  scoped cache. Factory reset first invalidates all read generations and queued
  batches, then clears the live store's raw content/LRU and advances a keyed
  provider lifecycle. This remounts hook-local loading/pending/cache refs and
  state on web even when reset does not reload; provider/store identity changes
  use the same key, with commit-phase cleanup invalidating the retired
  authority. Each generation token is globally monotonic within the authority,
  so clearing its per-key map can never make a pre-reset token valid again.
  Each key carries a monotonic in-memory generation while the
  reload is active, so an older read resolving in a sibling hook after a second
  disk change cannot republish stale bytes. Refresh partitions keys before its
  first await: immediately-ready keys start in ONE batch, while dependent keys
  are grouped by the identity of their preceding promise. Each group filters
  superseded generations and starts as soon as only its own predecessor
  settles, so one slow/hung read cannot blank and starve unrelated tabs. A
  rejected obsolete read is diagnosed by count (never path), then that group
  still performs its fresh replacement. All groups submit through the ONE
  provider-owned scheduler, which permits at most TWO simultaneous worker
  queues per lifecycle epoch: an existing slow queue leaves one lane for
  unrelated ready work, but twenty distinct predecessors settling together
  cannot create twenty queues. This is a concurrency bound, not a liveness
  timeout. Scheduling class comes from the CALLER'S logical intent, never the
  physical key count after dedupe or predecessor grouping. Tab open and explicit
  tab Retry pass `interactive`; preview/report loads and canonical
  `FILE_EXPLORER_REFRESH_EVENT` reloads pass `background`. Every dependent
  reload group carries that original intent even when twenty groups each contain
  one key. Singleton background work remains background. If a tab open/Retry
  requests a key already queued inside a background ticket, the scheduler
  extracts only that key into a new interactive tail ticket, including when it
  was the background ticket's sole key; unrelated bulk keys never hitchhike,
  queue position never depends on the old batch shape, the original logical
  request waits for both pieces, and the file is read only once. Explicit Retry
  performs that promotion/join before starting a replacement generation;
  watcher refresh retains predecessor-replacement semantics. Interactive work
  takes the next free lane ahead of queued
  background work; FIFO is preserved within each class, and after TWO consecutive
  interactive dispatches while background work waits, one background batch runs
  before another interactive batch. Active work is never preempted.
  `FileContentWorker` accepts an optional `AbortSignal`, but the shared
  loader currently passes no controller and there is no content-read timeout or
  user-cancel policy. If two adapter reads never settle, both lanes remain
  occupied, keys sharing either predecessor remain coupled, and queued batches
  plus their logical waiters remain pending. Do not invent an elapsed-time
  cutoff here: a safe bound needs an explicit cancellation owner/trigger and
  adapter cancellation contract.
  Each completed group clears its own
  generation; active-load entries are identity-cleaned on settlement, so
  close/reopen churn does not create an unbounded key registry. Read preparation
  is settled per key rather than fail-fast: valid siblings still reach the
  worker, while preparation and worker failures clear every marked key and
  update a provider-owned immutable error map only for current failed composite
  keys. That map is a live projection, not an error history: a key is retained
  only while its physical read is active or an explicit consumer owns it.
  `WorkspaceTabsProvider` subscribes synchronously to the tab store and owns
  exactly its open composite keys, so the durable projection is bounded by the
  tab store's hard maximum of 20. Single close, bulk close, external hydration,
  oldest-tab eviction, unmount, and factory reset all retire their keys
  immediately. Direct preview reads and context export are separate UI
  ownership domains. A direct preview rejection becomes a selection-scoped
  accessible alert whose retry reloads those exact keys. Copy/download keep the
  report manager's success/destructive toasts but also return a typed outcome;
  the middle panel owns a failed export as the exact action plus a deep snapshot
  of its range/tree options and retries the WHOLE action, not only its nested
  missing-content load. Report generation receives the raw background loader,
  so a nested content read cannot supersede the outer action epoch or replace
  its accurately labelled copy/download failure with a preview-only retry.
  Root-unavailable outcomes are explicit and non-retryable. Selection change
  fences the retired action by canonical set membership rather than `Set`
  identity, because multi-root projections may recreate a value-equivalent
  selection. Internal error text is logged rather than rendered. There is no
  arbitrary eviction that could hide an
  active tab's terminal error. Every
  physical reload group and deduped active read settles before the
  public logical request rejects with the single error or an aggregate. The
  aggregate object is memoized by the immutable error-map snapshot so an
  unrelated rerender cannot manufacture a new error identity. A later
  successful queued group cannot erase an earlier sibling's failure. A logical
  retry clears only its requested keys at its boundary. `WorkspaceTabsProvider`
  carries that map to `WorkspaceBody`, which exact-matches the active tab's key
  and renders `FileContentErrorScreen` (an accessible terminal `alert`) instead
  of the indefinite pending spinner. The automatic active-tab loader stops at
  that per-key error boundary instead of entering a fail/render/retry loop; a
  user-visible Retry button calls `reloadFileContents([compositeKey], 'interactive')`, which
  clears only that key and starts a fresh read. The screen shows the selected
  file path plus a bounded safe error category, never a raw internal message.
  A later canonical refresh can also clear only the affected key and retry it.
  Content failures never enter the explorer's global error surface or appear on
  unrelated tabs. The authority's `trackActiveLoad`/`releaseActiveLoad` methods
  are test-only predecessor seams; production reads are owned through
  `scheduleBatch`. Fire-and-forget UI consumers explicitly observe the rejection
  after the shared error state is set. Rebuilt worker `FileHandle`s carry
  `fileNode.handle.rootId` when present; `rootFolderId` remains selection/cache
  identity and is NEVER substituted for durable read authority. Removed
  files/directories therefore replace the tab with its loading boundary and
  then a visible read-failure result, never the pre-delete content. Listener
  cleanup is provider-scoped. Absolute handleless reads are gated ONLY by the
  explicit `readFileByAbsolutePath(absolutePath, mountedRootPath, rootId)` adapter
  method. On desktop that adapter uses the distinct visible-UI-only
  `fs:readFileByAbsolutePath` IPC channel, which carries all THREE values. Main
  exact-maps RootId, verifies the claimed presentation/canonical path belongs to
  that SAME live mount, then authorizes the requested path. Duplicate
  presentation aliases and symlink/junction retargets never select the first
  path match. A path under mounted root B therefore cannot be read while
  claiming mounted root A or A's durable identity. Legacy path-shaped composite
  keys that remain unmatched after the descriptor projection is authoritative
  fail visibly instead of falling back to path-only lookup. During async desktop
  boot, an open tab whose exact root descriptor has not arrived remains unloaded;
  the workspace tab effect observes descriptor arrival and retries rather than
  persisting a sticky inaccessible sentinel. `readFileByPath` is
  adapter-defined—the real web adapter implements
  it for root-relative browser-handle resolution—so its presence is never
  treated as desktop/native authority. Web missing/lazy nodes therefore retain
  their cached-handle and permission route even when their root descriptor is a
  non-absolute folder name. Every explicit request is rejected at both the
  worker and adapter boundary unless its durable RootId is non-empty and its
  mounted root and requested file are non-empty fully qualified paths. Native
  reads use the canonical path returned
  by root validation rather than re-reading the original alias. A
  direct-path-capable adapter completes this read
  even when refresh has produced an empty tree (including deletion of the last
  open file); it never returns fulfilled while leaving the tab pending. Direct
  worker requests carry the mounted root and RootId and never fall back to generic
  `readFileByPath` if that explicit capability disappears. Path resolution
  preserves POSIX `/`, Windows drive roots such as `C:\`, and UNC share roots.
  The dev inline-fixture decorator keeps fixture-owned absolute reads on fixture
  bytes while delegating foreign absolute paths to the wrapped capability.
  Relative paths reject empty, control, `.` and `..` segments.
  Absolute paths are accepted only when contained by the selected root, using
  POSIX case-sensitive and Windows drive/UNC case-insensitive semantics; an
  outside absolute path is rejected visibly rather than reinterpreted as a
  relative path or concatenated as a fallback. A structured worker
  `status:'inaccessible'` result is canonicalized through
  `buildInaccessibleContent`, while the exact `BINARY_CONTENT_MESSAGE` sentinel
  is preserved so the tab routes binary files to `BinaryFilePreview` instead of
  rendering either message as source code.

  **Surface audit (BST-1159):** file-tab `CodeSurface` is invoked without
  `editable`/`onChange` (read-only default), Markdown preview is read-only, and
  `DiffView` is read-only. There is no in-app dirty buffer or save capability,
  so inventing a conflict state here would be false architecture. Git-scope
  Changes diffs already own an independent reload-token + generation guard
  (BST-1161); rewind-preview diffs are immutable pre-apply snapshots. External
  editor buffers remain outside Brainstrike's authority and are notice-only.
- **An identical re-enumeration is a no-op in the worker (BST-1336).** Every
  `refreshTree` ends in `port.init(...)`, and one FSEvents overflow fires that
  once per mounted `FileTreeProvider` on the root, so a real desktop log showed
  a single overflow producing a legitimate 118→54 replacement immediately
  followed by a 54→54 one — twice over, once per provider.
  `BFSEngine.setTree` (`packages/file-tree-worker/src/bfs-engine.ts`) now
  returns whether it replaced anything and skips the path-index and
  expansion-set rebuild when the incoming tree is identical;
  `file-tree.worker.ts` then skips the `tree initialized` log and the
  `treeSnapshot` post that make downstream consumers rebuild and re-render.
  **Node count is never the test** — `54 → 54` can be 54 different files.
  Identity is the init folder id (an empty-tree root reset carries no node to
  identify it) plus an order-sensitive deep compare of EVERY `WorkerFileNode`
  field; `TREE_IDENTITY_FIELDS` is a TOTAL record over the node type, so a new
  field fails the build instead of silently escaping the check, and absent
  `children` vs `[]` stay distinct states. The skip additionally requires that
  `expandedPaths` already equals `collectExpandedPaths(tree)` — `collapseAll`
  clears the expansion sets WITHOUT touching the tree, so after a collapse the
  replacement legitimately re-derives them and skipping would strand the
  collapsed state that the next `complete` payload reports. Anything short of
  that certainty replaces; the engine never guesses. The duplicate-provider ×2
  is a separate defect and is NOT addressed here.
- **Manual refresh contract.** `file-explorer-panel.tsx` `handleRefresh`
  awaits `refreshFileExplorer()` (the OUTER provider) and dispatches the full
  event only on SUCCESS — a cancelled or failed refresh must not trigger
  downstream full syncs (pinned by the panel tests). The outer, non-nested
  provider is the panel's direct refresh authority and sets
  `skipManualFullEvents` (nested detection via the inherited forest index
  registry), so it ignores the event it just caused; every nested forest
  RootSection provider reacts — that is what makes the toolbar Refresh reach
  every forest root, including the focused root's VISIBLE section.
- **Selection follows authoritative directory replacement (BST-1166).** The
  file-explorer store remains the selection source of truth; filtered display
  rows and the virtualized tree never rewrite it. A forced root refresh emits
  its complete root listing, while watcher-driven loaded-directory refreshes
  return complete per-directory snapshots. `FileTreeProvider` reconciles those
  snapshots through the durable root id: selected direct files absent from a
  refreshed directory are removed, as are selected descendants beneath a
  removed child directory; direct files and descendants of a surviving child
  directory remain selected. Query-backed selection stays in query mode and
  records a vanished manifest path as an exclusion instead of degrading to an
  explicit set. Path joining is slash-aware so drive roots such as `C:/` retain
  surviving selections under the normalized `c:/` identity. When one batch
  contains overlapping directory snapshots, an authoritative ancestor that no
  longer lists the descendant directory wins over a nearer descendant snapshot,
  regardless of collection order; a `loadMore`/`truncated` pseudo-row makes that
  directory snapshot non-authoritative, so it cannot disprove selection.
  Ordinary expand, restoration, and expand-all enumeration never trigger
  reconciliation. Authoritative directories refresh parent-depth-first against
  the shared normalized tree, with a work-conserving pool of at most five
  same-depth reads in flight and no cap or truncation of the derived path set.
  A freed slot immediately starts the next peer, while the next depth still
  waits for every shallower peer; all complete snapshots from the batch then
  publish through one store update bound to the root identity that started the
  batch. The finite work bound is the number of unique ancestors
  derived from the bounded selection projection (at most selected paths times
  their ancestor depth), while live I/O remains bounded to five. Direct manual
  refreshes and refresh events run through one lossless queue per provider, so
  they cannot publish overlapping snapshots. Consecutive full requests are
  losslessly bounded to the active physical refresh plus at most one trailing
  authoritative refresh: requests that arrive before a pending refresh starts
  join it and receive its exact outcome, while the pending slot clears when I/O
  starts so a later mutation retains one trailing read. Incremental events are
  FIFO mutation boundaries and always break full-request coalescing; they are
  never reordered or dropped. Each provider owns a monotonic,
  root-scoped effective-projection revision. At each fence read it resolves the
  canonical selected path set through `getSelectionProjectionPaths` and advances
  only when that set or root identity actually changes. Query-manifest updates,
  focused explicit changes, and foreign `folderStates` writes are therefore all
  observed without relying on incomplete action counters; value-equivalent
  no-ops do not advance it. A directory batch discards its entire stale snapshot
  set if that revision changes before publication; it never reconciles an older
  snapshot against a newer selection. A same-path root-id switch during a later
  directory read can never retarget already-completed snapshots. A failed peer
  stops new pool assignments, while every already-started peer drains before
  the first error rejects the job; the provider queue therefore cannot advance
  into overlapping late tree commits. The failed job is surfaced and consumed
  so later events still run. Every queued job carries
  the provider effect's lifecycle epoch;
  cleanup invalidates that epoch, so retired jobs stop before new I/O and an
  in-flight job discards all snapshots after its next await instead of
  reconciling through an unmounted provider. A direct caller receives
  `{status:'cancelled'}` when retirement crosses either the root read or
  directory revalidation await; only a still-active caller receives the raw
  completed/cancelled outcome. Watcher changes retry `error`
  directories and retain invalidations
  for `loading` directories by forcing a fresh read instead of joining the
  pre-event request. Genuinely `unloaded` nonselected directories still wait
  for expansion, but an exact changed parent that is also a selected-path
  ancestor is re-enumerated even while collapsed/unloaded so a removal can
  disprove stale selected descendants. This intersection is bounded to event
  parents; it never sweeps every selected directory.
  A shallow root replacement
  cannot prove nested membership merely because its top-level directory
  survives, so every successful watcher/full or manual/full root refresh
  derives the current selection's unique ancestor directories from the core
  explicit/query projection, refreshes those surviving directories parent-first,
  and publishes their snapshots as one bounded batch. The outer provider's
  direct toolbar refresh uses that same orchestration before it ignores the
  manual/full fan-out event; nested forest providers perform it while handling
  the event. Ancestor derivation preserves each selected path's exact mixed,
  drive, or UNC separator presentation for normalized-tree lookup and uses a
  normalized identity only for containment, dedupe, and ordering. Mixed
  root+directory watcher batches likewise force-refresh a
  surviving directory even when the shallow root reload reset it to `unloaded`,
  while removed or file-retyped paths skip. The reducer indexes snapshots once
  and walks only the bounded selection paths and their ancestors, never the full
  or filtered tree. When a query manifest is absent, loading, errored, or
  mismatched, reconciliation mutates only its exact materialized projection
  (paths, exclusions, count, and version) and preserves query mode; it never
  invents manifest membership. Forced root snapshots carry the root id resolved
  by that refresh, and forced directory snapshots capture both committed root
  identity and generation before I/O; a late callback or directory read after a
  same-path root-id switch therefore returns no snapshot for the new root. A
  forced directory refresh also retires any older renderer or worker-backed
  expansion/restoration read for that path, removes buffered pre-event evidence,
  commits outside renderer expand-all batching, and owns a token-checked
  in-flight entry, so it cannot join a pre-mutation listing or have that listing
  erase its registry entry. Its directory existence/type check is a normalized
  O(1) lookup and its authoritative result materializes only immediate children,
  never the descendant subtree. The worker port exposes one shared bulk operation,
  so retiring a worker-backed read cancels that active bulk sweep as a unit;
  the replacement physical read remains scoped to the affected directory, then
  the original bounded restoration/expand request continues through the
  renderer so unrelated paths are not silently reported as restored. Starting
  another bulk operation marks the displaced operation retired before taking
  the shared worker slot; the port's supersession rejection therefore triggers
  that same bounded renderer replay instead of being logged and falsely
  settling the older restoration. Every worker `requestLoad` also owns a
  request-id-scoped renderer `AbortController`. Explicit abort, bulk
  supersession, runtime failure, and port termination abort and remove all live
  request controllers; ordinary settlement removes only the identity-matching
  controller, keeping the registry bounded. Runtime failure and port
  termination also reject and clear the shared pending bulk operation before
  worker disposal, so provider cleanup cannot strand restoration ownership
  across a remount. The lazy-tree caller propagates every non-retired worker or
  patch failure instead of reporting successful restoration; only an
  explicitly watcher-retired worker operation continues through the bounded
  serial replay. Restoration locks carry provider-owner identity: owner
  unmount deletes even an in-flight entry, late finalizers touch only their
  exact entry, and only a successful physical load plus expansion commit marks
  the restoration key complete. Abort cancellation is a retryable retirement:
  it neither warning-logs nor records a failed automatic attempt, and the same
  provider/root/key can retry after the physical promise settles. Every physical
  settlement still owned by the hook advances its local completion version, so
  a root or restoration-key change that waited behind older I/O resumes after
  that exact rejection/settlement boundary. A visible non-abort failure records
  one failed automatic attempt for that provider/root/key; the completion wake
  does not mark it successful or spin on loading-state transitions. Unmount or a
  new root/key releases the owner-scoped record and is the explicit retry
  boundary. Stale or terminated runs likewise remain retryable without
  releasing another provider's lock. The signal
  fences the handle-map publication after directory I/O, and the port
  suppresses any result/error that settles after its request was retired. As a
  second ordering defense, the
  BFS engine rejects a correlated result/error whose request id and path are no
  longer pending before touching its tree; legacy id-less standalone updates
  remain valid. A forced
  root refresh retires the same provider's
  active root/child/bulk consumers and waits for any still-live shared root read
  that crossed the invalidation boundary before starting fresh physical I/O;
  every actively loading child in the retained normalized snapshot is reset to
  `unloaded` before replacement I/O, so a failed or cancelled root read leaves
  no non-retryable loading marker or stale child controller;
  the shared registry deletes only identity-matching settled entries and remains
  bounded to live requests. Structural changes directly beneath a Windows drive
  root retain the `C:/` or `C:\\` parent boundary and therefore trigger the
  required root refresh. Explicit selection reconciliation decodes every key
  through the canonical strict selection codec; missing separators and empty
  folder/path components throw instead of becoming ghost selections. The
  persistence validator salvages canonical keys, drops malformed entries, and
  raises the existing redacted discard notice before strict merge, while a
  direct merge of unvalidated keys fails visibly. Selection is files-only: a
  direct authoritative directory hit at a selected path is a stale
  file-to-directory retype and removes that selection. An ordinary
  joined/already-applied root load does not publish initial-loading state or
  clear active child loading paths; only a genuine initial load or a
  forced/fresh root boundary publishes root-pending state.
  `loadSpecificPaths` rejects every non-abort worker, patch-rehydration, or
  serial directory-read failure after publishing the visible tree error.
  Restoration callers consume that rejection without retrying it in an effect
  loop; abort semantics remain cancellation rather than a visible tree error.
  Pinned by `file-selection-reconciliation.test.ts`,
  `use-file-tree-refresh-events.test.tsx`, `use-file-tree-context.test.ts`,
  `use-file-tree-worker.test.tsx`, `port.test.ts`, `bfs-engine.test.ts`, and
  `file-tree-provider.test.tsx`.
- **Narrow toolbar geometry.** The Explorer panel's 180px minimum width leaves
  a 76px right grid track. Below 236px, Refresh, View Filters **and Expand All /
  Collapse All** move into one 24px compact-actions menu beside the 24px Select
  All control, preserving the symmetric 12px edge gutters and WCAG-size hit
  regions. At 236px, the menu is replaced by the full Refresh and View Filters
  controls; all three right-side controls are 28px with 4px gaps. Select All
  remains the edge action at every width, preventing any sibling from
  intercepting its pointer region.
  Expand All / Collapse All appear at that SAME 236px step, but in the **left**
  track beside the selection status — the right track is exactly full at every
  step below, and these two used to avoid the problem by floating over the tree
  (retired: the overlay covered the tree grid's column header and ate its
  clicks; see `docs/agents/ui-conventions.md`). Adding them costs the left track
  ~60px, so the compact selection COUNTER yields below **180px of track** — the
  measured sum of the 12px gutter, the status cluster's 106px of content, the
  4px gap and the 58px expansion pair. The selection-mode badge still renders
  the compact count, so no state is lost. The status cluster is also
  `overflow-hidden`: it is `min-w-0`, so without clipping a shrunk box spills
  its content over the expansion buttons and swallows their clicks (observed
  live at a 349px panel before the threshold was corrected).
  No new breakpoint was introduced — every toolbar action has exactly one home
  at every width.
  At **300px** a FOURTH control joins — the tree-grid Columns popover
  (BST-1208) — because that is the first width whose ~136px right track holds
  four 28px controls, three 4px gaps and the 12px gutter. It sits in its own
  `@[300px]/explorer-toolbar:contents` wrapper, before Refresh/View Filters, so
  the documented three-control geometry at 236px is unchanged. 300px is ALSO
  the width below which the tree grid suppresses its metadata columns
  (`METADATA_COLUMNS_MIN_WIDTH` in
  `packages/file-explorer-ui/src/shell/explorer-columns-context.ts`) — the
  two are tied on purpose so the grid never shows a column the user has no way
  to hide. Render-time width projection reserves 120px for Name and apportions
  the remaining whole pixels with a largest-remainder allocation. On the
  proportional-shrink path, metadata widths never collectively exceed the
  panel budget; when even the columns' minimums do not fit, their declared
  minimums intentionally win. Output-identical projections retain their
  map/context identity so sub-pixel ResizeObserver churn does not repaint every
  consumer. Pinned by `shell/explorer-columns-context.ts`,
  `file-explorer-toolbar.test.tsx` and `explorer-column-header.test.tsx`.
- **The cancel affordance is never width-gated.** The inline scanning
  indicator's Cancel (X) is the ONLY way to abort a running expand-all sweep —
  Refresh is disabled for the duration and the compact menu has never carried a
  cancel — so `treeActionsControl` renders OUTSIDE the `@[236px]:contents
  hidden` wrapper and the cancel button carries no container query. #1916
  originally swept the whole tree-actions cluster into that wrapper, which left
  the 180px default-width desktop panel with no abort at all; the desktop
  expand-all E2E caught it once the lane started collecting again (BST-1217).
  Only ONE cancel node may exist in the DOM — a second, narrow-width copy would
  trip Playwright strict mode even while `display:none` — so width adaptation
  happens by collapsing the indicator's spinner and count, never by duplicating
  the button. To keep the 76px track's math intact, the compact-actions menu
  yields its slot for the duration of an operation
  (`resolveCompactToolbarActionsState` → `yielded-to-cancel`); its only live
  item is View Filters, since its Refresh item is disabled mid-operation.
- **Paired tests:**
  `packages/file-tree-worker/src/bfs-engine.test.ts` (identical-tree skip,
  including same-count-different-content and post-`collapseAll` replacement),
  `packages/file-tree-worker/src/file-tree.worker.test.ts` (a skipped init
  posts no snapshot),
  `packages/file-explorer-ui/src/tree/__tests__/use-file-tree-refresh-events.test.tsx`
  (tree consumer: incremental + overflow),
  `packages/file-explorer-ui/src/__tests__/use-file-system-context.test.ts`
  (dispatch shaping + overflow one-shot / errored toast),
  `packages/file-system/src/__tests__/web-adapter.test.ts` (record mapping +
  health signals),
  `apps/desktop/src/__tests__/ipc-domains/file-system-watch-ipc.test.ts`,
  `apps/desktop/src/__tests__/renderer/adapters.test.ts` (watchDirectory),
  `packages/file-explorer-hooks/src/__tests__/use-file-system-watcher.test.ts`
  (per-root lifecycle + signal threading),
  `packages/file-explorer-ui/src/__tests__/file-explorer-panel-toolbar-logic.test.ts`
  (compact menu yields to cancel),
  `packages/file-explorer-ui/src/__tests__/file-explorer-toolbar.test.tsx` +
  `tree-action-buttons.test.tsx` (cancel is never width-gated),
  `apps/desktop/e2e/file-explorer-selection.desktop.test.ts` (expand-all cancel
  at the 180px default width),
  `packages/app-shell/src/background-indexing/__tests__/workspace-collection-sync-provider.test.tsx`
  (per-root full resync scoping),
  `packages/app-shell/src/changes/__tests__/use-rewind-explorer-recovery.test.tsx`
  (post-rewind refresh + `failed`-only retry) and its wiring in
  `packages/app-shell/src/changes/__tests__/rewind-confirm-dialog.test.tsx`,
  `packages/file-system/src/__tests__/electron-watchers.test.ts`.
  Open-tab content refresh is pinned by
  `packages/file-explorer-ui/src/__tests__/workspace-tabs-refresh.test.tsx`
  (incremental/full/deleted/multi-root/Windows/commit-phase freshness/cleanup) and
  `packages/file-explorer-ui/src/__tests__/use-shared-file-content-loading.test.tsx`
  (web cached-handle routing versus explicit native absolute-path authority),
  `packages/file-explorer-ui/src/__tests__/use-shared-file-content-reload.test.tsx`
  (same-hook and cross-hook stale suppression, ready/dependent/rejected batch
  scheduling, reset/replacement lifecycle isolation, per-key preparation and
  worker-error settlement, all-settle rejection across independent groups,
  owned versus transient error retention, empty-tree direct refresh, twenty-group
  queue bounds, and nested-handle RootId forwarding),
  `packages/file-explorer-ui/src/__tests__/workspace-tabs-error-lifecycle.test.tsx`
  (single/bulk close, twenty-tab eviction, and reset pruning),
  `packages/file-explorer-ui/src/__tests__/file-content-direct-read-path.test.ts`
  (explicit capability routing plus POSIX/drive/UNC root preservation and
  strict containment),
  `packages/file-explorer-ui/src/__tests__/file-explorer-provider.test.tsx`
  (live factory-reset content/cache clearing), plus
  `packages/file-explorer/src/__tests__/file-content-actions.test.ts`
  (store-scoped cache/reset lifecycle).

When changing this flow, update this section and the paired tests.
