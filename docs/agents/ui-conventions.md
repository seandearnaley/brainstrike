# UI Conventions: TreeGrid Contract, Context Action System

> Extracted from AGENTS.md (2026-07-12). Read before adding tree views or right-click menus. Keep updated with the code.

## TREEGRID CONVERGENCE CONTRACT

Tree behavior across the remaining tree surfaces is converging on shared TreeTable primitives.

Rules:
- Use `packages/ui/src/tree-table/*` as the canonical treegrid implementation.
- Prefer adapting feature surfaces to TreeTable API over duplicating tree render logic in app/package code.
- The Explorer file tree (left nav) is the reference treegrid. BST-1211 retired
  the Context explorer's grouped preview table, so the context preview is no
  longer a treegrid adapter — its only surface is the Tapestry gallery.
- Pickers rendered in popovers must follow the `useCollections` single-owner ruling in `database.md`.
- Preserve WAI-ARIA treegrid semantics (`role="treegrid"`, row/level metadata, keyboard traversal).
- Roving row focus and selection are independent. Keep `data-focused`/`tabIndex`
  for keyboard ownership. Paint the row affordance from `:focus-visible` when the
  row owns DOM focus and from TreeTable's keyboard-modality state while focus
  remains on the treegrid container; pointer-focused rows must not receive a
  persistent ring. Focus tokens are neutral so focus is distinguishable from
  brand/selection color.
- Keep the shared `TreeTableViewport` as the sole two-axis scroll owner and the
  virtualizer's scroll element. Consumer wrappers must remain layout-only
  (`overflow-hidden`); do not reintroduce nested `overflow-auto` wrappers or a
  split header/body scroller. The semantic table and sticky header belong in
  that same viewport.
  - Sanctioned exception — shared-scroller mode (`scrollParentRef`): when
    MULTIPLE TreeTables stack inside one scrolling column (forest sections),
    that column is the single scroll owner. Each table passes the column via
    `scrollParentRef`; its viewport becomes a non-scrolling spacer
    (overflow-visible, natural height) and the virtualizer windows through
    TanStack `scrollMargin` (offset tracked as sibling sections resize). A
    per-table scrollbar inside a scrolling column is the forbidden shape: the
    viewport stretches to content height, never scrolls, and the virtual
    window freezes (blank rows on scroll, full-height DOM — the forest jank
    regression). Guards: `tree-table-shared-scroller.test.tsx` (structure) and
    the forest e2e virtualization spec in `apps/web/e2e/forest-expand-all.test.ts`
    (bounded DOM + non-blank scroll).

Windowing and performance:
- Default strategy should remain `auto` unless a product requirement explicitly pins behavior.
- For search-heavy and large result flows, paged windowing is acceptable when it produces more stable UX than virtual scrolling.
- Avoid full-tree rematerialization during render paths; keep derived rows memoized and keyed by stable node ids.
- Renderer-fallback expand-all (worker unavailable) batches display commits:
  directory results — loaded children AND load errors — buffer in
  `use-lazy-file-tree` and publish once per traversal batch through the
  session's `onBatchLoadsSettled` boundary (before discovery reads), plus on
  cancellation and session end. Per-directory `'loading'` display commits are
  suppressed while the session runs — each `commitNormalizedTree` is an
  O(tree) clone+materialize, so per-directory commits are
  O(tree × directories). Batching is armed ONLY for the renderer session
  (`rendererExpandAllSessionRef`): the worker fast path keeps per-directory
  commits, because buffering a manual load resolved during a worker expand-all
  would let the session-end flush clobber worker-loaded deep subtrees with
  stale shallow children. Pinned by
  `use-lazy-file-tree-expand-all-batching.test.ts`,
  `use-lazy-file-tree-expand-all-worker-interplay.test.ts`, and the
  `onBatchLoadsSettled` ordering test in `direct-directory-traversal.test.ts`.
- Persisted expansion restoration is scoped to the active root path before any
  worker I/O. A multi-root provider must never replay another root's paths.
  Web File System Access roots expose only a relative folder name, so their
  root-relative expansion paths remain in scope while stale absolute paths are
  excluded. Desktop scope comparisons normalize Windows separators and casing
  without changing the persisted or worker-facing path identity.
  Automatic startup restoration is capped at 100 directories per root,
  shallowest-first with selected/query parents prioritized; excess persisted
  paths are collapsed and surfaced through both the restoration progress card
  and a toast. Keep this bound visible—never silently attempt an unbounded
  restore that can monopolize the renderer. Post-restoration selection changes
  use the same root scoping, separator-normalized shallowest-first ordering, and
  100-directory cap before issuing worker I/O. Root scoping must preserve
  descendants when the workspace itself is a POSIX, drive, or UNC filesystem
  root, but a Windows drive-relative sentinel such as `C:` is not the `C:\`
  filesystem root and must never be sent to restoration or consume the cap.
- Query-selection snapshot resolution shares one in-flight read per database
  handle and snapshot id. From initial resolver start — including while the
  database provider is initializing — a read promotes the store manifest to
  `loading` only after 100ms; a quicker ready/error result cancels that timer,
  while longer reads still surface honest loading state. Snapshot reads fail
  after 30 seconds so a wedged database handle cannot pin the dedupe entry.
  Descriptor changes and unmounts cancel timers and result publication only —
  `DbHandle.query` has no abort contract, so the underlying database query may
  continue after logical cancellation or timeout. Every loading, ready, and
  error publication revalidates the canonical manifest fingerprint plus
  snapshot id; unresolved selections use the persisted materialized-path
  fallback, while ready manifests retain only the materialized base and apply
  included/excluded descriptor overrides during resolution. Consumers that
  need effective counts or paths—including forest budgeting and folder-state
  snapshots—must resolve the descriptor plus manifest rather than reading raw
  `manifest.filePaths`. A terminal read error remains visible until the
  descriptor or database lifecycle changes; the resolver does not silently
  retry or coerce the failed snapshot. The read timeout starts only after a
  database handle exists; if database initialization itself never completes,
  the loading state remains visible rather than being misreported as a snapshot
  read timeout.
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
- `rowHeight` selects one of TWO contracts and they are not interchangeable.
  A **function or per-type record** makes the value a first-paint estimate:
  TreeTable attaches TanStack's measure ref, every rendered row is measured,
  and a wrong estimate only costs scrollbar accuracy until measurement lands
  (what the threads panel relies on — see `thread-panel-visible-rows.ts`).
  A **number** disables measurement entirely, which promotes the value to a
  load-bearing promise: the spacer math (`paddingTop = firstIndex * rowHeight`),
  `getTotalSize()`, and every `scrollToIndex`/reveal offset derive from it and
  nothing ever reconciles them against the DOM. A numeric `rowHeight` must
  therefore equal the MEASURED pitch, never a design target.
  `OptimizedFileTree`'s `ROW_HEIGHT` is **29** — a 28px content line (24px
  `h-6` control + `my-0.5`) plus the 1px collapsed `border-b`. It read 32 for a
  long time while rows painted 29: because a table virtualizer positions its
  window with spacer ROWS rather than `translateY`, that never overlapped rows
  or drifted cumulatively (each `paddingTop` re-anchors to model coordinates);
  it instead left the scrollport ~110px shorter than the model, jittering as
  the window resized, and put the row under every computed offset off by one.
  Measure the pitch as the delta between consecutive row tops — a single row's
  `getBoundingClientRect().height` reports 28.5, because border collapsing
  splits the 1px rule across neighbours. Pinned live by "paints tree rows at
  exactly the pitch its virtualizer models" in `apps/web/e2e/file-explorer.test.ts`;
  jsdom has no layout, so no unit test can catch this class of drift.
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
- **A header inside the scrollport offsets PAINTED coordinates, not modelled
  ones.** TreeTable's sticky `<thead>` is IN FLOW inside its own scrollport, so
  it contributes to `scrollHeight` and shifts every row's content offset by its
  height — while the virtualizer models tbody rows alone
  (`paddingTop = index * rowHeight`; `scrollMargin` is non-zero ONLY in
  shared-scroller mode, where it carries the table's offset within the shared
  parent). Anything comparing painted geometry to the model must convert by
  subtracting the header height; `apps/web/e2e/file-explorer.test.ts`
  ("paints tree rows at exactly the pitch its virtualizer models") does.
  This is also why reveal is correct WITHOUT a header offset: a start-aligned
  `scrollToIndex` sets `scrollTop = index * rowHeight`, the row's real content
  offset is `headerHeight + index * rowHeight`, and the two cancel so the row
  lands flush at the header's bottom edge. **Do not "fix" this by adding a
  header-sized `scrollMargin`** — that would double-count and push revealed rows
  a header's height too low; and taking the header out of flow would park them
  underneath it. Both directions are pinned by the reveal assertions in that
  same spec.
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
- Query-selection checkbox projection keeps stable descriptor/materialized-set
  identities on WeakMap fast paths. Hydration can recreate an equal
  `materializedPaths` Set, so `selection-projection.ts` also keeps a bounded
  structural tier for its derived ancestor-count map: four LRU entries and an
  8,000,000-unit retained-weight ceiling. Its coarse order-independent key is
  only a lookup bucket; exact Set membership is verified before reuse, so a
  key collision can cost a rebuild but can never return another selection's
  counts. The tier snapshots paths only for verification and never becomes a
  canonical selection source. Signature construction carries total path length
  into weight accounting so the hot path never rescans selection paths merely
  to estimate retention. A deterministic minimum-weight precheck rejects
  structurally uncacheable oversized selections before lookup, exact-set
  verification, full weight estimation, or snapshot creation. Unresolved
  resolver consumers acquire shared ownership of this MODULE-GLOBAL tier;
  structural admission requires a live owner, while unowned callers retain only
  WeakMap identity entries. Ownership is keyed to unresolved query mode rather
  than descriptor or folder identity, so hydration churn does not clear valid
  entries. Only the final live consumer release clears strong entries. Do not
  make the tier unbounded, clear another live consumer's entries, or use it to
  replace `selectionModel.materializedPaths`.
- Any new tree interaction (selection, sort, collapse, keyboard behavior) must include tests in both shared UI package and consuming feature package when behavior diverges.
- Consumers with per-row hidden checkboxes may set `reserveCheckboxSpace` on the tree column so empty/group rows stay aligned with selectable rows without rendering a misleading disabled checkbox. Checkbox-only multi-select surfaces set `selectOnRowClick={false}` so row chrome moves focus without mutating selection.
- Keyboard events from interactive cell descendants (buttons, links, form
  controls, and equivalent ARIA widgets) remain owned by that descendant.
  TreeTable must not reinterpret their Space/Enter activation as row selection
  or checkbox input.
- Tree rows whose content can expand below their primary line must set the tree
  column's `treeControlsPosition` to `top`. This keeps disclosure and checkbox
  controls pinned to the first row line instead of recentering when details
  appear below it.
- Ephemeral selection actions float at the bottom through
  `SelectionActionBarOverlay` + `SelectionActionBar`. `BulkActionBar`
  (`packages/ui/src/bulk-action-bar/`) is the shared node-kind-aware wrapper over
  `SelectionActionBar`; it is surface-neutral, not collection-browser-specific.
  Keep the scroll owner
  padded at the bottom while the overlay is present; never insert the toolbar in
  normal flow or compensate with top padding, because selection must not shift
  the tree. The overlay's positioned ancestor must own the full available panel
  height, and compact toolbars must receive an explicit available width; an
  intrinsic-width compact toolbar creates a container-query feedback loop that
  collapses its labels and spacing.
- A colored tree group may use one continuous, softly tinted surface across its
  header and disclosed rows. The surface must cover the full row, including the
  disclosure and checkbox gutter, while thread identity remains independently
  colorable inside it. Compute surface start/end from the visible row model so
  collapsed, empty, and disclosure-limited groups still close their rounded
  boundary correctly.
- Every surface that renders a thread — the tab strip and the threads-panel
  rows — shares one contract in `assistant-thread-presentation.ts`: the
  `THREAD_CONTROL_*` density/typography tokens (28px control, 32px row pitch,
  12px title, 20px mark) plus one color surface per thread. A control's fill
  comes from `idleClassName`/`selectedClassName`; its identity mark comes from
  `markClassName`, never the surface fill — both surfaces are tinted, so a mark
  reusing the surface fill renders invisible. Use
  `getAssistantThreadColorSurface` rather than re-deriving an "unassigned"
  fallback per call site. Do not re-declare heights or type sizes at a call
  site; that drift is what BST-939 fixed.

When modifying TreeTable strategy or pagination behavior:
- Update the related file explorer / workspace-search adapters.
  (Two adapters have since dropped out: the collection browser, retired by
  BST-1213 — its jobs live in the Explorer import action and the Explorer|Search
  panel — and the context preview table, retired by BST-1211.)
- Add or update tests validating grouped slicing semantics and selection correctness.
- Document intentional tradeoffs (e.g., paged vs virtual) in code comments or PR notes.

---

## TERMINAL SURFACES

The desktop Terminal page owns two capability-gated surfaces: the user's normal
interactive shell (`window.terminal`) and assistant-owned persistent command
sessions (`window.commandSessions`). Keep the shell mounted while switching
surfaces so inspecting an assistant process does not destroy the user's shell.
Web omits both bridges and must not receive stubs or `isElectron()` branches.

The command-session inventory is workspace scoped. Show status, pid, opaque id,
root id, exit code, bounded output, and explicit gap/omission state. Stop,
remove, refresh, and input are direct user actions. Never infer or display a
command from process metadata, and never log or persist command, cwd,
environment, or output. The main-process manager remains the single source of
truth across renderer reloads.

## CONTEXT ACTION SYSTEM

Right-click menus are projections of a shared action system. Do not hand-roll
per-surface context menus (coordinate state + positioned DropdownMenu is the
legacy pattern, and it has no remaining call sites).

Layers:
- Headless core: packages/context-actions — ContextTarget union, ContextAction,
  createActionRegistry, ClipboardService, path helpers. No React rendering, no
  Electron imports. The command registry (⌘K palette commands + the one-way
  bridgeActionToCommand projection) lives in the same package under the
  `@brainstrike/context-actions/commands` subpath export (folded from the
  former @brainstrike/commands package, BST-1004).
- Renderer: packages/ui/src/context-menu — Radix ContextMenu wrapper +
  ActionRegistryProvider + ActionContextMenu + useContextMenuTarget.
- Composition: packages/app-shell/src/context-action-registry.ts builds the
  registry (capabilities from the bridges that exist) and mounts the provider
  in root-layout-content.tsx. Feature actions are imported via subpath exports
  (@brainstrike/db-explorer/context-actions,
  @brainstrike/file-explorer-ui/context-actions) to preserve code-splitting;
  assistant thread copy actions are app-shell-owned. Do NOT import feature-package
  root barrels from always-mounted code.
- Desktop bridge: window.platform (preload) → 'shell' IPC domain →
  apps/desktop/src/ipc-shell.ts (validates absolute paths, catches shell throws).
- Desktop clipboard: window.clipboard.writeText (preload) → 'clipboard' IPC
  domain → apps/desktop/src/ipc-clipboard.ts; the write runs in MAIN and the
  bridge resolves { ok, error? }. It must NOT call Electron's clipboard module
  from the preload — sandboxed preloads (sandbox is on outside test mode)
  cannot require it, which silently breaks every write on real builds.

Rules:
- Capability gating hides actions (no disabled "available on desktop" items).
  Web simply never constructs 'fs.reveal'. No isElectron() checks in action or
  menu code.
- Every action run resolves to ActionOutcome; failures MUST toast + log
  (createLogger('ContextActions')). Thrown/rejected runs are caught by the menu
  and surfaced as "Action failed unexpectedly". No silent fallbacks: a
  present-but-broken bridge reports failure, never degrades quietly.
- Action ids are globally unique for an invocation. Registry construction rejects
  duplicate global ids, and `actionsFor` rejects global/local collisions instead
  of letting renderer order choose an ambiguous executor.
- Adding an action: define it with defineContextAction in the owning feature
  package, add it to that package's exported action array, cover run/gating in
  unit tests.
- Adding a surface: add a target kind to ContextTarget, write a node→target
  adapter, claim the target in the surface's row contextmenu handler via
  controller.setTarget, reset it with onContextMenuCapture on the container,
  wrap with ActionContextMenu. Surface-local actions (closures over surface
  stores) go through the localActions prop, not the global registry.
- Tree-backed surfaces must make the right-clicked row the TreeTable focus
  owner and pass `onCloseAutoFocus` to `ActionContextMenu`. Restore the exact
  live origin row when it remains mounted; if virtualization or a rerender
  removed it, focus the surface's deterministic treegrid fallback. The callback
  prevents Radix's delayed trigger restoration, so it must never silently leave
  focus on `body`.
- Targets are immutable invocation snapshots, not live DOM/store lookups. Claim
  them synchronously during the `contextmenu` event. File viewer targets preserve
  exact text (including whitespace) plus the CodeMirror `{from,to}` range from
  the same event; Markdown selection must be bounded to its preview root. A
  durable file `RootId` is identity, commonly a UUID — resolve its descriptor
  path before building relative/absolute paths and never treat the id as a path.
- Context triggers must stop before native editable/selection surfaces. Thread
  row menus wrap only the non-editing display (rename inputs keep the native
  edit menu), thread-tab menus wrap only the tab lane (assistant message content
  keeps its native selection menu), and workspace app tabs are not file
  targets — as of BST-1258 they are closable singletons with an inline close
  button (and Delete-key close), deliberately WITHOUT a context menu.
- Multi-tab actions execute atomically in the owning Zustand store. Preserve a
  selected pinned app while mutating background file tabs; assistant bulk closes
  update open/active/selected maps together and never mutate durable thread
  history or per-thread draft runtime. Revalidate targets at execution so a menu
  opened against a tab that later closes becomes disabled/fails explicitly.
- `shortcut` is semantic presentation metadata (`primary` maps to Cmd/Ctrl), not
  keyboard ownership. `registry.descriptorsFor(...)` is the serializable boundary
  for a future native context-menu adapter: main may receive descriptors and
  return the chosen action id, but the target and executor stay renderer-owned.
  Never serialize action functions or React icons over IPC. A persistent Electron
  application/File menu additionally requires explicit focused-target ownership.
- Destructive thread actions are staged: row `Delete…` enters the existing inline
  confirmation flow and never deletes durable history directly from a menu run.
- Adding a capability: extend CapabilityKey, construct it in
  createAppActionRegistry only when the backing bridge is fully formed
  (malformed bridges log an error and stay absent).
- Known limitation: Radix touch/pen long-press (~700ms) bypasses the
  contextmenu claiming protocol — desktop-first tradeoff, documented in
  action-context-menu.tsx.
- **A target kind with more than one trigger surface shares ONE claim/reset/
  local-actions hook, not per-surface copies.** The `workspace-root` kind
  (BST-1393; see `docs/agents/workspace-context.md`'s "Root-header context
  menu" paragraph) is the reference example: the forest sidebar's
  `RootSectionInner` and the single-root layout's own header row are
  structurally different (one has a collapsible `RootSectionHeader`, the
  other a plain status row with no such component), but both claim/reset the
  SAME target kind and share the SAME local actions (Set as Main, staged
  Disconnect…). `packages/file-explorer-ui/src/shell/use-root-section-context-menu.ts`
  centralizes that wiring — including the reset-then-claim protocol,
  capability-gated Disconnect (hidden when the caller has no removal
  callback, never a silently-inert visible item), and focus restoration on
  close — so the two surfaces cannot drift apart the way they did before
  review caught the single-root branch shipping with no trigger at all.
  Three more conventions this kind pins: its `path` is `null` for a browser
  FSA root (the adapter normalizes name-as-path to `null`), so path-shaped
  actions gate with `isVisible` by DATA rather than by platform; its menu
  wraps ONLY the header row — the per-root tree pane keeps its own
  `ActionContextMenu` as a SIBLING, because nesting two Radix context menus
  lets the outer one open against a target the inner one claimed; and a host
  package the surface's own package cannot import contributes actions
  through an injected prop (`FileExplorerPanel`'s `rootActions`, the same
  seam its `selectionActions` established — app-shell injects Open in
  Terminal and New Thread Here there).

When changing this flow, update this section and the related tests.

---

## FLOATING LAYER STACKING (BST-963)

`packages/ui/src/layers.ts` is the single source of truth for the z-index of
every floating layer **in `packages/ui`** — dialogs, popovers, selects, menus,
tooltips, palettes and toasts. Do not hardcode a `z-` utility on one of those;
import the token. `__tests__/floating-layer-tokens.test.ts` enforces it.

One layer outside `packages/ui` still sits outside the scale: `file-explorer-ui`'s
`tapestry/tapestry-lens.tsx` portals a `fixed z-[120]` code-lens preview, chosen
to clear toasts. It does not conflict with anything today, but it is not covered
by the guard, so treat the statement above as scoped to `packages/ui`.

(An earlier `loading-overlay.tsx` sat at `fixed inset-0 z-50` and tied with the
tier-1 dialog scrim. It turned out to have no consumers and was deleted in
BST-965 rather than tokenised.)

The scale, lowest first:

| Layer | Token | Value |
| --- | --- | --- |
| Dialog scrim / panel, by nesting depth | `DIALOG_LAYER_CLASSES[depth - 1]` | `50/51` … `64/65` (8 tiers) |
| Command palette scrim / content | `COMMAND_PALETTE_OVERLAY_CLASS` / `COMMAND_PALETTE_CONTENT_CLASS` | `66` / `67` |
| Popover, select, dropdown menu, context menu, tooltip | `POPUP_LAYER_CLASS` | `70` |
| Toast | `TOAST_LAYER_CLASS` | `100` |

Three invariants hold, asserted in `packages/ui/src/__tests__/layers.test.ts`:

1. **A dialog panel sits strictly above its own scrim.** This is #831's ruling:
   at an equal z-index RemoveScroll's wrapper steals pointer events from the
   panel. Do not collapse the pair onto one value.
2. **A nested dialog's scrim sits above the panel that opened it** — *provided
   the nested dialog is rendered inside that panel's subtree.* `Dialog` tracks
   nesting depth through React context (which crosses portals) and derives its
   tier from it; `dialogLayerClasses` throws rather than clamping past
   `MAX_DIALOG_NESTING_DEPTH`.

   **The depth is lexical, not open-order.** A dialog hoisted to a sibling of
   the one it covers — or owned by a provider above it — resolves to tier 1 and
   its scrim paints under the other panel again, silently reproducing the
   defect. Keep a dialog co-located with the surface it covers. The same
   property means a `<Dialog>` written inside another's JSX consumes a tier even
   while the outer one is closed, which is why the scale reserves eight tiers
   rather than the four this defect needed.
3. **Popups out-rank every dialog tier.** This is the defect that produced the
   scale: Settings became a modal in #1626 while Select/Popover/DropdownMenu/
   ContextMenu/Tooltip were all still on `z-50` and `DialogContent` had moved
   to `z-[51]`, so a Select opened in Settings painted behind an opaque panel.
   (Settings is a nav-rail route again since BST-1668, so that specific
   reproduction no longer exists — the invariant stands for every dialog.)

Two traps worth knowing before you debug this class of bug again:

- **An invisible popup is still hit-testable.** Radix drops `pointer-events` on
  the dialog panel while an inner layer is open, so `elementFromPoint` returns
  the option, Playwright's actionability checks pass, and a click succeeds — on
  a dropdown the user cannot see. Functional assertions do not catch it; assert
  stacking or occlusion. The BST-963 occlusion probe lived in the old
  `settings-modal-layering` spec; it was retired with the Settings modal in
  BST-1668 because a route cannot occlude a popup, so reproduce that shape
  against whichever dialog you are debugging.
- **Values must be literal strings.** Tailwind emits only classes its scanner
  can see, and `packages/ui/styles.css` exposes this package via `@source`. A
  runtime-composed `` z-[${n}] `` produces no CSS at all and silently computes
  to `auto`.

When changing this scale, update this section and `layers.test.ts` together.

---

## FLOATING LAYER ANCHORING

Stacking (above) decides what a popup paints *over*. This section is the other
half: what it is *measured against*.

Radix positions Select/Popover/DropdownMenu/ContextMenu content with Floating
UI, which measures the trigger via `getBoundingClientRect()` and publishes the
result as `--radix-popper-anchor-width` / `--radix-popper-anchor-height` (Select
re-namespaces these to `--radix-select-trigger-*`).

**A transform on a trigger corrupts every popup it opens.** `getBoundingClientRect()`
includes transforms; `ResizeObserver` does not fire for them; and Radix's default
`updatePositionStrategy` is `optimized`, so there is no per-frame re-measure. The
popup therefore stays sized and placed from whatever the trigger looked like at
the instant it opened, for as long as it is open.

That instant is POINTERDOWN — Radix opens on pointerdown, not click, so the
trigger is still `:active`. `packages/ui/src/globals.css` applies
`transform: scale(0.97)` to `.kinetic-depress:active`, and `SelectTrigger`
carries that class. Measured on the 718x40 "Indexing policy" trigger in the
Settings surface at 1440x900: the anchor was published as 696.46 x 38.80 —
718 x 0.97 and 40 x 0.97 exactly — and the listbox rendered 21.5px too narrow
and 11px inside the field's left edge.

Rules:

- The press effect is suppressed while a trigger is an OPEN popup anchor, via
  `:not([data-state="open"])` in that `:active` rule. Do not remove it. Do not
  "fix" a misaligned popup by nudging `sideOffset` or `align` — that hides a
  measurement bug behind a cosmetic constant.
- `data-state` is the whole condition on purpose. Every Radix floating trigger
  sets it, and the repo has no non-Radix floating anchors. Do NOT widen it to
  `[aria-expanded="true"]`: `Button` defaults to `depress`, so that clause kills
  the press affordance on ~14 plain disclosure toggles — tree-row expand
  chevrons, ide-layout's hide-panel buttons (dead outright, since they render
  only while expanded) — and buys nothing for this defect. A non-Radix combobox
  would be scoped as `[role="combobox"][aria-expanded="true"]`.
- Do not add any other transform, `zoom`, or `scale` to an element that anchors
  a floating layer, and do not wrap one in a transformed container.
- A keyboard-opened popup measures correctly even when the defect is present
  (no `:active`), so reproduce and assert with a REAL mouse press.

Guards: `packages/ui/src/__tests__/kinetic-depress-popup-anchors.test.ts` pins
the selector; the geometry assertion in
`apps/web/e2e/settings-popup-anchoring.test.ts` ("bound to its trigger, not to a
scaled phantom") pins the rendered result in a real browser.

### Layer registration is not synchronous

`DismissableLayer` keeps its stack in a module-level `Set` that it mutates in an
EFFECT but reads during RENDER, so a freshly mounted layer paints one frame at
`index === -1`. Radix writes its verdict as an INLINE `pointer-events` style on
each layer node: `none` for a layer that is not (yet) the registered top, `auto`
for one that is, and nothing at all while no layer disables outside pointer
events.

Keyboard dismissal keys off the same stack, so an Escape inside that window is
routed to the layer UNDERNEATH the one just opened — while Settings was a modal
that closed the modal and unmounted the nested surface with it. Measured on the
old `settings-modal-layering` spec: the pre-settle snapshot appeared in 3 of 6
runs and correlated exactly with the failure. The window is ~20ms.

E2E waits on this with `waitForFloatingLayerStack(page, targetSelector)` in
`apps/web/e2e/utils/layout-helpers.ts`. Two rules if you extend it:

- Read the INLINE style, never the computed one. Computed is not a registration
  signal — `model-picker.tsx` hardcodes `pointer-events-auto` on its
  PopoverContent, and a `portal={false}` layer inherits its ancestor dialog's
  value.
- Do not assert a shape across the whole stack ("topmost `auto`, everything
  beneath `none`"). That only holds when every layer is modal. `Popover` is a
  bare `PopoverPrimitive.Root` (Radix default `modal={false}`), so it never
  disables outside pointer events and the dialog beneath it stays `auto`
  forever. Key off the target layer alone.

`SelectContent` defaults to `position="popper"`. Radix's other mode,
`item-aligned`, paints the selected option ON TOP of the trigger and does not
expose `--radix-select-trigger-width` at all, so a listbox cannot be bound to
its field in that mode. shadcn shipped `popper` as its own default until
Dec 2025 and still ships every popper style rule; only the default flipped.
`min-w-(--radix-select-trigger-width)` belongs on the Content (Radix's
documented "constrain the content size" recipe), not on the Viewport — on the
Viewport it sizes the inner box and overhangs the trigger by the content's 2px
border.

---

## TAILWIND SOURCE COVERAGE

Tailwind v4 discovers utilities by scanning source TEXT. A workspace package
whose `.tsx` never enters the scan emits NO CSS for any class only it uses, and
nothing reports it: no missing import, no type error, no console warning. The
classes just resolve to nothing.

Convention: a package that writes Tailwind classes ships a package-local
`styles.css` containing `@source "./src";`, exports it as `./styles.css`, and is
imported — directly, or chained through another package's `styles.css` — from
EVERY app CSS entrypoint that renders it (`apps/web/src/app/globals.css` and
`apps/desktop/src/renderer/styles.css`).

`packages/settings-ui` sat outside that scan with 102 `.tsx` files. Measured on
the running renderer, 103 utilities produced no rule at all — every `sm:`/`md:`/
`lg:`/`xl:` variant in Settings (so panels rendered their narrow branch at every
width), `space-y-5`/`space-y-7`, the `w-[30%]`/`min-w-[800px]`/`h-[600px]`
sizing set, the status color scale, and the provider brand-color custom-property
bridge.

Guard: `scripts/__tests__/tailwind-source-coverage.test.mjs` (runs in
`pnpm test:scripts`, the Static CI job) walks every `packages/*` for `className=`
and fails on any that is unreachable from either entrypoint.

---

## Motion

Motion inside the assistant thread (`.assistant-ui-panel`) is CSS-only — no
animation library, and a deliberately small catalog rather than a bespoke
transition per component. Everything lives in `overrides.css`, scoped under
`.assistant-ui-panel`.

The activity trace (BST-1679, `docs/agents/assistant-runtime.md` § ACTIVITY
GROUPS) is the reference implementation: four `bs-trace-*` primitives, each
reusable rather than one-off:

- `.bs-trace-label` — a keyed span (the caller re-keys the element on its own
  text) that fades/slides in on change; drives both the live and resting
  headline.
- `.bs-trace-collapse` / `.bs-trace-collapse-inner` — `grid-template-rows: 0fr
  ↔ 1fr` disclosure, no measured heights.
- `.bs-trace-reveal` — a one-shot fade-up with a `--bs-stagger` index capped
  at 5, read through `var(--bs-stagger, 0)` because the index is set on an
  ANCESTOR and inherited (never declared on the revealed element itself, which
  would shadow it); phase 3 wires it to `.bs-step-list`'s step rows (below).
- `.bs-trace-detail` — a fixed one-line slot under the header while running,
  so the header's own height never changes (the thread's scroll-anchoring
  rule).

Every animated or transitioned primitive above, plus the thinking-mark
pulse/shimmer they compose with (`.bs-thinking-pulse`, `.bs-thinking-core`,
`.bs-thinking-shimmer`), has a `@media (prefers-reduced-motion: reduce)` block
that turns the animation off and freezes the element at its settled state —
never just a shorter duration. `.bs-trace-detail` is the one exception and
needs none: it is a static fixed-height slot with no animation or transition
of its own.
Where the motion is applied to text via a transparent, gradient-clipped fill
(`.bs-thinking-shimmer`, used for the live label) that also needs a
`@media (forced-colors: active)` fallback: `background-clip: text` plus
`color: transparent` would otherwise render invisible text once Windows High
Contrast strips the gradient, so the fallback swaps to a solid `CanvasText`.
Primitives whose animation is only opacity/transform (`.bs-trace-label`,
`.bs-trace-collapse`, `.bs-trace-reveal`) need no forced-colors override —
they never hide text behind a color trick.

The trace's LIVE status label is the one element that carries a
`.bs-trace-label`/`.bs-trace-label-static` entrance class AND
`.bs-thinking-shimmer` at once (`LiveSummary`, `activity-trace.tsx`); both
rules declare the `animation` shorthand at equal specificity, so the
shimmer — declared later in the stylesheet — silently replaced the entrance
outright and the crossfade never ran (phase-2 defect, found in Task 6
review). Two compound rules,
`.bs-trace-label.bs-thinking-shimmer` /
`.bs-trace-label-static.bs-thinking-shimmer` (`overrides.css`), compose the
two instead of letting one erase the other, listing both keyframes in the
comma-separated `animation` list; each single-class shorthand is repeated
verbatim rather than merged (a shorthand cannot inherit a peer's value), so a
change to either must be mirrored in the compound rule, and the
`prefers-reduced-motion` reset lists both compound selectors explicitly
alongside the one-class primitives, since the three-class specificity would
otherwise survive the generic reset.

### Step rows

L1 step rows (`docs/agents/assistant-runtime.md` § ACTIVITY GROUPS, "L1 step
rows / L2 bodies") are the shared `StepRowHeader` grammar
(`activity-step-row.tsx`) every card inside an activity trace renders through
— `ToolFallback`, `SubagentExecutionCard`, `TaskListToolCard`, and the
reasoning block: family icon · verb in tense (the active form while the step
is `running` OR `waiting` — a gated call has not run yet) · target chip (the
tool id when the args name no primary arg) · timing (rendered only when the
caller supplies one) · state glyph · chevron, one row per step in part order.
A row with a body is a real `<button>`; a row with none is a non-interactive
`role="group"` — never a disabled button standing in for "nothing to expand".
That includes a `TaskListToolCard` with neither raw args nor a raw result: the
`bodyId`/`expanded`/`onToggle` trio travels together, exactly as in
`ToolFallback`.

Either form is named by what it SHOWS (BST-1682, WCAG 2.5.3 Label in Name).
The `role="group"` form is `aria-labelledby` its content span; the button form
composes `aria-label` as visible content first, affordance last —
`Read src/app.ts, expand details` — and drops `aria-describedby`, since
content already in the name must not be described a second time. `label` is
the affordance clause, not the whole name, and `nameFromContent` (default
`true`) is the opt-out for a row whose `label` already names the step: only
the reasoning row takes it, keeping `Show thinking` / `Hide thinking` exactly.
The raw tool id is never pulled into a name from the sr-only span — it reaches
a name only where the caller already put it in the visible `target` chip. Any
test or e2e spec asserting the affordance must match it as a substring
(`{ name: /expand details/i }`), never as the full name.

Geometry is stylesheet-owned, not utility classes, because the browser
vitest lane loads no Tailwind preflight (`overrides.css`): `.bs-step-row`
itself owns `box-sizing: border-box`, `width: 100%` and `flex: 1 1 0%`; a
sibling control sharing `.bs-step-row-line` with it (the checkpoint revert
button) gets `flex: 0 0 auto` from `.bs-step-row-line > :not(.bs-step-row)`;
`.bs-step-row-chevron` pins the chevron's own box; `.bs-step-row-meta` clamps
to `9rem` so an unbounded result-summary or root-name chip cannot push the
row wide. `.bs-step-row-timing` is the one slot that SHRINKS
(`flex: 0 1 auto`) under a `max-inline-size: 60%` ceiling, with
`overflow: hidden` + `white-space: nowrap`: the running progress label is
unbounded at the call site, and those are two separate guards — shrinking
bounds the slot only while something else competes for the row, the ceiling
is what keeps a short target legible when nothing does.
`.bs-step-list` is a BLOCK container by design — the row's own
width rule is written for a non-flex parent — so inter-row rhythm comes from
`.bs-step-list > * + *` block margins rather than a flex `gap` (adjoining
block margins collapse, which is why the value is `0.75rem` and not the
arithmetic top-up of the layout it replaced). The one exception is
`.bs-run-timeline`: at Developer detail level, run-event rows render as
direct children of `.bs-step-list` too (they are group-transparent), so they
CONSUME `:nth-child` slots and shift the `--bs-stagger` of every step row
after them one step along — but they carry no `.bs-trace-reveal` and do not
animate. The step rows themselves are never the list's direct children
either: `--bs-stagger` lands on `ActivityPartLayout`'s wrapper (two more
levels down for `ToolFallback`) and reaches the row by INHERITANCE. Run-event
rows keep their own tighter `0.25rem` margin
(`.bs-step-list > * + .bs-run-timeline`) rather than the step rows' rhythm,
since they are designed to read as one quiet block. `sr-only` is a Tailwind
utility with no matching rule in that same lane (it loads only
`@brainstrike/ui/globals.css` and `overrides.css`), so the row's hidden
tool-id span does NOT hide there — a browser test asserting on the row must
account for that visible text, or omit `toolName`
(`activity-step-row.browser.test.tsx`).

State glyphs follow one naming rule: `role="img"` plus `aria-label` from the
total `STEP_STATE_LABELS` map (`activity-step-tokens.ts`) — colour alone
never carries the state.

---

## Delegated conversation navigation (BST-1724 / BST-1725)

- Navigation slice: child cards/tab titles use durable callsigns, with persona role kept separate.
- Breadcrumbs follow validated native owner/root/parent bindings; returning focuses the originating delegation button while mounted, otherwise the canonical destination tab.
- Root thread filters/sort and folders choose the visible roots; child rows remain beneath those roots in durable creation order, never independently selected/reparented by root bulk actions.
- Search includes owned descendants, with one keyboard-selectable option per matched message. Activation revalidates native ancestry and message ownership, activates the owning root through the saved-workspace coordinator, then opens the singleton child tab. Child titles use the durable callsign.
- An older child search match explicitly pages native history backwards in 80-row pages; default hydration stays at 80. The shared transcript focuses the rendered message containing the exact native hit, including coalesced assistant snapshots. Search never appends a message or restarts work.
- Child disclosure is lazy in the shared virtual TreeTable, fifty children initially with explicit Show more.
- Closing a disclosure releases its descendant subscriptions and reopening revalidates metadata.
- Listing rows never mounts child transcripts; only explicitly activated workspace tabs do, using the existing keep-alive/close semantics.
- Read receipts belong to the ephemeral root store, so virtual row unmount does not invent unread activity.
- Reload derives pending decisions from the existing authoritative discovery path; opening/closing/reopening never starts a model.
- Expanded sidebar parents use that same discovery result, validated against each native invocation, to restore Needs input after renderer restart without mounting transcripts. Each expanded parent makes one discovery request, and unavailable or conflicting discovery renders an explicit list error. Current live child status takes precedence over the saved attention snapshot.
- Closing a child tab is reversible and reauthorizes before reading history on reopen. Native thread deletion permanently removes the selected subtree and saved conversation data. Neither root nor child threads currently offer an archive operation.
- Free-form steering remains BST-1723 acceptance, not claimed by this slice.

Paired acceptance: `delegated-workspace-reload.desktop.test.ts`, `delegated-worker-write.desktop.test.ts`, `delegated-sidebar-lifecycle.test.tsx`, `delegated-sidebar-rows.test.ts`, `delegated-conversation-ancestry.test.ts`, and `delegated-conversation-store.test.ts`.
