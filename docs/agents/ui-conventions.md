# UI Conventions: TreeGrid Contract, Context Action System

> Extracted from AGENTS.md (2026-07-12). Read before adding tree views or right-click menus. Keep updated with the code.

## TREEGRID CONVERGENCE CONTRACT

File-tree and context preview tree behavior is converging on shared TreeTable primitives.

Rules:
- Use `packages/ui/src/tree-table/*` as the canonical treegrid implementation.
- Prefer adapting feature surfaces to TreeTable API over duplicating tree render logic in app/package code.
- Keep UX parity between:
  - File explorer tree (left nav).
  - Context explorer grouped preview tree (main panel).
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
- Forest-mode scale contracts (PR #1734 audit; pinned by
  `forest-tree-actions-context.test.tsx`, `forest-section-filtering.test.tsx`,
  and the `filteredPathSet`-skip tests in
  `optimized-file-tree-filtered-selection.test.tsx`):
  - The forest registry (`forest-tree-actions-context.tsx`) is split: the
    actions value is identity-stable for the provider's lifetime, and the
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
  - Expand All / Collapse All render in the `FloatingTreeActions` overlay
    pinned to the tree area's top-right (`file-explorer-panel.tsx`), keeping
    their historical `*-button-small` testids; the toolbar cluster hosts only
    Refresh + the inline scanning indicator. Overlays over the tree must
    never shift tree rows (same contract as `RestorationStatus`).
  - Each forest section computes ONE shared display derivation
    (`RootSectionInner`): view filters + quick filter + visible-file counts
    feed both the header select-all checkbox and the tree pane. The INPUT
    tree is deferred (`useDeferredValue`) BEFORE the filter passes; the
    canonical `treeContext.fileTree` stays immediate for loading/selection.
  - `OptimizedFileTree` accepts `isDisplayTreeFiltered`; `false` skips the
    O(N) filtered-path-set walk on the normalized path (null set = no
    restriction). Callers that cannot tell omit it (conservative build).
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
- Expansion state is one workspace-global set across all forest roots. Each
  tree section selects it THROUGH `scopeExpandedPathsToRoot` (settled
  root-scoping semantics shared with persisted-expansion restoration, see
  `root-scoped-paths.ts`) with content equality, so an expand/collapse in one
  root rebuilds only that root's rows
  (`optimized-file-tree-forest-invalidation.test.tsx`). Relative-path (web
  FSA) roots still cross-match by design — the accepted phase-4 limitation.
- The store's `setExpandedPaths` ADOPTS the caller's set (no defensive clone);
  every caller hands over a freshly built set and must not mutate it after.
- Any new tree interaction (selection, sort, collapse, keyboard behavior) must include tests in both shared UI package and consuming feature package when behavior diverges.
- Consumers with per-row hidden checkboxes may set `reserveCheckboxSpace` on the tree column so empty/group rows stay aligned with selectable rows without rendering a misleading disabled checkbox. Checkbox-only multi-select surfaces set `selectOnRowClick={false}` so row chrome moves focus without mutating selection.
- Keyboard events from interactive cell descendants (buttons, links, form
  controls, and equivalent ARIA widgets) remain owned by that descendant.
  TreeTable must not reinterpret their Space/Enter activation as row selection
  or checkbox input.
- Tree rows whose content can expand below their primary line must set the tree
  column's `treeControlsPosition` to `top`. This keeps disclosure and checkbox
  controls pinned to the first 40px row line instead of recentering when details
  appear below it.
- Ephemeral selection actions float at the bottom through
  `SelectionActionBarOverlay` + `SelectionActionBar`. Keep the scroll owner
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

When modifying TreeTable strategy or pagination behavior:
- Update the related collection browser/file explorer/context preview adapters.
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
legacy pattern; it was removed from the collection browser).

Layers:
- Headless core: packages/context-actions — ContextTarget union, ContextAction,
  createActionRegistry, ClipboardService, path helpers. No React rendering, no
  Electron imports.
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
- Targets are immutable invocation snapshots, not live DOM/store lookups. Claim
  them synchronously during the `contextmenu` event. File viewer targets preserve
  exact text (including whitespace) plus the CodeMirror `{from,to}` range from
  the same event; Markdown selection must be bounded to its preview root. A
  durable file `RootId` is identity, commonly a UUID — resolve its descriptor
  path before building relative/absolute paths and never treat the id as a path.
- Context triggers must stop before native editable/selection surfaces. Thread
  row menus wrap only the non-editing display (rename inputs keep the native
  edit menu), thread-tab menus wrap only the tab lane (assistant message content
  keeps its native selection menu), and pinned workspace app tabs are not file
  targets.
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

When changing this flow, update this section and the related tests.

---
