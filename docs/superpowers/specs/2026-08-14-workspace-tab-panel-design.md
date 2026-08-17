# Unified Workspace Tab Panel — Design

**Date:** 2026-08-14
**Status:** Approved (design review in session)
**Scope:** Right-side workspace panel in the agent shell (`apps/web` + `apps/desktop`)

## Problem

The right workspace panel stacks two tab strips:

1. An outer Radix strip (`packages/app-shell/src/workspace-panel-tabs.tsx`): Context Explorer | Changes | Canvas.
2. An inner hand-rolled strip (`packages/file-explorer-ui/src/shell/workspace-tab-host.tsx`): a pinned "Context Explorer" app tab plus file tabs, nested *inside* the outer strip's Context Explorer tab.

Files therefore open in a second-level strip "next to the context explorer tab", wasting a full row of vertical space and splitting tab semantics across two systems (`useChangesNavigationStore` for the outer strip; `useTabManagerStore` + `useWorkspaceTabSelectionStore` for the inner one).

## Goal

One tab strip, hoisted into the workspace panel's header row (the row that holds the collapse button), mirroring the agent panel's thread-tab bar. The workspace becomes a single tab panel hosting:

- **Singleton app tabs** — Files (today's Context Explorer), Changes, Canvas — visually distinct from file tabs, at most one instance each, closable.
- **File tabs** — multiple, as today.
- **Empty-state launcher** — when no tabs are open, a centered launcher with one icon card per *available* app; clicking opens that app's tab.

## Decisions (settled in design review)

| Question | Decision |
| --- | --- |
| App tabs closable? | **Yes, all three.** Closing the last tab reveals the empty-state launcher. Closed app surfaces stay mounted-but-hidden for the session (Canvas iframe / file tree must never remount). |
| Context Explorer tab name | **"Files"** label + files icon (app **id stays `context-explorer`** — it is a DOM id and persistence key; renaming the id would orphan user state). Empty-state icons: Files, Changes, Canvas. |
| Persistence | **Persist everything**: open app tabs, open file tabs, and active selection restore across restarts. |
| Deleted files on restore | **Keep tab, mark deleted** (distinct icon + explanatory body). Replaces desktop's auto-close-on-missing behavior; unifies with web's not-found state. |
| Approach | **Promote + merge**: `WorkspaceTabHost` becomes the single workspace surface; `workspace-panel-tabs.tsx` is deleted. No new parallel tab system. |

## Architecture

### Strip placement (header hoisting)

- `IdeLayout`'s right-panel chrome (`packages/ui/src/layout/ide-layout.tsx`, `PanelChromeConfig`) gains an optional `headerContent?: ReactNode` seam. When present it replaces the title text in the header row; the collapse button stays pinned right. Panels remain always-rendered (react-resizable-panels v4 imperative collapse contract unchanged).
- The agent shell (`agent-workspace-layout.tsx` / `root-layout-content.tsx`) passes the workspace tab strip as `headerContent`. Strip and body communicate exclusively through the existing zustand stores, so splitting strip (header) from body (panel content) requires no new context.
- Strip behavior mirrors `assistant-thread-tabs-workspace.tsx`: horizontal scroll with chevron overflow buttons, wheel→horizontal scroll, active-tab `scrollIntoView` (reduced-motion aware), `ResizeObserver` re-measure, roving tabindex, Arrow/Home/End keys, no visible scrollbars.

### App model

- `WorkspaceApp` (`packages/file-explorer-ui/src/shell/workspace-app.ts`) remains the registration seam. Apps are provided by the host apps via props (capability gating by omission, never `isElectron()`): web registers Files only; desktop registers Files, Changes, Canvas.
- App tabs render icon-forward with a distinct treatment (subtle tinted pill) and sort ahead of file tabs in canonical order (Files, Changes, Canvas). Singleton semantics: opening an open app activates it.
- The Files app body is today's Context Explorer surface unchanged (nested explorer layout, tree, Explorer/Search side tabs) minus the inner tab strip. `openFileInTab` registration moves to the top-level workspace surface; file bodies (`FileTabBody`) render as top-level file tabs.
- Changes (`ChangesSurface`) and Canvas (`CanvasPanel`) mount once on first open and never unmount within a session (sticky-mount contract preserved; closing a tab hides it).

### State & persistence

- `useTabManagerStore` (`tab-manager.v1`) — unchanged shape and key.
- `useWorkspaceTabSelectionStore` (`workspace-tab-selection.v1`) — version bump adding `openAppIds: string[]`; hydration via `merge` returning the complete persisted shape (house convention; never `onRehydrateStorage`). Migration seeds `openAppIds: ['context-explorer']` from v1 payloads so existing users keep their current default view.
- `useChangesNavigationStore` sheds `activeWorkspacePanelTab` and the sticky `*TabMounted` flags. It keeps changeset/canvas domain state (`activeChangeset`, nonces, thread identity). Entry points — `openChangeset`, `openCanvasPanel`, the assistant "→ Review" link, the git-panel worktree dropdown — open/activate the app tab through the unified selection store, preserving the two-write contract with `usePanelLayoutStore.setActiveTab('explorer')`.
- Factory reset: changed/new store surface registered per `docs/agents/platform-contracts.md` (both localStorage clearing and live-instance reset; `register-factory-reset-session-stores.ts`).

### Deleted / missing files

- `useTabFileRestoration`'s desktop path stops auto-closing missing files (`onTabNotFound` no longer closes); the tab persists with status `not-found`, a distinct strip treatment, and the existing "File Not Found" body. Web behavior (needs-permission / not-found states) unchanged.

### Interaction details

- Context menus through the sanctioned context-action system (`packages/context-actions`): existing `workspace-file-tab` target keeps close / close-others / close-right / close-all; app tabs gain a close action (app tabs remain non-file targets). Targets revalidate at execution.
- Desktop-only ⌘W closes the active file tab; ⌘PgUp/PgDn cycles. Unchanged.
- Collapse/expand button and collapsed-edge shim unchanged (`hide-workspace-panel` / `show-workspace-panel`).
- z-index via `packages/ui/src/layers.ts` tokens only.

## Out of scope

- Tab drag-reorder (thread tabs have it; can follow up).
- Web write-path for Canvas; browser pane tabs; any sync machinery.
- Git-panel Changes/History inner tabs (different surface).

## Testing

Red-green TDD throughout.

**Unit (vitest):**
- Selection store v2: `openAppIds` open/close/singleton/ordering, v1→v2 migration, `merge` hydration, reconciliation with tab-manager after bulk closes.
- Workspace surface: app + file tabs in one strip, capability gating (apps present ⇔ registered), empty-state launcher rendering and per-app availability, sticky mount (Canvas/Changes never unmount after first open; Files tree survives tab switches), deleted-file marking (no auto-close).
- `IdeLayout` header seam: `headerContent` renders in the header row, collapse button retained, title fallback when absent.
- Entry points: `openChangeset`/`openCanvasPanel` activate app tabs via the new store.
- Updated: `workspace-panel-tabs.test.tsx` (deleted with its component), `root-layout-content.test.tsx`, `workspace-tab-host.test.tsx`, `changes-navigation-store.test.ts`.

**E2E (Playwright, web):**
- Single strip in the panel header row (no nested strip), file open from tree lands in the top bar.
- Close all tabs → empty-state launcher; click launcher icon → app tab opens.
- Reload restores open tabs + active selection.
- Deleted file (mocked FS) shows marked tab, not silent removal.
- Collapse/expand still works; no horizontal scrollbar visible.
- Updated stale specs: `layout.test.ts`, `layout-persistence.test.ts`, `file-preview.test.ts`, `panel-state-preservation.test.ts` (testids preserved where possible: `workspace-tab-strip`, `workspace-app-tab-*`).

**Manual:** live Chrome DevTools session against the running app with screenshots before declaring done.

## Delivery

Linear epic + child tickets first; single PR via `gh` CLI; bot reviews addressed and resolved with diff notes; PR checks green.
