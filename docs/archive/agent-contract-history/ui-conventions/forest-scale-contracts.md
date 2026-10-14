# Forest-mode scale contracts — evidence

Supports `docs/agents/ui-conventions.md` § "TREEGRID CONVERGENCE CONTRACT".
Read before changing the forest registry, section registration, the Expand All / Collapse All placement, or the shared per-section display derivation. PR #1734 audit.

Extracted verbatim from the pre-distillation contract.

---

- Forest-mode scale contracts (PR #1734 audit; pinned by
  `forest-tree-actions-context.test.tsx`, `forest-section-filtering.test.tsx`,
  and the `filteredPathSet`-skip tests in
  `optimized-file-tree-filtered-selection.test.tsx`):
  - The forest registry (`forest-tree-actions-provider.tsx` plus
    `forest-tree-actions-context.ts`) keeps observable state off the actions
    value: that value is identity-stable for the provider's lifetime, and the
    expand-all progress aggregate is an external store read only through
    `useForestExpandAllProgress` (a toolbar leaf), never through the actions
    context. Progress reports aggregate by per-section delta and publish at
    most once per animation frame. Do not put observable state back on the
    actions value — that re-rendered every section pane per progress event.
  - Section registration lives in `RootSectionInner`, ABOVE the collapse
    branch — never in `PerRootTreePane`. A collapsed section unmounts its
    pane; a pane-scoped registration made Expand All / Select All silently
    skip collapsed roots (BST-571). Each registration exposes `setCollapsed`:
    `runExpandAll` opens a section as its sweep turn starts, and the panel's
    Collapse All closes every header via `collapseAllSections` in addition to
    clearing the workspace expansion set. Pinned by
    `forest-section-collapse.test.tsx`.
  - Expand All / Collapse All render in the TOOLBAR's LEFT track
    (`components/tree-expansion-buttons.tsx`), keeping their historical
    `*-button-small` testids; the right cluster hosts Refresh + the inline
    scanning indicator. They floated over the tree area's top-right corner
    until BST-1208 put the tree grid's column header there — the overlay
    covered the trailing metadata header and INTERCEPTED its clicks, making
    click-to-sort unreachable by ordinary pointer use at the panel's normal
    width. **Do not reintroduce a tree-area overlay for them.** The one
    remaining tree overlay is `RestorationStatus`, which is
    `pointer-events-none` and must still never shift tree rows.
  - Each forest section computes ONE shared display derivation
    (`RootSectionInner`): view filters + quick filter + visible-file counts
    feed both the header select-all checkbox and the tree pane. The INPUT
    tree is deferred (`useDeferredValue`) BEFORE the filter passes; the
    canonical `treeContext.fileTree` stays immediate for loading/selection.
  - `OptimizedFileTree` accepts `isDisplayTreeFiltered`; `false` skips the
    O(N) filtered-path-set walk on the normalized path (null set = no
    restriction). Callers that cannot tell omit it (conservative build).

