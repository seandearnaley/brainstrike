# Per-Thread Saved Workspaces Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Each thread owns a persisted workspace (tabs, apps, expansions, root views, pane/editor state) that swaps on thread switch; per-file explorer panes with breadcrumbs; a "+" add-tab menu with Terminal as a desktop workspace app.

**Architecture:** Snapshot+hydrate coordinator over unchanged live zustand stores, persisted in a new PGlite sidecar table keyed by thread_id. Three stacked PRs.

**Tech Stack:** PGlite (dual migration runners), zustand, React 19, react-resizable-panels, TanStack-virtualized TreeTable, Playwright, Vitest.

**Spec:** `docs/superpowers/specs/2026-08-14-per-thread-workspaces-design.md` (all settled decisions there govern).

## Global Constraints

- Branch stack: `feature/per-thread-workspaces` (PR 1) → `feature/per-thread-workspaces-panes` (PR 2) → `feature/per-thread-workspaces-plus-menu` (PR 3), via gh-stack.
- TDD red-green per task; each PR ships with `pnpm build && pnpm lint && pnpm type-check && pnpm test` green in one run, e2e green, and LIVE verification on web (CDT) and desktop (`dev:agent-debug` CDP :9222).
- Migration 094: register in `packages/db/src/migrations/index.ts` AND drizzle `customMigrations` AND `reset-table-registry.ts` AND `THREAD_DELETE_SIDECAR_TABLES` AND desktop `db:clearAll` AND renderer `purgeTablesTx` AND the ADD-ONLY renderer bootstrap mirror in `buildAssistantThreadRunsSchemaSql()`. `CREATE TABLE IF NOT EXISTS`; no FK to `mastra_*`; never read contract constants at module scope.
- Store storage-key strings are frozen; never rename, only version-bump with `migrate` + full-shape `merge`.
- NO SILENT FALLBACKS: coerce+log to a typed empty snapshot; repository failures toast+log; hydration guard asserted by test.
- Mount-once/keep-alive (BST-1258) invariants hold: hydration must not remount app surfaces; switching threads must not remount the workspace subtree.
- Indexer: the root SET never changes on thread switch; the sync effect must not depend on the focused handle after PR 1.
- Expansion sets handed to `setExpandedPaths` are fresh (store adopts them); reveal math honors rowHeight-29 and no-scrollMargin contracts.

---

## PR 1 — Foundation

### Task 1.1: Migration 094 + reset/cascade registration

**Files:** Create `packages/db/src/migrations/094-assistant-thread-workspaces.ts`; modify `packages/db/src/migrations/index.ts`, `packages/db/src/drizzle/migrate.ts`, `packages/db/src/reset-table-registry.ts`, `packages/assistant-contract/src/mastra-memory-schema.ts` (`THREAD_DELETE_SIDECAR_TABLES` + a `BRAINSTRIKE_THREAD_WORKSPACES_TABLE` const + DDL builder used by both migration and bootstrap), `packages/assistant-data/src/assistant-memory-repository.ts` (bootstrap mirror), `apps/desktop/src/ipc-domains/db-ipc.ts` (`db:clearAll`), `packages/db/src/db-provider.tsx` (`purgeTablesTx`).
**Interfaces produced:** table `brainstrike_assistant_thread_workspaces(thread_id TEXT PK, resource_id TEXT NOT NULL, payload JSONB NOT NULL, updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`.
**Red:** db migration test asserting the table exists post-migration + reset-table coverage integration test picks it up + a sidecar-cascade unit test (deleteThread removes the row — extend the existing delete-cascade suite).
**Green:** implement; verify BOTH runners create it (numbered runner test + `pnpm --filter @brainstrike/db test`).

### Task 1.2: Snapshot schema + coercion (`workspace-snapshot.ts`)

**Files:** Create `packages/assistant-data/src/thread-workspace-snapshot.ts` (+ tests).
**Interfaces produced:**
```ts
export interface WorkspaceSnapshotV1 { version: 1; apps: {...}; fileTabs: {...}; roots: {...};
  explorer: { scrollTop?: number; byRoot: Record<string, { expandedPaths: string[] }> };
  editors: Record<string, { mode?: 'source'|'preview'; scrollTop?: number;
    pane?: { open: boolean; widthPct?: number; expandedPaths?: string[] } }>; }
export const EMPTY_WORKSPACE_SNAPSHOT: WorkspaceSnapshotV1;
export function coerceWorkspaceSnapshot(value: unknown): WorkspaceSnapshotV1; // full-shape, caps (100/root, 50/pane), logs on malformed
```
**Red:** coercion tests (garbage → empty+logged; caps enforced shallowest-first; unknown version → empty+logged; valid round-trips).

### Task 1.3: Repository

**Files:** Create `packages/assistant-data/src/thread-workspace-repository.ts` (+ tests, modeled on `assistant-thread-groups-repository.ts`: WeakMap cache, strict validation, single upsert).
**Interfaces produced:** `createThreadWorkspaceRepository(db)` → `{ getThreadWorkspace(threadId): Promise<WorkspaceSnapshotV1|null>; getThreadWorkspaces(threadIds): Promise<Map<string,WorkspaceSnapshotV1>>; setThreadWorkspace(threadId, resourceId, snapshot): Promise<void> }`.
**Red:** integration-style tests against PGlite (upsert overwrites, batch get, coercion at read boundary).

### Task 1.4: Serialize/hydrate helpers (pure)

**Files:** Create `packages/app-shell/src/thread-workspace/workspace-snapshot-io.ts` (+ tests).
**Interfaces produced:** `captureWorkspaceSnapshot(deps): WorkspaceSnapshotV1` and `applyWorkspaceSnapshot(snapshot, deps): void` where `deps` are narrow store facades (getState/set actions of tab-manager, workspace-tab-selection, file-explorer store, editor-view-state, file-system focus/visibility setters) — injected for testability. `editors` pruned to open tabs on capture.
**Red:** round-trip test (capture→apply restores equivalent store state); apply hands FRESH Sets to `setExpandedPaths`; apply of empty snapshot yields launcher-state stores.

### Task 1.5: Coordinator

**Files:** Create `packages/app-shell/src/thread-workspace/thread-workspace-coordinator.tsx` (+ tests); mount from `root-layout-content.tsx` inside the explorer providers; register cache-prune on thread delete.
**Behavior:** observes `activeThreadIdByResourceId[WORKSPACE_MEMORY_RESOURCE_ID]`; debounced (500 ms) capture→repository write for current thread, suppressed while `hydratingRef` is set; on switch: cache-hit hydrate synchronously, else fetch→hydrate; boot preloads snapshots for open thread ids (batch); create-thread inherit: when a NEW active thread has no row and no cache entry, write current capture as its snapshot (covers first-run migration too); thread delete prunes cache.
**Red:** unit tests with mocked repository + real stores: switch persists outgoing + hydrates incoming; hydration never writes back under incoming id (guard test); inherit-on-create; no-thread boot = no-op; rapid A→B→A uses cache (repository fetch count).

### Task 1.6: Active-thread unification

**Files:** Add `useActiveAssistantThreadId()` to `packages/assistant-data/src/assistant-thread-store.ts` exports; modify `packages/app-shell/src/canvas/canvas-panel.tsx` and `changes/ui/changes-surface.tsx` (and `changes-navigation-store` docs) to consume it; `use-wrapper-rewind-wiring.ts` keeps publishing run identity but only when its thread IS active (guard) so `latestRunId` semantics survive.
**Red:** test pinning "background thread mount does not steal Canvas/Changes thread"; existing canvas-panel/changes tests updated.

### Task 1.7: Indexer dep hardening

**Files:** Modify `packages/app-shell/src/background-indexing/workspace-collection-sync-provider.tsx`: `triggerSync` (and its owning effect) key off a stable root-set identity (sorted rootIds join) instead of `rootDirectoryHandle`/array identities; handles resolved live via refs.
**Red:** test that a focus-only change does not re-create `triggerSync`/bump the sync generation; root add/remove still does.

### Task 1.8: Gate + e2e + live verification + PR 1

E2E web: switch round-trip, reload restore, inherit-on-create, delete-cascade (via UI delete). Desktop live check via dev:agent-debug (Canvas per-thread now correct). Full gate; push; `gh pr create`; monitor + address reviews (same loop as BST-1258: fix, reply with diff notes, resolve threads).

---

## PR 2 — Panes + breadcrumbs

### Task 2.1: TreeTable `revealNode` imperative handle
`packages/ui/src/tree-table/tree-table.tsx`: expose `revealNode(nodeId)` via `treeTableRef` prop reusing internal `scrollToNode` (no scrollMargin; start-aligned per the documented cancellation contract). Red: unit test with fake virtualizer asserting scrollToIndex math at rowHeight 29.

### Task 2.2: OptimizedFileTree scoping props
`expansionScope?: { expandedPaths: ReadonlySet<string>; onToggle(path) }` (default: store), `hideSelection?: boolean` (threaded via `FileTreeSelectionContext` → `file-tree-name-cell` renders spacer instead of checkbox), `revealPath?: string` one-shot (expands ancestors through the scope, then revealNode). Red: three unit tests; row-reuse/identity tests still green.

### Task 2.3: `Breadcrumbs` in packages/ui
`nav[aria-label]>ol>li` with separator glyphs, middle-collapse overflow into a dropdown, onSegmentClick(segmentPath). Red: a11y + truncation + click tests.

### Task 2.4: `FileTabExplorerPane` + FileTabHeader integration + per-thread pane state
Nested horizontal Group/Panel/Separator in `FileTabBody`; pane hosts scoped tree (file's root, local expansion, hideSelection, reveal to file dir); toggle button + Breadcrumbs in `FileTabHeader` (segment click reveals folder, opens pane if closed). New session store `file-tab-pane-store.ts` (`Record<compositeKey, {open,widthPct,expandedPaths}>`), captured into `editors[*].pane` by PR 1's snapshot IO (extend capture/apply + tests). Red: pane toggle/reveal/breadcrumb tests; snapshot round-trip includes pane state.

### Task 2.5: Gate + e2e + live verification + PR 2 (stacked)

---

## PR 3 — "+" menu + Terminal app

### Task 3.1: Export `formatShortcut`; "+" button + menu in `workspace-tab-strip.tsx` (outside tablist), items from a new `workspaceAddMenuItems(apps, capabilities)` helper: Files ⌘P (quick-open), Changes, Canvas, Terminal ⌘T; singleton activation; capability gating by registry presence. Red: menu tests (gating, shortcut chips, activation).

### Task 3.2: Terminal as desktop WorkspaceApp
`TERMINAL_APP_ID` in workspace-app.ts; desktop registers `{icon: TerminalIcon, id, label: 'Terminal', render: lazy(TerminalPanel)}`; nav-rail route removed (`/terminal` nav item dropped; `KeepMountedRoute` for terminal removed); launcher card + description. ⌘T hook `use-terminal-hotkey.ts` cloned from quick-open idiom, desktop-gated, mounted beside QuickOpenHost, opens/activates the app. Red: registration/gating/hotkey tests; desktop e2e Terminal-via-+ and ⌘T.

### Task 3.3: Gate + e2e + live verification (desktop CDP for Terminal/Canvas flows) + PR 3 (stacked); Browser follow-up ticket filed in Linear with occlusion notes.

## Self-review

Spec coverage: persistence/table (1.1–1.3) ✓ switching+inherit (1.4–1.5) ✓ unification (1.6) ✓ indexer (1.7) ✓ panes/breadcrumbs/reveal/local-expansion/hideSelection (2.1–2.4) ✓ "+"/Terminal/⌘T/launcher (3.1–3.2) ✓ Browser deferral (3.3) ✓ live desktop verification (1.8/2.5/3.3) ✓. Types named consistently (`WorkspaceSnapshotV1`, `coerceWorkspaceSnapshot`, `captureWorkspaceSnapshot`/`applyWorkspaceSnapshot`, `useActiveAssistantThreadId`, `TERMINAL_APP_ID`).
