# One hook per target kind — evidence

Supports `docs/agents/ui-conventions.md` § "CONTEXT ACTION SYSTEM".
BST-1393. Read before adding a second trigger surface for an existing target kind, or before changing `use-root-section-context-menu.ts`.

Extracted verbatim from the pre-distillation contract.

---

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

