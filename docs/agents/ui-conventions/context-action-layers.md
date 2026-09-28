# Context action layers and bridges — evidence

Supports `docs/agents/ui-conventions.md` § "CONTEXT ACTION SYSTEM".
BST-1004. Read before moving an action layer, changing the clipboard bridge, or adding a feature-package import to always-mounted code.

Extracted verbatim from the pre-distillation contract.

---

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

---

- **2026-09-27: workspace app tabs gain a context menu (BST-1839, BST-1836 D4).**
  The contract said app tabs were "closable singletons with an inline close
  button and Delete-key close, deliberately WITHOUT a context menu". The
  maintainer superseded that ruling when approving the unified tab-controller
  design (`docs/superpowers/specs/2026-09-27-unified-tab-controllers-design.md`
  §6.4, §8.2): every document and app tab gets a menu. App tabs claim a
  `workspace-app-tab` target (`appId`, `label`, `placement`) and get Close,
  Close Others and Close All from `createTabStripActions`. The bulk items are
  scoped to the tab's placement group (pinned singletons, or dynamic child
  conversations) and applied in one transition by the selection store's
  `closeApps`, which keeps a selected app of the other group. There are no Move
  items: pinned apps keep registry order and child conversations do not
  reorder. Guard: `packages/file-explorer-ui/src/__tests__/workspace-tab-strip.test.tsx`.
