# Per-Thread Saved Workspaces — Design

**Date:** 2026-08-14
**Status:** Approved (design review in session)
**Builds on:** BST-1258 unified workspace tab panel (merged, PR #2436)
**Scope:** `apps/web` + `apps/desktop`; 3 stacked PRs

## Problem

The workspace (open file tabs, open app tabs, tree expansions, root focus/visibility, scroll state) is one global surface. Threads are the unit of work, but switching threads leaves the workspace untouched — the files, canvases, and explorer state you were using for thread A bleed into thread B. Additionally, an open file tab offers no way to orient in its surroundings: there is no per-file explorer view and no breadcrumbs, and opening new surfaces has no affordance beyond the launcher empty state.

## Goal

1. **Each thread owns a saved workspace.** Open file tabs (+ active selection), open app tabs, per-root tree expansions, focused/visible roots (views only), per-file pane state, and editor scroll/mode state persist per thread and restore on switch — instantly for open threads, and across app restarts.
2. **Per-file explorer panes.** Any open file tab can toggle a resizable, navigation-only explorer pane revealed to the file's location, plus a clickable breadcrumbs bar.
3. **A "+" add-tab menu** on the strip: Files ⌘P, Changes, Canvas, Terminal ⌘T (desktop) — icon + label + shortcut rows.

## Decisions (settled in design review)

| Question | Decision |
| --- | --- |
| New-thread workspace | **Inherit**: snapshot the current workspace at creation. |
| Multi-root | **Global roots, per-thread views.** The root SET, watchers, permissions, and background indexing stay app-global. Threads persist which roots are visible and which is focused, plus per-root expansions/selections-view/scroll. |
| Per-file explorer checkboxes | **Navigation-only.** Context-selection checkboxes remain exclusive to the main Files tree. |
| Persistence | **PGlite table** `brainstrike_assistant_thread_workspaces`, modeled on `brainstrike_assistant_thread_placements`. |
| Architecture | **Snapshot + hydrate coordinator** (Option A). Live zustand stores keep their current shapes; a coordinator owns thread⇄workspace binding. Rejected: re-keying every store by threadId (turns the fragile file-explorer v5 dual-write into a three-level write); per-thread store instances via remount (violates mount-once contracts, e.g. Canvas iframe). |
| PR shape | **3 stacked PRs** via gh-stack (foundation → panes/breadcrumbs → "+" menu/Terminal). |
| Browser as a workspace tab | **Deferred** to a follow-up ticket: the desktop `WebContentsView` occlusion contract must be re-verified for hidden-but-mounted tab hosting first. |

## Architecture

### PR 1 — Foundation: per-thread workspace persistence + switching

**Table (migration 094, registered in BOTH runners):**

```sql
CREATE TABLE IF NOT EXISTS brainstrike_assistant_thread_workspaces (
  thread_id   TEXT PRIMARY KEY,
  resource_id TEXT NOT NULL,
  payload     JSONB NOT NULL,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

No FK to `mastra_*` (Mastra owns its schema; numbered migrations run without the parents). Registered in: `packages/db/src/migrations/index.ts`, the drizzle `customMigrations` ledger, `reset-table-registry.ts`, `THREAD_DELETE_SIDECAR_TABLES` (thread delete cascades the workspace row automatically), desktop `db:clearAll`, renderer `purgeTablesTx`, and mirrored ADD-ONLY in `buildAssistantThreadRunsSchemaSql()` (never read contract constants at module scope). Sync-roadmap compliant: thread-attached "mind" state; the existing `entity_kind='thread'` tombstone covers it; no new op vocabulary.

**Payload** — versioned, typed, coerced (`WorkspaceSnapshotV1`):

```ts
interface WorkspaceSnapshotV1 {
  version: 1;
  apps: { openAppIds: string[]; selection: WorkspaceTabSelection };
  fileTabs: { tabs: Array<{ compositeKey: string; path: string }>; activeTabId: string | null };
  roots: { focusedRootId: string | null; visibleRootIds: string[] | null }; // null = all visible
  explorer: {
    scrollTop?: number; // one scroll container spans the forest (existing contract)
    byRoot: Record<RootId, { expandedPaths: string[] /* cap 100, shallowest-first */ }>;
  };
  editors: Record<CompositeKey, { mode?: FileViewMode; scrollTop?: number;
    pane?: { open: boolean; widthPct?: number; expandedPaths?: string[] /* cap 50 */ } }>;
}
```

Coercion mirrors the selection-store convention: validate the complete shape; malformed payloads log an error and fall back to an empty snapshot (never partial adoption, never a crash). Entries in `editors` are pruned to open tabs on serialize (bounded growth).

**Repository** — `packages/assistant-data/src/thread-workspace-repository.ts`, modeled on the placements repository: `getThreadWorkspace(threadId)`, `getThreadWorkspaces(threadIds)` (batch, for open-tab preload), `setThreadWorkspace(threadId, resourceId, payload)` (single upsert, `ON CONFLICT (thread_id) DO UPDATE`), strict row validation both directions, `WeakMap<DbHandle, Repository>` cache.

**Coordinator** — `packages/app-shell/src/thread-workspace/thread-workspace-coordinator.tsx` (+ pure `workspace-snapshot.ts` serialize/hydrate helpers). Mounted once inside the explorer surface (needs file-explorer + db contexts). Responsibilities:

- **Observe** the active thread: `useAssistantThreadStore` `activeThreadIdByResourceId[WORKSPACE_MEMORY_RESOURCE_ID]` — the single switching signal.
- **Serialize continuously**: subscribe to the live stores (tab-manager, workspace-tab-selection, file-explorer store slices, editor-view-state, pane store); debounce 500 ms (editor-view-state precedent); write through the repository for the CURRENT thread only. Writes are suppressed during hydration (a `hydratingRef` guard — hydration must never echo back as a save for the wrong thread).
- **Hydrate on switch**: from an in-memory `Map<threadId, WorkspaceSnapshotV1>` cache (preloaded for all OPEN thread tabs at boot and on tab open) so switching is synchronous; repository fetch only for never-cached threads. Hydration applies snapshot → live stores in one pass: apps/selection, file tabs (restoration statuses re-resolve via the existing `useTabFileRestoration` flow), per-root expansions via `setExpandedPaths` (fresh Set — the store adopts it), focus/visibility, editor state.
- **Inherit on create**: `createThread` flows get the current live snapshot written for the new thread id before/at activation (hooked at the coordinator level by observing thread creation, not by patching every call site).
- **First-run migration**: on upgrade, the active thread has no row — it inherits the current global live state (which is exactly the inherit semantic); nothing is lost.
- **Fallbacks are explicit**: no thread active (boot before threads load) → live stores behave exactly as today (global cache); a missing row for an existing thread → inherit-current (logged).

**Active-thread unification (correctness fix):** `CanvasPanel` and `ChangesSurface` currently read `changes-navigation-store.activeThreadIdentity`, which is published on wrapper MOUNT — last-mount-wins across the simultaneously-mounted open threads. They move to the thread store's active id (a `useActiveAssistantThreadId()` selector hook in `assistant-data`); `activeThreadIdentity` keeps its run-tracking role (`latestRunId`) but stops being the "which thread" source. Regression test pins: opening thread B in a background tab does not change which thread's canvases the Canvas tab shows.

**Indexer hardening:** the workspace-collection sync effect's dependency on the FOCUSED root handle is narrowed to the root-SET identity (ids of `rootDirectoryHandles`), so per-thread focus restore cannot cancel an in-flight import. Regression test: focus change (and a full thread switch) during an active sync does not bump the sync generation. The root registration, watchers, backfill ordering, and visibility-based recovery paths are untouched — the root set never changes on switch by design.

**Switch UX:** hydration from cache is synchronous within one commit — no intermediate paint of the old workspace under the new thread. E2E pins: switch A→B→A restores A's exact tabs/active/expansions; reload restores the active thread's workspace; deleting a thread deletes its row (cascade test).

### PR 2 — Per-file explorer panes + breadcrumbs

**Tree infrastructure (net-new, in `packages/ui` + `file-explorer-ui`):**
- `TreeTable` gains an imperative `revealNode(nodeId)` handle (expand ancestors handled by caller; scroll via the existing internal `scrollToNode`, honoring the rowHeight-29 and sticky-header offset contracts — no `scrollMargin` double-count).
- `OptimizedFileTree` gains: `expansionScope?: 'store' | { expandedPaths, onToggle }` (local controlled expansion — per-pane state, not the workspace-global set), `hideSelection?: boolean` (threaded through `FileTreeSelectionContext` into `file-tree-name-cell` — checkbox not rendered, spacer preserved for alignment), `revealPath?: string` one-shot reveal.
- Identity-stable node contract preserved: panes share the normalized tree via the existing WeakMap materialization; no per-pane node decoration.

**`FileTabExplorerPane`** (`file-explorer-ui/src/shell/file-tab-explorer-pane.tsx`): a right-side resizable pane inside the file tab body — nested horizontal `Group`/`Panel`/`Separator` (precedent: ide-layout's nested vertical console group). Scoped to the file's ROOT, auto-revealed to the file's directory on open; local expansion state; navigation-only (`hideSelection`); single-click opens files via the existing `openFileInTab` seam. Toggle button in `FileTabHeader`. Pane open/width/expansions persist per tab in the thread snapshot (`editors[compositeKey].pane`). Each pane owns its own `TreeTableViewport` (the sanctioned single-root shape — no shared scroller needed).

**`Breadcrumbs`** (`packages/ui/src/breadcrumbs.tsx`): generic, accessible (`nav[aria-label]` + `ol`), truncation-aware (middle-collapse with an ellipsis menu when overflowing), theme-tokened. `FileTabHeader` replaces its flat directory text with `Breadcrumbs`: root display name → path segments → filename; clicking a segment opens/reveals that folder in the pane (opening the pane if closed). Per-segment sibling dropdowns are a listed future enhancement, not v1.

### PR 3 — "+" menu + Terminal as a workspace app

- **"+" button** on the strip, immediately after the tablist scroller (outside `role="tablist"` — the composition rule from BST-1258 review). `DropdownMenu` items: icon + label + `DropdownMenuShortcut` (the `formatShortcut` helper gets exported from `action-context-menu.tsx`): **Files** ⌘P (opens quick-open via `useQuickOpenStore`), **Changes**, **Canvas** (present only when registered — capability gating unchanged), **Terminal** ⌘T (desktop only). Items for already-open singletons activate them (singleton semantics).
- **Terminal becomes a desktop `WorkspaceApp`** (`TERMINAL_APP_ID`), replacing its nav-rail route. The app's `render()` lazy-loads the terminal panel (xterm stays code-split; the "+" menu imports only `availability.ts`). Keep-alive semantics from BST-1258 apply (mounted across switches; close unmounts). Terminal tab participation in per-thread workspaces: its open/closed state rides `openAppIds` like any app.
- **⌘T hook** cloned from `use-quick-open-hotkey.ts` (`isPlatformAccelerator(event, 't')`), desktop-gated, mounted beside QuickOpenHost.
- **Launcher** gains the Terminal card (desktop) via the same registry; `APP_DESCRIPTIONS` extended.

### Future enhancements (documented, deliberately out of scope)

Browser as a workspace tab (WebContentsView occlusion re-verification — follow-up ticket in the epic); per-segment breadcrumb sibling dropdowns; "Side chat" per-tab assistant; per-thread root SETS layered over the global-roots foundation; workspace templates; sync of `brainstrike_assistant_thread_workspaces` when the sync engine lands (payload is versioned and thread-keyed for exactly this).

## Error handling

NO SILENT FALLBACKS: malformed payloads coerce to empty with a logged error; repository write failures surface via the existing toast+log path and never wedge switching (the live stores remain correct; the row heals on next debounce); hydration for a missing thread row logs and inherits-current; the coordinator's hydrating guard is asserted in tests (a hydration must never persist under the wrong thread id).

## Testing (red-green throughout)

- **Unit:** repository (upsert/batch/validation/cascade via sidecar list), snapshot serialize/hydrate round-trip + coercion of malformed payloads, coordinator (switch, inherit-on-create, debounce, hydrating guard, delete pruning of the cache), active-thread unification (background mount does not steal Canvas/Changes), indexer dep-narrowing (focus change does not cancel sync), TreeTable reveal, local expansion scope, hideSelection, Breadcrumbs (segments, truncation, a11y), "+" menu (gating, shortcuts, singleton activation), Terminal app registration.
- **Integration (db):** migration applies on both runners' paths; reset-table coverage test picks up the new table.
- **E2E web (Playwright):** thread switch round-trip restores tabs/expansions/active; reload restores active thread's workspace; new thread inherits; per-file pane open/reveal/breadcrumb click; "+" menu opens Files/Changes.
- **E2E desktop (Playwright):** Terminal via "+" and ⌘T; per-thread switch with Canvas tab.
- **Live verification (definition of done):** web via Chrome DevTools MCP, **and desktop via `pnpm --filter @brainstrike/desktop dev:agent-debug` (CDP attach, port 9222)** — thread-switch workspace swap, panes, breadcrumbs, "+" menu, Terminal tab, with screenshots.

## Delivery

Linear epic + per-PR child tickets (foundation / panes+breadcrumbs / plus-menu+terminal / Browser-tab follow-up). 3 stacked PRs via gh-stack, each with the full gate green, bot reviews addressed and resolved with diff notes.
