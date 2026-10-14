# Tapestry and the per-file range model — evidence

Supports `docs/agents/explorer-search-tapestry.md` § "TAPESTRY".
Read before changing the context preview panel, the range model, or any context consumer that reads per-file ranges.

The record below is the pre-distillation contract text for this topic,
extracted verbatim (`sed -n '240,321p' docs/agents/explorer-search-tapestry.md`,
2026-09-21). It is historical: correct a wrong fact inline, otherwise append.

## Record (verbatim)

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

  > CORRECTED 2026-09-21: the `detail: true` gate lives in
  > `apps/desktop/src/assistant-server/workspace-context-tools.ts`;
  > `assistant-tools.ts` only composes the executors that route to it.
- **Context traversal boundary:** `context-generation.ts` accepts only the
  platform-neutral `FileSystemAdapter` and `DirectoryHandle`. Raw browser File
  System Access handles remain behind adapters/consumers. Async exports throw on
  malformed filters or traversal failures; the synchronous preview converts
  only known pattern-validation failures into a typed result and renders them
  visibly.

  > CORRECTED 2026-09-21: the synchronous preview that converts
  > pattern-validation failures into a typed result is
  > `generateProjectTreeTextResult` in
  > `packages/file-explorer/src/project-tree-text.ts`, not `context-generation.ts`.

When changing this flow, update this section and the related tests.