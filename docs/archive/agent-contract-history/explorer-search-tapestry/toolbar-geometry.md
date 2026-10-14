# Explorer toolbar geometry and the cancel affordance — evidence

Supports `docs/agents/explorer-search-tapestry.md` § "EXPLORER TREE LIVE REFRESH".
Read before moving an Explorer toolbar control, changing a container-query breakpoint, or touching the expand-all cancel button. Also lists the section's full paired-test set.

The record below is the pre-distillation contract text for this topic,
extracted verbatim (`sed -n '1371,1471p' docs/agents/explorer-search-tapestry.md`,
2026-09-21). It is historical: correct a wrong fact inline, otherwise append.

## Record (verbatim)

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
