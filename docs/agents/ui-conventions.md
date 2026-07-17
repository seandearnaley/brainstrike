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

Windowing and performance:
- Default strategy should remain `auto` unless a product requirement explicitly pins behavior.
- For search-heavy and large result flows, paged windowing is acceptable when it produces more stable UX than virtual scrolling.
- Avoid full-tree rematerialization during render paths; keep derived rows memoized and keyed by stable node ids.
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
  restore that can monopolize the renderer.
- Row render stability is a pinned contract (`tree-table-render-stability.test.tsx`):
  row-facing handlers are identity-stable (`useEventCallback`), the keyboard
  `actions` object and the virtualizer measure adapter are memoized, and the
  flatten pass reuses value-equal row objects (`reuseEqualFlattenedRows`) so a
  selection/highlight/focus change re-renders only affected rows. Do not pass
  per-render object/function identities into `TreeTableRow` — the row memo is
  the scroll/keyboard hot path for every tree surface.
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
