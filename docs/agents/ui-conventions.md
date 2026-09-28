# UI Conventions: TreeGrid Contract, Context Action System

> Read before adding a tree view, a right-click menu, or a floating layer. Rules
> here are true now; the record behind each is in `ui-conventions/<topic>.md`.

## TREEGRID CONVERGENCE CONTRACT

- Build tree surfaces on `packages/ui/src/tree-table/*` rather than duplicating
  render logic; the Explorer file tree is the reference treegrid.
- Preserve WAI-ARIA treegrid semantics: `role="treegrid"`, row/level metadata,
  keyboard traversal. A forest section is `aria-label="File tree: <root>"`;
  single-root is `"File tree"`.
- Keep roving row focus and selection independent: `data-focused`/`tabIndex` own
  keyboard ownership, the affordance paints from `:focus-visible` or TreeTable's
  keyboard-modality state, a pointer-focused row gets no persistent ring, and
  focus tokens stay neutral.
- Pickers in popovers follow the `useCollections` single-owner ruling in
  `database.md`.
- A new tree interaction ships tests in the shared UI package and in the
  consuming feature package when behaviour diverges; changing TreeTable strategy
  or pagination updates the file-explorer and workspace-search adapters plus
  their grouped-slicing/selection tests.

Settled: the collection browser and the Context explorer's grouped preview table
are retired; the context preview's only surface is the Tapestry gallery.
Evidence: `ui-conventions/retired-tree-adapters.md`.

### Scroll ownership

- `TreeTableViewport` is the sole two-axis scroll owner and the virtualizer's
  scroll element; the semantic table and sticky header live inside it. Consumer
  wrappers stay layout-only (`overflow-hidden`).
- When MULTIPLE TreeTables stack in one scrolling column, that column is the
  scroll owner: each table passes it as `scrollParentRef`, its viewport becomes a
  non-scrolling spacer, and the virtualizer windows through `scrollMargin`. A
  per-table scrollbar inside a scrolling column freezes the virtual window.
- The Model Catalog (`settings-ui/src/settings/models/model-catalog.tsx`) is the
  second shared-scroller consumer: one TreeTable per expanded section, ONE
  presentational column header above the scroller (Explorer forest shape), and
  in-flow `sticky top-0` headers (`STICKY_SECTION_HEADER_LAYER_CLASS`) whose
  height each table passes as `scrollPaddingStart` so a focused row clears it.
  Row pitch is pinned by `apps/web/e2e/settings-models-and-providers.test.ts`.

Settled: shared-scroller mode is the one sanctioned exception. Evidence:
`ui-conventions/shared-scroller-mode.md`.
Guard: `tree-table-shared-scroller.test.tsx`, `apps/web/e2e/forest-expand-all.test.ts`.

### Windowing and expansion

- Keep the default strategy `auto` unless a product requirement pins behaviour;
  paged windowing is acceptable where it is more stable than virtual scrolling.
- Memoize derived rows keyed by stable node ids; never rematerialize a full tree
  during render.
- The renderer-fallback expand-all session buffers directory results — loaded
  children and load errors — publishing once per traversal batch through
  `onBatchLoadsSettled`, plus on cancellation and session end. Arm batching ONLY
  for the renderer session; the worker fast path keeps per-directory commits, or
  a session-end flush clobbers worker-loaded deep subtrees.
- Scope persisted expansion restoration to the active root before any worker I/O
  via `scopeExpandedPathsToRoot` (`utils/root-scoped-paths.ts`), capped at
  `MAX_AUTOMATIC_RESTORED_DIRECTORY_PATHS` per root, shallowest-first with
  selected/query parents prioritized. Surface the excess in the restoration
  progress card and a toast — never attempt an unbounded restore. Post-
  restoration selection changes use the same scoping, ordering and cap.
- Expansion state is one workspace-global set, selected through that same scoping
  with content equality, so an expand/collapse in one root rebuilds only that
  root's rows. `setExpandedPaths` ADOPTS the caller's set: hand over a fresh set
  and do not mutate it afterwards.

Settled: relative-path (web FSA) roots still cross-match — accepted phase-4
limitation; a drive-relative sentinel such as `C:` is not a filesystem root and
never consumes the cap. Evidence: `ui-conventions/expand-all-batching.md`,
`ui-conventions/persisted-expansion-restoration.md`.
Guard: `use-lazy-file-tree-expand-all-batching.test.ts`,
`use-lazy-file-tree-expand-all-worker-interplay.test.ts`,
`direct-directory-traversal.test.ts`,
`optimized-file-tree-forest-invalidation.test.tsx`.

### Query-selection snapshots

- Share one in-flight snapshot read per database handle and snapshot id. Promote
  the manifest to `loading` only after 100ms and fail a read after 30 seconds;
  the timeout starts only once a database handle exists.
- Revalidate the canonical manifest fingerprint plus snapshot id on every
  loading, ready and error publication.
- Resolve the descriptor plus manifest for effective counts and paths — forest
  budgeting and folder-state snapshots included — never raw `manifest.filePaths`.
- Keep a terminal read error visible until the descriptor or database lifecycle
  changes; never retry or coerce a failed snapshot.
- Keep the derived ancestor-count tier in `utils/selection-projection.ts` bounded
  and verify exact Set membership before reuse. It never becomes a canonical
  selection source, never replaces `selectionModel.materializedPaths`, and only
  the final live consumer release clears strong entries.

Settled: descriptor changes and unmounts cancel timers and publication only —
`DbHandle.query` has no abort contract. Evidence:
`ui-conventions/query-selection-snapshots.md`.

### Forest-mode scale contracts

- Keep observable state OFF the forest actions value: it stays identity-stable
  for the provider's lifetime, and expand-all progress is an external store read
  only through `useForestExpandAllProgress`, published at most once per frame.
- Register sections in `RootSectionInner`, ABOVE the collapse branch — never in
  `PerRootTreePane`, whose unmount made Expand All / Select All skip collapsed
  roots. Each registration exposes `setCollapsed`.
- Render Expand All / Collapse All in the toolbar's LEFT track
  (`components/tree-expansion-buttons.tsx`), keeping the `*-button-small`
  testids. Add no tree-area overlay for them; the one remaining tree overlay,
  `RestorationStatus`, is `pointer-events-none` and never shifts rows.
- Compute ONE shared display derivation per section (view filters + quick filter
  + visible-file counts) feeding both the header checkbox and the tree pane.
  Defer the INPUT tree (`useDeferredValue`) before the filter passes; keep
  `treeContext.fileTree` immediate for loading and selection.

Evidence: `ui-conventions/forest-scale-contracts.md`.
Guard: `forest-tree-actions-context.test.tsx`, `forest-section-filtering.test.tsx`,
`forest-section-collapse.test.tsx`, `optimized-file-tree-filtered-selection.test.tsx`.

### Row height and painted geometry

- A **function or per-type record** `rowHeight` is a first-paint estimate: rows
  are measured, and a wrong value costs only scrollbar accuracy. A **number**
  disables measurement, so spacer math, `getTotalSize()` and every reveal offset
  derive from it unreconciled — a numeric `rowHeight` must equal the MEASURED
  pitch, never a design target.
- Measure a pitch as the delta between consecutive row tops; one row's
  `getBoundingClientRect().height` under-reports by half the collapsed border.
- A sticky `<thead>` is IN FLOW inside its scrollport, offsetting PAINTED
  coordinates while the virtualizer models tbody rows alone. Subtract the header
  height when comparing paint to model. Do not add a header-sized `scrollMargin`
  and do not take the header out of flow: a start-aligned `scrollToIndex` already
  cancels the offset. `scrollMargin` is non-zero ONLY in shared-scroller mode.

Settled: `OptimizedFileTree`'s `ROW_HEIGHT` is 29. Evidence:
`ui-conventions/row-height-pitch.md`.
Guard: "paints tree rows at exactly the pitch its virtualizer models" plus the
reveal assertions in `apps/web/e2e/file-explorer.test.ts` — jsdom has no layout,
so no unit test catches this drift.

### Explorer tree GRID

Columns are defined once in `tree/file-tree-columns.tsx`, sized from
`app-state/stores/explorer-column-sizes-store` and shown from
`explorer-column-visibility-store`. `name` is the tree column: pinned, no width,
never hideable.

- Metadata cells subscribe PER COMPOSITE KEY (`useSyncExternalStore`): a token
  arrival repaints one cell, never a row rebuild and never a sibling row.
- The PANEL owns the metadata store and reads tree-shaped sources through
  `indexing/file-row-metadata-source-registry.ts`; each rendered tree registers
  the enumeration AND the visible file keys for ITS root, since deriving either
  from the panel's own tree covers the focused root only. A directory the
  registry cannot enumerate answers with an explicit incomplete subtree.
- Keep non-values explicit and distinct: `pending` is a placeholder, never `0`;
  `excluded` is an em dash with the binary tooltip; a PARTIAL rollup renders no
  number; an unbuildable composite key is an ERROR, not pending. The registry
  logs a malformed key once per key and stays quiet for an unregistered root.
- Folder rollups refuse subtrees above `DIRECTORY_ROLLUP_MAX_FILES`, reported as
  unavailable / "not fully enumerated". Resolve a rollup's first read off the
  paint path, tagged `recomputing`, invalidating just those keys — never inline,
  and never with in-progress copy on a capped, unloaded or failed state.
- Clamp widths to the panel at render time (`resolveExplorerColumnWidths`):
  proportional shrink, never below `minWidth`, always 120px reserved for Name.
  The clamp is a projection, never a mutation — the store keeps the user's width
  — so forward resizes per CHANGED column (`setColumn`).
- Header shape follows the scroll owner: single-root passes `showColumnHeader`
  and uses TreeTable's sticky header; FOREST mode renders ONE panel-level header
  (`shell/explorer-column-header.tsx`) above the shared scroller, keeps section
  tables headerless, and aligns by construction (same `table-fixed` +
  `<colgroup>`, same width store, minus the measured scrollbar gutter).
- Below 300px of panel width suppress every metadata COLUMN but still render the
  header in BOTH layouts — it carries the Name sort affordance and its
  `aria-sort` — never gating it on the visible-column count. That threshold is
  the width at which the toolbar hosts the Columns control
  (`docs/agents/explorer-search-tapestry.md`); keep them in step.
- The panel-level header is `role="presentation"` with `aria-hidden` STATIC
  labels, since one header cannot be ARIA-associated with N sibling treegrids and
  each metadata cell self-describes via sr-only text. Keep sort buttons and
  resize handles in the accessibility tree; sort state reaches AT through each
  sort button's `aria-label`. TreeTable's header cells carry `scope="col"`.

Settled: `aria-sort` on those presentational `th`s is inert and stays for markup
parity with TreeTable's real `columnheader`. Evidence:
`ui-conventions/explorer-tree-grid.md`.
Guard: `explorer-tree-grid.test.tsx`, `explorer-forest-visible-indexing.test.tsx`,
`explorer-column-header.test.tsx`, `explorer-directory-rollup-cost.test.ts`.

### Per-directory sorting

- Sorting is CALLER-owned: TreeTable renders the sortable header, `aria-sort` and
  the `onSortChange` cycle but NEVER reorders nodes. The Explorer caller sorts
  siblings within EACH parent before passing pre-flattened rows, so descendants
  never cross parent boundaries. Directories-first is invariant for every field
  and direction, equal keys fall back to locale-aware name order, and the
  persisted panel-global `null` keeps the loader's default.
- `pending`, `excluded` and partial/unknown rollups are ABSENT from an ordering —
  never zero — and sort after every resolved number in BOTH directions.
- Read the seam ONCE PER ROW (Schwartzian, in `sortRowsPerDirectory`), never per
  comparison, and take row-level reads through the non-caching `peekSnapshot`.
  Directory rollups DO stay cached.
- Key the seam's rollup reconciliation off
  `FileTreeRowReuseCache.getStructureRevision()`, never off the rows ARRAY
  identity, which oscillates the order once per macrotask forever. Point the
  deferred rollup flush at `invalidateDirectories`, not `invalidate`.
- Metadata sorts are CAPABILITY-GATED: a surface without the seam offers no
  Type/Tokens/Size affordance, and a persisted one arriving there resets to the
  default order with a warn. Name never needs the seam.

Settled: a structural change costs TWO full projection rebuild+sorts, the floor
today. Evidence: `ui-conventions/explorer-sort.md`.
Guard: `explorer-sort-rebuild-loop.test.tsx`,
`explorer-sort-structural-cost.integration.test.tsx`,
`optimized-file-tree-sort-performance.test.ts`.

### Row identity and render stability

- Row-facing handlers are identity-stable (`useEventCallback`); the keyboard
  `actions` object and the measure adapter are memoized; the flatten pass reuses
  value-equal rows (`reuseEqualFlattenedRows`). Never pass a per-render object or
  function identity into `TreeTableRow`.
- Flatten-level reuse requires `a.node === b.node`, so ADAPTERS feed TreeTable
  identity-stable `TreeNode` objects. `OptimizedFileTree` projects through
  `materializeNormalizedNodeStable` and builds rows through
  `reuseEqualFileTreeRows`; do not reintroduce per-build `{ ...node }` spreads.
- Explicit file-tree selection prepares its composite lookup keys once per node
  identity, on a WeakMap holding at most one projection per live node; callers
  pass the stable source/materialized identity. Never cache checkbox membership
  in the alias projection or change the path candidates used by deselection —
  each read rechecks the current selection Set.

Evidence: `ui-conventions/row-identity-and-reuse.md`.
Guard: `tree-table-render-stability.test.tsx`,
`optimized-file-tree-row-reuse.test.ts`, `optimized-file-tree-selection-store.test.ts`.

### Row chrome and selection surfaces

- Keyboard events from interactive cell descendants (buttons, links, form
  controls, equivalent ARIA widgets) stay owned by that descendant; TreeTable
  does not reinterpret their Space/Enter as row selection or checkbox input.
- Set `reserveCheckboxSpace` where checkboxes are per-row hidden, so empty/group
  rows align without a misleading disabled checkbox; checkbox-only multi-select
  surfaces set `selectOnRowClick={false}`; rows whose content can expand below
  their primary line set `treeControlsPosition: 'top'`.
- Float ephemeral selection actions through `SelectionActionBarOverlay` +
  `SelectionActionBar`; `BulkActionBar` (`packages/ui/src/bulk-action-bar/`) is
  the shared, surface-neutral node-kind-aware wrapper. Pad the scroll owner at
  the bottom while the overlay is present — never put the toolbar in normal flow
  or compensate with top padding, because selection must not shift the tree. Its
  positioned ancestor owns the full panel height, and a compact toolbar receives
  an explicit available width; an intrinsic one loops on container queries.
- A colored tree group may use one continuous, softly tinted surface across its
  header and disclosed rows, covering the full row including the disclosure and
  checkbox gutter, with thread identity independently colorable inside it.
  Compute its start/end from the visible row model, so collapsed, empty and
  disclosure-limited groups still close their rounded boundary.
- Thread surfaces share `assistant-thread-presentation.ts` density and colors:
  three six-color palettes span thread, group and bulk pickers. Tabs and rows
  use `idleClassName`/`selectedClassName` fills; `markClassName` must differ from
  the fill. Use `getAssistantThreadColorSurface` for unassigned colors, never
  re-declare density at call sites. Child rows, tabs and headers share their tint;
  conversation backdrops, composers and activity inherit it; delegation cards
  use child color. Keep callsign text and status beside every color cue.
- The threads tree cell renders one `ThreadRow` (`thread-row.tsx`), never a
  single-element `ThreadRows` list: the row owns rename draft, customization,
  details, delete confirmation and pending/error state, while the connected panel
  supplies only projected facts and persistence actions.

Evidence: `ui-conventions/thread-row-presentation.md`.
Guard: `thread-row.test.tsx`.

---

## TERMINAL SURFACES

- The desktop Terminal page owns two capability-gated surfaces: the user's
  interactive shell (`window.terminal`) and assistant-owned persistent command
  sessions (`window.commandSessions`). Keep the shell mounted while switching
  surfaces. Web omits both bridges — no stubs, no `isElectron()` branches.
- The command-session inventory is workspace scoped: show status, pid, opaque id,
  root id, exit code, bounded output, and explicit gap/omission state. Stop,
  remove, refresh and input are direct user actions.
- Never infer or display a command from process metadata, and never log or
  persist command, cwd, environment or output. The main-process manager stays the
  single source of truth across renderer reloads.

Evidence: `ui-conventions/terminal-surfaces.md`.

## TAB STRIPS

Every document strip (assistant threads, the workspace, the browser pane) renders
`TabStrip` from `packages/ui/src/tab-strip`; fixed view switchers use `Tabs`; never hand-roll one.

- The primitives are presentational: consumers pass `items`/`pinnedItems`, intents
  (`onActivate`, `onClose`, `onReorder`) and a `contextMenu` descriptor; the strip owns
  roving focus, overflow, DnD and menu claiming, never reads a store or decides what
  closing means. A native-view host occludes via `onMenuOpenChange` while any menu is open.
- Geometry comes from `tab-strip-tokens.ts`; label weight never changes with state and
  the close slot is always reserved. The neutral selected state is the segmented
  control's raised surface; identity tabs pass `appearance` tints.
- Keyboard is APG with MANUAL activation: arrows/Home/End move focus, Enter/Space
  activate. Delete focuses the next tab, else the previous, the first trailing control,
  the tablist. ⌥⇧←/→ moves a `reorderable` scroll tab, announced. Shift+F10 (keydown)
  and ContextMenu (keyup) open the tab menu at the tab; middle-click closes.
- The close ✕ is a mouse-only sibling (`aria-hidden`, `tabIndex=-1`): the tablist owns
  only tabs, which axe `aria-required-children` checks. A pointer close moves focus only
  when it was lost: to the new selected tab, else Delete's fallbacks.
- Menus: tab menus come from `createTabStripActions` (`@brainstrike/context-actions`)
  plus the global actions for that target kind; the empty strip background claims a
  `tab-strip` target; `closeAll` receives the invoking id. Focus returns to the origin.
- Overflow has no chevrons: a NATIVE non-passive listener maps vertical wheel to horizontal
  (trackpad x stays native); edge fades, a keyboard-only `scroll-px-8` reveal, All-tabs menu.
- Wrap each tab panel in `TabPanelBoundary` (the strip wraps itself). Never hide a panel
  whose effects own still-running work with `<Activity>` (spec §7.1). A failed lazy chunk
  (`isChunkLoadError`: `vite:preloadError` payload identity, never message text) shows
  "Reload app", never "Reload tab" (`React.lazy` caches the rejection); never `preventDefault` it.
- Chords go through ONE router, `app-shell/src/tab-chords`: the strip whose registered
  panel holds focus, else the workspace; ⌘W with no active tab falls through. ⌘/Ctrl+W,
  ⌘/Ctrl+⇧T and positional Ctrl+Tab need the desktop `desktopLifecycle` bridge.
- Every close path feeds its strip's bounded, session-only history (no factory-reset wiring).
  ⌘K and the strip menu offer Reopen only with an entry; ⌘⇧T on empty informs, stale reports.

Settled: BST-1836 decisions D1–D9 (2026-09-27). Evidence: `ui-conventions/tab-strips.md`.
Guard: `packages/ui/src/tab-strip/__tests__/tab-strip.test.tsx`, `tab-strip.browser.test.tsx`
(painted geometry, axe, keyboard menu, native drag), `tab-panel-boundary-chunk-load.test.tsx`,
`packages/ui/src/chunk-load/__tests__/`, context-actions `tab-strip-actions.test.ts`, app-shell
`tab-chords/__tests__/`, `apps/desktop/e2e/tab-chords.desktop.test.ts`.

---

## CONTEXT ACTION SYSTEM

Right-click menus are projections of a shared action system; do not hand-roll a
per-surface context menu. Layers: headless core in `packages/context-actions`
(with the ⌘K command registry and the one-way `bridgeActionToCommand` projection
under its `/commands` subpath); renderer wrappers in `packages/ui/src/context-menu`;
composition in `packages/app-shell/src/context-action-registry.ts`; desktop
bridges through `window.platform` / `window.clipboard` to the `shell` and
`clipboard` IPC domains.

- Gate by capability: a missing capability HIDES the action — no disabled
  "available on desktop" items, no `isElectron()` checks in action or menu code.
  Gate path-shaped actions with `isVisible` by DATA, not platform: a browser FSA
  root's `path` is `null`.
- Import feature actions via subpath exports to preserve code-splitting; never
  import a feature-package root barrel from always-mounted code.
- Every run resolves to an `ActionOutcome`; a failure toasts and logs through
  `createLogger('ContextActions')`, and a thrown or rejected run surfaces as
  "Action failed unexpectedly". A present-but-broken bridge reports failure
  rather than degrading quietly.
- Action ids are globally unique per invocation: registry construction rejects
  duplicate global ids, and `actionsFor` rejects global/local collisions.
- Add an action with `defineContextAction` in the owning feature package, export
  it from that package's action array, and cover run and gating in unit tests.
- Add a surface by adding a target kind to `ContextTarget`, writing a node→target
  adapter, claiming the target in the row `contextmenu` handler via
  `controller.setTarget`, resetting it with `onContextMenuCapture` on the
  container, and wrapping with `ActionContextMenu`. Surface-local actions go
  through the `localActions` prop.
- A target kind with more than one trigger surface shares ONE
  claim/reset/local-actions hook, not per-surface copies:
  `packages/file-explorer-ui/src/shell/use-root-section-context-menu.ts` is the
  reference (`workspace-root`; see `docs/agents/workspace-context.md`'s
  "Root-header context menu"). Wrap ONLY the header row and keep the tree pane's
  own `ActionContextMenu` as a SIBLING — nesting two Radix context menus lets the
  outer one open against the inner one's target. A host package the surface
  cannot import contributes actions through an injected prop
  (`FileExplorerPanel`'s `rootActions`, `selectionActions`).
- Tree-backed surfaces make the right-clicked row the TreeTable focus owner and
  pass `onCloseAutoFocus` to `ActionContextMenu`, restoring the live origin row
  while mounted and otherwise a deterministic treegrid fallback — never `body`.
- Targets are immutable invocation snapshots claimed synchronously during the
  `contextmenu` event, not live DOM or store lookups. File viewer targets
  preserve exact text (whitespace included) plus the CodeMirror `{from,to}` range
  from the same event; Markdown selection is bounded to its preview root. A
  durable file `RootId` is identity, commonly a UUID — resolve its descriptor
  path before building paths, and never treat the id as a path.
- Stop context triggers before native editable/selection surfaces: thread row
  menus wrap only the non-editing display, thread-tab menus only the tab lane.
  Workspace app tabs have a context menu (`workspace-app-tab`: Close / Close Others /
  Close All within their placement group), superseded 2026-09-27 per BST-1836 D4.
- Multi-tab actions execute atomically in the owning Zustand store: preserve a
  selected pinned app while mutating background file tabs, update assistant bulk
  closes across open/active/selected maps together, never mutate durable thread
  history or per-thread draft runtime, and revalidate targets at execution.
- Stage destructive thread actions: row `Delete…` enters the inline confirmation
  flow and never deletes durable history from a menu run.
- `shortcut` is semantic presentation metadata (`primary` maps to Cmd/Ctrl), not
  keyboard ownership. `registry.descriptorsFor(...)` is the serializable boundary
  for a future native context-menu adapter: main may receive descriptors and
  return a chosen action id, but target and executor stay renderer-owned. Never
  serialize action functions or React icons over IPC; a persistent Electron
  application/File menu additionally needs explicit focused-target ownership.
- Add a capability by extending `CapabilityKey` and constructing it in
  `createAppActionRegistry` only when the backing bridge is fully formed; a
  malformed bridge logs an error and stays absent.

Settled: the clipboard write runs in MAIN and must not call Electron's clipboard
module from the sandboxed preload; Radix touch/pen long-press (~700ms) bypasses
the claiming protocol, an accepted desktop-first tradeoff documented in
`action-context-menu.tsx`. Evidence: `ui-conventions/context-action-layers.md`,
`ui-conventions/shared-target-kind-wiring.md`.

When changing this flow, update this section and the related tests.

---

## FLOATING LAYER STACKING

`packages/ui/src/layers.ts` is the single source of truth for the z-index of
every floating layer **in `packages/ui`**. Import the token; do not hardcode a
`z-` utility. The scale, lowest first:

| Layer | Token | Value |
| --- | --- | --- |
| In-flow sticky section header (inside one scroller; not floating) | `STICKY_SECTION_HEADER_LAYER_CLASS` | `10` |
| Dialog scrim / panel, by nesting depth | `DIALOG_LAYER_CLASSES[depth - 1]` | `50/51` … `64/65` (8 tiers) |
| Command palette scrim / content | `COMMAND_PALETTE_OVERLAY_CLASS` / `COMMAND_PALETTE_CONTENT_CLASS` | `66` / `67` |
| Popover, select, dropdown menu, context menu, tooltip | `POPUP_LAYER_CLASS` | `70` |
| Toast | `TOAST_LAYER_CLASS` | `100` |

Three invariants hold:

1. **A dialog panel sits strictly above its own scrim.** Do not collapse the pair
   onto one value: at an equal z-index RemoveScroll's wrapper steals pointer
   events from the panel.
2. **A nested dialog's scrim sits above the panel that opened it** — provided it
   renders inside that panel's subtree. `Dialog` tracks nesting depth through
   React context (which crosses portals); `dialogLayerClasses` throws rather than
   clamping past `MAX_DIALOG_NESTING_DEPTH`. **The depth is LEXICAL, not
   open-order**: keep a dialog co-located with the surface it covers, since one
   hoisted to a sibling resolves to tier 1 and its scrim paints under again.
3. **Popups out-rank every dialog tier**, because a dialog can host one.

- Write values as literal strings. Tailwind emits only classes its scanner sees
  (`packages/ui/styles.css` exposes the package via `@source`), so a
  runtime-composed `` z-[${n}] `` produces no CSS and computes to `auto`.
- Assert stacking or occlusion, never functional clickability: Radix drops
  `pointer-events` on the dialog panel while an inner layer is open, so
  `elementFromPoint` and Playwright actionability both pass on a dropdown the
  user cannot see.
- One layer outside `packages/ui` sits outside the scale: `file-explorer-ui`'s
  `tapestry/tapestry-lens.tsx` portals a `fixed z-[120]` code-lens preview to
  clear toasts. It is not covered by the token guard.

Settled: BST-963's ruling, and eight reserved tiers rather than the four the
defect needed. Evidence: `ui-conventions/floating-layer-stacking.md`.
Guard: `packages/ui/src/__tests__/layers.test.ts` (the invariants),
`packages/ui/src/__tests__/floating-layer-tokens.test.ts` (no hardcoded `z-`).

When changing this scale, update this section and `layers.test.ts` together.

---

## FLOATING LAYER ANCHORING

**Never transform a popup anchor.** Radix retains its opening
`getBoundingClientRect()` measurement, including active transforms. See
`ui-conventions/popup-anchor-transform.md` for the ResizeObserver limitation.

- Keep the `:not([data-state="open"])` clause on the `.kinetic-depress:active`
  rule in `packages/ui/src/globals.css`, which suppresses the press effect while
  a trigger is an OPEN popup anchor. Do not "fix" a misaligned popup by nudging
  `sideOffset` or `align`.
- `data-state` is the whole condition on purpose: every Radix floating trigger
  sets it, and the repo has no non-Radix floating anchors. Do NOT widen it to
  `[aria-expanded="true"]` — `Button` defaults to `depress`, so that kills the
  press affordance on ~14 plain disclosure toggles and buys nothing here. Scope a
  future non-Radix combobox as `[role="combobox"][aria-expanded="true"]`.
- Add no other transform, `zoom` or `scale` to an element that anchors a floating
  layer, and do not wrap one in a transformed container.
- Reproduce and assert with a REAL mouse press: a keyboard-opened popup measures
  correctly even when the defect is present.

Evidence: `ui-conventions/popup-anchor-transform.md`.
Guard: `kinetic-depress-popup-anchors.test.ts` (the selector),
`apps/web/e2e/settings-popup-anchoring.test.ts` ("bound to its trigger, not to a
scaled phantom").

### Layer registration is not synchronous

`DismissableLayer` registers in an effect; before registration Escape can reach
an underlying layer. Radix exposes readiness through inline `pointer-events`.

- Wait with `waitForFloatingLayerStack(page, targetSelector)` in
  `apps/web/e2e/utils/layout-helpers.ts`.
- Read the INLINE style, never the computed one — `model-picker.tsx` hardcodes
  `pointer-events-auto`, and a `portal={false}` layer inherits its ancestor
  dialog's value.
- Key off the target layer alone; do not assert a stack-wide shape. `Popover` is
  Radix-default `modal={false}`, so it never disables outside pointer events.
- Keep `SelectContent` on its `position="popper"` default and put
  `min-w-(--radix-select-trigger-width)` on the Content, not the Viewport:
  `item-aligned` paints the selected option on top of the trigger and exposes no
  `--radix-select-trigger-width` at all.

Evidence: `ui-conventions/layer-registration-timing.md`.

## Composer Controls

- Composer Controls is a viewport-bounded Popover with normal form navigation,
  expandable tool groups and search; long tool descriptions are on-demand help.
- Output & Limits keeps draft commit/refusal behavior when closing or collapsing;
  fields and computed values must fit at narrow widths without horizontal scroll.
  Evidence: `ui-conventions/assistant-controls.md`.
  Guard: `assistant-controls-menu-drafts.browser.test.tsx`,
  `assistant-controls-rendered.browser.test.tsx`.

---

## TAILWIND SOURCE COVERAGE

Tailwind v4 discovers utilities by scanning source TEXT. A workspace package
whose `.tsx` never enters the scan emits NO CSS for any class only it uses, and
nothing reports it — no missing import, no type error, no console warning.

- A package that writes Tailwind classes ships a package-local `styles.css`
  containing `@source "./src";`, exports it as `./styles.css`, and is imported —
  directly or chained through another package's `styles.css` — from EVERY app CSS
  entrypoint that renders it (`apps/web/src/app/globals.css`,
  `apps/desktop/src/renderer/styles.css`).

Settled: measured on `packages/settings-ui`, where 103 utilities produced no rule
at all. Evidence: `ui-conventions/tailwind-source-coverage.md`.
Guard: `scripts/__tests__/tailwind-source-coverage.test.mjs` (`pnpm test:scripts`,
the Static CI job).

---

## VIEW SWITCHERS (Tabs)

A switcher over a fixed set of views (Library, Explorer|Search, Git, Settings
Tools) is `Tabs` from `packages/ui/src/tabs.tsx`; document tab strips are not.

- `TabsList size="sm"` sits in a 36px panel header (`h-9 border-b px-2`): 28px
  track, 24px trigger, 12px/500. `size="md"` is for full pages: 36px track, 32px
  trigger, 14px/500. Consumers add layout classes, never trigger geometry.
- State changes colour, never weight; the selected trigger takes the page
  surface (`bg-background`, `ring-border/70`) in both themes. Keep the compound
  `focus-visible:data-[state=active]:` ring pair. Why: `data-*` variants sort
  after `focus-visible`, so the selected ring would repaint the focus ring.
- Activation is manual (the default): arrows move focus, Enter or Space selects.
- `TabsContent` owns visibility: an inactive panel is always `hidden`;
  `keepMounted` mounts on first activation and never unmounts; `forceMount`
  mounts before that. Never hand-roll a latch around Radix `forceMount`: Radix
  `Presence` mounts synchronously in a layout effect, outside the transition.
- Use a transition only for a React-state value (Library): `startTransition`,
  with `data-pending` on the incoming trigger. A store-backed switcher
  (Explorer|Search) renders synchronously anyway.
- No context menu (a switcher has no actions); each lazily loaded panel keeps its own
  `Suspense` boundary and each Library panel sits behind `TabPanelBoundary`.

Guard: `packages/ui/src/__tests__/tabs.test.tsx`; in app-shell, `agent-sidebar-panel.test.tsx`,
`explorer-search-tabs.test.tsx`, `git-panel.test.tsx`.

---

## Motion

Motion inside the assistant thread (`.assistant-ui-panel`) is CSS-only — no
animation library, and a small reusable catalog rather than a bespoke transition
per component. Everything lives in `overrides.css`, scoped under
`.assistant-ui-panel`. The activity trace (`docs/agents/assistant-runtime.md`
§ ACTIVITY GROUPS) is the reference: `.bs-trace-label`, `.bs-trace-collapse` /
`-inner`, `.bs-trace-reveal` and `.bs-trace-detail`.

- `.bs-trace-reveal`'s `--bs-stagger` index is set on an ANCESTOR and read
  through `var(--bs-stagger, 0)`; never declare it on the revealed element, which
  would shadow it.
- Give every animated or transitioned primitive, plus the thinking-mark
  pulse/shimmer (`.bs-thinking-pulse`, `.bs-thinking-core`,
  `.bs-thinking-shimmer`), a `@media (prefers-reduced-motion: reduce)` block that
  turns the animation OFF and freezes the settled state — never just a shorter
  duration. `.bs-trace-detail` needs none: it animates nothing.
- Motion applied to text through a transparent, gradient-clipped fill also needs
  a `@media (forced-colors: active)` fallback to a solid `CanvasText`, or High
  Contrast strips the gradient and the text disappears. Primitives animating only
  opacity or transform need none.
- Compose, never shadow, when one element carries an entrance class AND
  `.bs-thinking-shimmer`: the compound rules `.bs-trace-label.bs-thinking-shimmer`
  / `.bs-trace-label-static.bs-thinking-shimmer` list both keyframes in one
  comma-separated `animation`. A shorthand cannot inherit a peer's value, so
  mirror any change into the compound rule and list both compound selectors in
  the `prefers-reduced-motion` reset.

Evidence: `ui-conventions/trace-motion-primitives.md`.

### Step rows

L1 step rows are the shared `StepRowHeader` grammar (`activity-step-row.tsx`)
every card inside an activity trace renders through — `ToolFallback`,
`SubagentExecutionCard`, `TaskListToolCard` and the reasoning block: family icon
· verb in tense (the active form while `running` OR `waiting`) · target chip ·
timing (only when the caller supplies one) · state glyph · chevron, one row per
step in part order.

- A row with a body is a real `<button>`; a row with none is a non-interactive
  `role="group"` — never a disabled button standing in for "nothing to expand".
  The `bodyId`/`expanded`/`onToggle` trio travels together.
- Name either form by what it SHOWS (WCAG 2.5.3 Label in Name). The
  `role="group"` form is `aria-labelledby` its content span; the button form
  composes `aria-label` as visible content first, affordance last — `Read
  src/app.ts, expand details` — and drops `aria-describedby`. `label` is the
  affordance clause, not the whole name; `nameFromContent` (default `true`) is
  the opt-out, taken only by the reasoning row. The raw tool id reaches a name
  only where the caller put it in the visible `target` chip, and any test matches
  the affordance as a SUBSTRING (`{ name: /expand details/i }`).
- Own step-row geometry in the stylesheet, not utility classes: the browser
  vitest lane loads no Tailwind preflight. `.bs-step-row-meta` clamps so an
  unbounded chip cannot widen the row, and `.bs-step-row-timing` is the one slot
  that SHRINKS under an inline-size ceiling — two separate guards, since
  shrinking bounds the slot only while something else competes for the row.
  `.bs-step-list` is a BLOCK container, so inter-row rhythm comes from
  `.bs-step-list > * + *` block margins rather than a flex `gap`.
- State glyphs follow one naming rule: `role="img"` plus `aria-label` from the
  total `STEP_STATE_LABELS` map (`activity-step-tokens.ts`) — colour alone never
  carries the state.

Settled: `.bs-run-timeline` rows are group-transparent direct children that
consume `:nth-child` slots without animating; `sr-only` has no rule in the
browser lane, so a test there accounts for the visible tool-id span or omits
`toolName`. Evidence: `ui-conventions/step-row-geometry.md`.
Guard: `activity-step-row.browser.test.tsx`.

---

### Approval surfaces

- Approval cards and rows (`approval-card.tsx`, `approval-row.tsx`) follow the
  step-row grammar for the collapsed form, with geometry owned by `overrides.css`
  (`.bs-approval*`), never utilities. Name the row's toggle by its visible
  content with the affordance trailing, the same Label-in-Name rule as step rows.
- A standalone approval card or row uses its owner's validated durable `colorId`
  (named or family token). Family tokens set `--agent-accent-light` and
  `--agent-accent-dark`; an omitted color inherits the current panel accent.
  Persona chain, status glyphs and text remain visible for every hue.
- Nesting is `--bs-approval-depth`, with no hash rails or left stripes. The OUTERMOST surface
  owns depth and color — a card embedded by an expanded row
  (`presentation="embedded"`) carries no `.bs-approval` class, depth or
  separate color identity, because depth and accent inherit from the row.

Evidence: `ui-conventions/approval-surface-geometry.md`.
Guard: `approval-row.browser.test.tsx`.

---

## Delegated conversation navigation

- Child accents separate the whole tree in both themes; parent dots and ancestry
  show relatedness. Explicit refresh recolors saved children without changing names.
  Breadcrumbs validate owner/root/parent and restore source or canonical-tab focus.
- Root filters/sort and folders choose the visible roots; child rows stay beneath
  those roots in durable creation order, never independently selected or
  reparented by root bulk actions.
- Search covers owned descendants, revalidates native ancestry and message
  ownership on activation, activates the owning root through the saved-workspace
  coordinator, then opens the singleton child tab. It pages native history
  backwards in 80-row pages for an older match, and never appends a message or
  restarts work.
- Child disclosure is lazy in the shared virtual TreeTable — fifty children, then
  explicit Show more. Closing releases descendant subscriptions and reopening
  revalidates metadata; listing rows never mounts child transcripts, only an
  explicitly activated workspace tab does. Read receipts belong to the ephemeral
  root store, so a row unmount does not invent unread activity.
- Derive pending decisions on reload from the existing authoritative discovery
  path — one request per expanded parent, validated against each native
  invocation — so Needs input restores after a renderer restart without mounting
  transcripts. Opening, closing and reopening never start a model. Only pauses
  without a durable decision mark Needs input; unavailable or conflicting
  discovery renders an explicit list error; live child status beats the saved
  attention snapshot.
- Closing a child tab is reversible and reauthorizes before reading history on
  reopen; native thread deletion permanently removes the selected subtree and
  saved conversation data. Neither root nor child threads offer archiving.

Settled: free-form steering remains BST-1723 acceptance, not this slice.
Evidence: `ui-conventions/delegated-conversation-navigation.md`.
Guard: `delegated-workspace-reload.desktop.test.ts`,
`delegated-worker-write.desktop.test.ts`, `delegated-sidebar-lifecycle.test.tsx`,
`delegated-sidebar-rows.test.ts`, `delegated-conversation-ancestry.test.ts`,
`delegated-conversation-store.test.ts`.
