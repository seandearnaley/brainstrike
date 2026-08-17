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

Paired tests: `file-tab-pane-store.test.ts`,
`file-tab-body-pane.test.tsx`, `apps/web/e2e/file-tab-pane.test.ts`. When
changing pane semantics, update this section and those tests together.

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
  stays alive. The 150ms/500-item batcher and `fileFilter.shouldIgnorePath`
  apply, plus (BST-1342) the background-indexing policy's unconditional
  excluded-path prefixes (`.claude/worktrees`) checked ROOT-RELATIVELY via
  `isExcludedBackgroundIndexingPath` — a subscription root opened inside an
  excluded tree watches normally; only nested excluded trees are silenced.
  Deliberate consequence: a NESTED worktree subtree stays VISIBLE in the
  Explorer (`fileFilter` unchanged; the token-indexer e2e still expands into
  it) but is no longer live-refreshed — external changes there appear only
  on manual re-enumeration. That is the point of the fix (run-5189: worktree
  churn flooding FSEvents drove overflow → full-refresh storms → DB-host
  saturation that killed an active run); do not "fix" the staleness back
  into a watch. DEFAULT_IGNORE_PATTERNS and (for roots outside excluded
  trees) the excluded-path globs also feed native-level ignore globs — same
  rules, never broader. A per-subscription `ignorePatterns` override exists
  (BST-1112, see `docs/agents/platform-contracts.md`) for main-owned callers
  outside this pipeline, e.g. a git-metadata watcher; the Explorer refresh
  pipeline described here NEVER passes it, so "same names, never broader"
  holds unconditionally for this path. Typed watcher health
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
  `scope:'incremental'`, per-root `FileSystemChange[]`).
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
  never reloads).
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

When changing this flow, update this section and the paired tests.
