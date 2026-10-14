# Explorer tree grid — evidence

Supports `docs/agents/ui-conventions.md` § "TREEGRID CONVERGENCE CONTRACT".
BST-1207 / BST-1208. Read before changing the metadata store subscription shape, the source registry, directory rollups, column width clamping, header placement, or the header's a11y contract.

Extracted verbatim from the pre-distillation contract.

---

- **Explorer tree GRID (BST-1208).** The file explorer renders four columns:
  `name` (the tree column — pinned, no width, never hideable) plus
  `type`/`tokens`/`size`. One definition serves every renderer
  (`tree/file-tree-columns.tsx`); widths come from
  `app-state/stores/explorer-column-sizes-store` and visibility from
  `explorer-column-visibility-store` (default: Name + Tokens; Type/Size
  opt-in). Rules:
  - Metadata cells subscribe PER COMPOSITE KEY to the BST-1207 metadata store
    (`useSyncExternalStore`). A token arrival must repaint one cell — never a
    row rebuild, never a sibling row
    (`__tests__/explorer-tree-grid.test.tsx`). The columns array is memoized on
    the visible-column id list, which is content-stable.
  - The store is owned by the PANEL (the only place `onTokenResolved` can reach
    the background indexer) and reads its tree-shaped sources through
    `indexing/file-row-metadata-source-registry.ts`; each rendered tree
    registers the enumeration for ITS root. A directory the registry cannot
    enumerate answers with an explicit incomplete subtree — the type is
    non-nullable, so "not enumerated yet" and "this key is a file" are one
    honest partial marker rather than a shared `null`.
  - The same registry carries each root's VISIBLE file keys, merged for the
    panel's background token indexer. Deriving that set from the panel's own
    `useFileExplorer()` tree covers the FOCUSED root only, which left every
    other forest section's Tokens cells `pending` forever (and its folder Size
    totals with them, since a rollup goes partial on the first pending
    descendant). Pinned by `__tests__/explorer-forest-visible-indexing.test.tsx`.
  - Non-values are explicit and distinct: `pending` is a placeholder (never
    `0`), `excluded` is an em dash with the binary tooltip, and a PARTIAL
    directory rollup never renders a number. A row whose composite key cannot
    be built is an ERROR, not pending: it renders the unavailable dash with an
    error tooltip and logs once. Likewise the source registry logs a malformed
    composite key at error level (once per key) while an unregistered root —
    legitimate and transient — stays quiet.
  - Folder rollups refuse subtrees above `DIRECTORY_ROLLUP_MAX_FILES`, reported
    honestly as unavailable / "not fully enumerated". The first read of any
    rollup is deferred off the paint path and is separately tagged
    `recomputing`: it resolves the queued batch one task later and invalidates
    just those keys. Never apply in-progress copy to the capped, unloaded, or
    failed `not-enumerated` state. Measured
    justification lives in `__tests__/explorer-directory-rollup-cost.test.ts`
    (30 capped directory rows = 21-29ms of synchronous aggregation). Do not
    make the first read compute inline again.
  - **Widths are clamped to the panel at render time**
    (`resolveExplorerColumnWidths`). `table-fixed` gives the Name column
    whatever the metadata columns leave — including zero — and the section
    wrapper is `overflow-hidden`, so oversized persisted widths silently
    clipped the trailing column off-panel and erased every filename. Columns
    shrink proportionally, never below their own `minWidth`, and always reserve
    120px for Name. The clamp is a projection, never a mutation: the store
    keeps the user's width and widening the panel restores it, which is why
    resizes are forwarded per CHANGED column (`setColumn`) rather than as a
    whole map.
  - **Header shape depends on the scroll owner.** Single-root passes
    `showColumnHeader` and uses TreeTable's own sticky header inside its
    viewport. FOREST mode renders ONE panel-level header
    (`shell/explorer-column-header.tsx`) ABOVE the shared scroller and keeps
    every section table headerless — N sticky headers would stack against the
    same scrollport. That header aligns by construction: same `table-fixed` +
    `<colgroup>` algorithm, same width store, minus the scroller's measured
    scrollbar gutter (0 with overlay scrollbars). Pinned by
    `__tests__/explorer-column-header.test.tsx`. Do NOT put sticky headers
    inside shared-scroller sections.

---

  - a11y for that header: it is `role="presentation"` with `aria-hidden`
    STATIC labels when they are non-interactive, because one header cannot be
    ARIA-associated with N sibling treegrids and every metadata cell already
    self-describes via sr-only text. Sort buttons and resize handles stay in the
    accessibility tree — never bury focusable controls under `aria-hidden`.
    `aria-sort` on those presentational `th`s is therefore **inert** — nothing
    announces it; the sort state reaches AT through each sort button's
    `aria-label` ("Tokens: sorted descending; restore default order"). The
    attribute stays because the tests assert the markup contract shared with
    TreeTable's own header, where it is a real `columnheader` and NOT inert.
    Each forest section names its own root
    (`aria-label="File tree: <root>"`); single-root stays `"File tree"`.
    TreeTable's own header cells carry `scope="col"`.
  - Below 300px of panel width every metadata COLUMN is suppressed, leaving the
    name column alone. The header itself still renders — in BOTH layouts: forest
    renders it unconditionally, and single-root passes `showColumnHeader`
    whenever the Explorer sort context is mounted, never off the visible-column
    count. It carries the Name sort affordance and its `aria-sort`, which are
    not metadata capabilities and must stay reachable at every width; gating it
    on metadata columns left a sorted tree with no way to change or clear the
    sort. Pinned by `__tests__/explorer-column-header.test.tsx`. That threshold
    is deliberately the same width at which the toolbar can host the Columns
    control — see the narrow-toolbar geometry in
    `docs/agents/explorer-search-tapestry.md`; keep the two in step.

