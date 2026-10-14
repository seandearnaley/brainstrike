# Per-directory sorting and its measured cost — evidence

Supports `docs/agents/ui-conventions.md` § "TREEGRID CONVERGENCE CONTRACT".
BST-1209. Read before changing the comparator, the metadata seam's invalidation shape, or the structural-rebuild cost floor.

Extracted verbatim from the pre-distillation contract.

---

  - **Per-directory sorting (BST-1209) is caller-owned.** TreeTable renders the
    sortable header, `aria-sort`, and `onSortChange` cycle but NEVER reorders
    nodes. The Explorer caller sorts siblings within EACH parent before passing
    pre-flattened rows; descendants never move across parent boundaries.
    Directories-first is invariant for every field and direction. Equal keys
    fall back to the existing locale-aware name order. The persisted sort is
    one panel-global state shared by every forest section; `null` preserves the
    loader's directories-first/name-ascending default.
  - Size/token ordering reads the same A1 metadata snapshots the cells render.
    `pending`, `excluded`, and partial/unknown rollups are ABSENT — never zero —
    and sort after every resolved number in BOTH directions. A metadata arrival
    may legitimately reorder siblings while that field is active; the metadata
    store coalesces each per-root invalidation batch into one row rebuild.
  - **A structural change costs TWO full projection rebuild+sorts, and that is
    the floor today.** MEASURED on a 10,100-row projection with a tokens sort
    active (`__tests__/explorer-sort-structural-cost.integration.test.tsx`): an
    expand or collapse rebuilds and re-sorts the WHOLE projection twice — the
    structural rebuild itself, plus the seam's `invalidateAll` reconciliation,
    whose per-root revision bump cannot honestly be narrowed to observed
    changes (the comparator reads file values the store deliberately does not
    cache — see `subscribeFolder`). It used to be THREE: the deferred rollup
    flush bumped the same revision unconditionally even though a collapse
    re-resolves the same totals. That flush now goes through
    `invalidateDirectories`, which notifies only where a rollup actually moved —
    honest for DIRECTORY keys specifically, because `getDirectorySnapshot`
    caches every rollup it is asked for, so the cache IS the projection there.
    Do not point the flush back at `invalidate`.
  - **A reorder is NOT a structural change.** The metadata seam's rollup
    reconciliation keys off `FileTreeRowReuseCache.getStructureRevision()`, never
    off the rows ARRAY identity: sorting mints a new array, reconciling clears
    rollups, cleared rollups bump the sort's revision, and the order oscillates
    once per macrotask forever. Pinned by
    `__tests__/explorer-sort-rebuild-loop.test.tsx`; do not re-key that effect on
    `treeRows`.
  - The comparator reads the seam ONCE PER ROW (Schwartzian, in
    `sortRowsPerDirectory`), not per comparison — a 10k-row sort makes ~130k
    comparisons and each seam read allocates a composite key. Row-level reads go
    through the store's non-caching `peekSnapshot`, because a comparator sweeps
    the whole projection and caching that sweep would grow the store past the
    subscribed rows and switch its eviction off. Directory rollups DO stay
    cached (a folder listener pins them) — recomputing one walks an enumerated
    subtree. Measured on a synthetic 10,100-node tree in
    `__tests__/optimized-file-tree-sort-performance.test.ts`, which uses the
    real store: a synthetic comparator there measures nothing.
  - Metadata sorts are CAPABILITY-GATED. A surface without the metadata seam
    does not offer Type/Tokens/Size sort affordances at all, and a persisted one
    arriving there resets to the default order with a warn — visible
    degradation, not a crash and not a silent no-op. Name never needs the seam.

