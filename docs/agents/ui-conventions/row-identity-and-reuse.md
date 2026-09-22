# Row identity, reuse, and expansion state — evidence

Supports `docs/agents/ui-conventions.md` § "TREEGRID CONVERGENCE CONTRACT".
Read before changing flatten-level reuse, adapter node identity, the selection store's WeakMap projection, or the workspace-global expansion set.

Extracted verbatim from the pre-distillation contract.

---

- Row render stability is a pinned contract (`tree-table-render-stability.test.tsx`):
  row-facing handlers are identity-stable (`useEventCallback`), the keyboard
  `actions` object and the virtualizer measure adapter are memoized, and the
  flatten pass reuses value-equal row objects (`reuseEqualFlattenedRows`) so a
  selection/highlight/focus change re-renders only affected rows. Do not pass
  per-render object/function identities into `TreeTableRow` — the row memo is
  the scroll/keyboard hot path for every tree surface.
- The flatten-level reuse requires `a.node === b.node`, so ADAPTERS must feed
  TreeTable identity-stable `TreeNode` objects. OptimizedFileTree pins this
  (`optimized-file-tree-row-reuse.test.ts`): normalized nodes project through
  `materializeNormalizedNodeStable` (WeakMap on the immutable normalized node)
  and every row build runs through `reuseEqualFileTreeRows`, which reuses the
  previous build's row objects — and the previous rows ARRAY when nothing
  changed — so untouched rows keep identity across expansion/loading rebuilds.
  Do not reintroduce per-build `{ ...node }` spreads in the row builders.
- Explicit file-tree selection prepares absolute/root-relative/bare-relative
  composite lookup keys once per node identity, shared by file rows and loaded
  child traversal (`optimized-file-tree-selection-store.test.ts`). Its WeakMap
  retains at most one projection per live node and replaces that projection
  when its folder or path changes; removed and reloaded nodes do not accumulate
  in a strong path cache. Callers must pass the stable source/materialized node
  identity. Retaining its small key array for the node's lifetime is an
  intentional memory trade for avoiding repeated allocation. Each read still
  checks the current selection Set; parity with the core
  `isPathSelectedInFolder` predicate is pinned in the selection-counts tests.
  Never cache checkbox membership in the alias projection or change the path
  candidates used by deselection. The 10,000-node operation-count regression
  pins that selection changes do not repeat unchanged nodes' path preparation.
- Expansion state is one workspace-global set across all forest roots. Each
  tree section selects it THROUGH `scopeExpandedPathsToRoot` (settled
  root-scoping semantics shared with persisted-expansion restoration, see
  `root-scoped-paths.ts`) with content equality, so an expand/collapse in one
  root rebuilds only that root's rows
  (`optimized-file-tree-forest-invalidation.test.tsx`). Relative-path (web
  FSA) roots still cross-match by design — the accepted phase-4 limitation.
- The store's `setExpandedPaths` ADOPTS the caller's set (no defensive clone);
  every caller hands over a freshly built set and must not mutate it after.

