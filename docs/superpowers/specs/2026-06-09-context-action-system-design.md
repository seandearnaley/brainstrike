# Context Action System — Design

**Date:** 2026-06-09
**Status:** Approved
**Scope decisions (user-approved):**
- Architecture ambition: action registry + context menus (command palette / keybindings designed-for but NOT built).
- v1 surfaces: file explorer tree (left nav) + collection browser (refactor its existing one-off menu).
- Capability gating on web: desktop-only actions are **hidden**, never shown disabled.

## Problem

The app has exactly one context menu — a bespoke implementation inside
`packages/db-explorer/src/components/collection-browser-view.tsx` (~lines 990–1336) that
captures pointer coordinates into local state and force-opens a `DropdownMenu` at fixed
coordinates, with inline item lists and inline handlers. Replicating that pattern per
surface (file tree, tabs, chat) would create divergent copies of menu positioning,
clipboard handling, and platform gating logic.

Meanwhile users have no way to copy a file's path (relative or full), reveal a file in
Finder/File Explorer, or copy entity IDs/content outside the collection browser.

## Goals

1. One extensible, typed action system that any surface can adopt with a small adapter.
2. Ship right-click menus on the file explorer tree and collection browser.
3. Desktop-only operations (reveal, full path) cleanly gated by capability, hidden on web.
4. Architecture reusable later by a cmdk command palette, toolbars, and keyboard
   shortcuts without rework.

## Non-Goals (v1)

- Command palette, keybinding registry.
- Menus on workspace file tabs, CodeSurface, or assistant chat (future target kinds).
- Refactoring the ad-hoc clipboard code in
  `packages/ui/src/assistant-ui-panel/markdown-text.tsx` (flagged follow-up).
- Any TreeTable behavioral change beyond consuming its existing `onContextMenu` plumbing.
- "Open in Default App" action (one definition away once the bridge exists; deferred).

## Architecture

Three layers, strictly separated:

```
┌─ Surfaces (file-explorer-ui, db-explorer) ─────────────────┐
│  adapt their node models → ContextTarget, mount the menu   │
├─ Renderer (packages/ui/src/context-menu/) ─────────────────┤
│  Radix ContextMenu wrapper + ActionContextMenu component   │
├─ Headless core (packages/context-actions — NEW package) ───┤
│  ContextTarget union · ContextAction · registry ·          │
│  capability gating · ClipboardService                      │
└─ Desktop bridge (apps/desktop) ────────────────────────────┘
   window.platform: showItemInFolder / openPath via IPC
```

The headless core (`packages/context-actions`, package name
`@brainstrike/context-actions`) has no React-rendering knowledge and no Electron
imports — it consumes capabilities injected by the app shell. `packages/ui` depends on
the core; feature packages depend on both.

## Core types

```ts
// packages/context-actions — owns the union; surfaces adapt INTO it
type ContextTarget =
  | { kind: 'file-entry'; name: string; relativePath: string; absolutePath: string | null;
      entryType: 'file' | 'directory'; rootFolderId: string }
  | { kind: 'collection'; id: string; name: string }
  | { kind: 'collection-file'; id: string; name: string; path: string | null }
  | { kind: 'chunk'; id: string; content: string }
  | { kind: 'embedding'; id: string; vectorId: string };

type CapabilityKey = 'clipboard' | 'fs.reveal' | 'fs.openPath';

interface ContextAction<K extends ContextTarget['kind'] = ContextTarget['kind']> {
  id: string;                                  // e.g. 'file.copy-relative-path'
  label: string | ((t: TargetOf<K>) => string);
  icon?: ComponentType;                        // lucide icon
  group: 'copy' | 'navigate' | 'tree' | 'inspect' | 'danger'; // ordering + separators
  appliesTo: readonly K[];
  requiredCapabilities?: readonly CapabilityKey[]; // missing ⇒ item HIDDEN
  isVisible?: (target: TargetOf<K>) => boolean;    // false ⇒ item HIDDEN (data-shaped gating)
  isEnabled?: (target: TargetOf<K>) => boolean;    // false ⇒ rendered disabled
  run: (target: TargetOf<K>, services: ActionServices) => Promise<ActionOutcome>;
}

type ActionOutcome = { ok: true; message?: string } | { ok: false; error: string };
```

Design decisions baked in:

- **The target union lives in the core package, not in surface packages.** Surfaces
  write small adapters (`fileNodeToTarget(node): ContextTarget`). This avoids
  dependency cycles (collection-browser types live in `packages/ui`, which depends on
  the core) and keeps renderers ignorant of `IFileNode` / `BrowserNodeData`.
- **Capabilities are declared, not checked.** No `isElectron()` calls in action or menu
  code. Web simply never constructs the `fs.reveal` capability, so actions requiring it
  are filtered out (the user-approved "hide" policy). If a remote-workspace mode or
  test harness appears later, actions keep working because nothing asks "am I Electron?".
- **`absolutePath: string | null`** makes the platform difference explicit in the type.
  Desktop adapter resolves it from `rootFolderId` + relative path; web adapter sets
  `null`. (Implementation must verify exactly how desktop `IFileNode.path` /
  `rootFolderId` compose; exploration indicates desktop roots are absolute paths.)
- Actions whose preconditions are data-shaped (e.g. Copy Full Path needs
  `absolutePath !== null`) use `isVisible` to hide rather than rendering a permanently
  disabled item on web. `isEnabled` is reserved for transient states (e.g. content not
  loaded yet) where a greyed item is informative.

## Registry & composition

No import-time side-effect registration (registration order would depend on bundler
chunking). Instead, explicit composition:

- Feature packages export plain arrays: `fileEntryActions: ContextAction[]` from
  `packages/file-explorer-ui`; `collectionActions` from `packages/db-explorer`.
- The app shell composes once per app:
  `createActionRegistry({ actions, capabilities, services })`, mounted via
  `<ActionRegistryProvider>` near the root of both `apps/web` and the desktop renderer,
  with platform-appropriate capability sets.
- `registry.actionsFor(target)` returns the filtered, grouped, ordered action list —
  a pure function, unit-testable without React.
- **Surface-local actions stay local.** Actions that close over surface state (Expand
  All Children, Inspect, Select) do not enter the global registry. The menu component
  accepts `localActions?: ContextAction[]` and merges them by group. The collection
  browser's existing Expand/Collapse / Expand All / Inspect / Select items migrate as
  local actions; Copy ID becomes a global action.

## Renderer (packages/ui)

- Add `@radix-ui/react-context-menu` dependency and wrap it in
  `packages/ui/src/context-menu/context-menu.tsx`, styled identically to the existing
  `dropdown-menu.tsx` (same tokens, same export shape: `ContextMenu`,
  `ContextMenuTrigger`, `ContextMenuContent`, `ContextMenuItem`, separators, sub-menus,
  labels, shortcut slot). This replaces the hand-positioned DropdownMenu hack and gives
  pointer-anchored positioning, collision handling, typeahead, long-press for touch,
  and ARIA menu semantics for free.
- `ActionContextMenu`: takes `{ target, localActions, children }`, wraps `children` in
  the trigger, renders grouped items with separators from `registry.actionsFor(target)`,
  and executes actions with the registry's services.
- **Virtualization-safe integration:** one ContextMenu root wraps the whole tree
  *container*, not each row (per-row Radix roots across virtualized rows would be
  wasteful). On right-click, the row is resolved via the existing
  `onRowContextMenu(nodeId, node, event)` callback / `data-node-id` attribute, the
  current target is set in state, and Radix opens at the pointer. A right-click that
  resolves to no target calls `preventDefault()` so no empty menu opens.
- Outcomes surface through the existing toast system (`useToast`): success toasts
  ("Relative path copied") and failure toasts. Failures also log via
  `createLogger('ContextActions')`. Per the no-silent-fallbacks rule, a failed IPC
  reveal is an error toast, never a silent no-op.

## Desktop bridge + clipboard service

Follows the established IPC pattern (`desktop-ipc-channels.ts` → domain `ipc-*.ts`
module using `createDesktopIpcRegistry` → preload bridge → `electron.d.ts` types →
registration in `main.ts` `app.whenReady()` with cleanup in `will-quit`):

- New `platform` channel domain: `platform:show-item-in-folder`, `platform:open-path`.
- New `apps/desktop/src/ipc-platform.ts` registers invoke handlers that validate the
  payload is a non-empty **absolute** path string before touching Electron `shell`;
  invalid payloads return a structured failure.
- Preload exposes `window.platform = { showItemInFolder, openPath }`, gated by
  `shouldExposeBridge('platform')` so E2E can disable it.
- The desktop app shell maps `window.platform` into the `fs.reveal` / `fs.openPath`
  capabilities at registry-creation time. Web passes neither.
- **`ClipboardService`** lives in the core package: prefers `window.clipboard`
  (Electron preload bridge), falls back to `navigator.clipboard`, returns
  success/failure instead of throwing. The collection browser's inline
  `navigator.clipboard` calls migrate onto it.

## v1 action set

| Action | Targets | Capabilities | Notes |
| --- | --- | --- | --- |
| Copy Name | file-entry, collection-file | clipboard | |
| Copy Relative Path | file-entry, collection-file | clipboard | |
| Copy Full Path | file-entry | clipboard | hidden when `absolutePath === null` (web) |
| Reveal in Finder / File Explorer | file-entry | fs.reveal | platform-aware label |
| Copy ID | collection, collection-file, chunk, embedding | clipboard | migrated from existing menu |
| Copy Content | chunk | clipboard | |
| Expand/Collapse, Expand All, Inspect, Select | (surface-local) | — | migrated as local closures, behavior unchanged |

## Error handling

Every `run` resolves to an `ActionOutcome`; the menu layer toasts both branches.
Bridge/IPC failures propagate as `{ ok: false }` — no silent degradation. Capability
construction itself is strict: a malformed/absent bridge yields an absent capability
(action hidden), never a stubbed capability that fails at click time.

## Testing

- **Unit (Vitest, core package):** registry filtering matrix
  (appliesTo × requiredCapabilities × isEnabled), grouping/ordering, ClipboardService
  fallback order, copy/reveal `run` functions with stubbed services.
- **Unit (surface packages):** both target adapters (`IFileNode → file-entry` on
  desktop-style and web-style inputs; `BrowserNodeData → collection-* targets`).
- **Component (packages/ui):** ActionContextMenu renders groups/separators, executes on
  click, hides capability-gated items, disables `isEnabled === false` items; TreeTable
  container-level right-click → target resolution. Per the TreeGrid convergence
  contract, interaction tests go in BOTH the shared UI package and consuming feature
  packages.
- **Desktop:** unit tests for `ipc-platform.ts` validation (rejects relative/empty
  paths).
- **E2E:** one web smoke — right-click a file in the tree → Copy Relative Path →
  assert clipboard contents (clipboard mocking already exists in
  `apps/web/e2e/utils/mock-fs.ts`). No new desktop E2E in v1.
- Full gate: build, lint, type check, and unit tests all green together.

## Documentation

- Add a "Context Action System" section to AGENTS.md (living-document rule) covering:
  the three layers, how a surface adopts the system (adapter + localActions), how to
  add an action, how to add a capability, and the hide-on-missing-capability policy.

## Follow-ups (explicitly deferred)

- Migrate `markdown-text.tsx` `useCopyToClipboard` onto `ClipboardService`.
- "Open in Default App" action.
- Target kinds + menus for workspace file tabs, CodeSurface selection, assistant
  messages.
- cmdk command palette and keybinding registry consuming the same registry.
