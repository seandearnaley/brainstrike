# Multi-Root Phase 4: Forest UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Multiple roots visible and usable at once — VS Code-style forest sidebar, "Add Folder", restore-all-N banner, per-root watchers, per-root sync passes — the first user-visible multi-root capability.

**Architecture (locked decisions):**
- **Forest = stacked trees (Option A):** `FileExplorerSidebar` renders one `OptimizedFileTree` per active root, each under a root-label header row. No changes to `TreeTable`/`useFileTree` internals. Keyboard continuity across roots deferred.
- **Single-ACTIVE-root selection:** `currentFolderId` remains the focus root's id (still `handle.path` in phase 4); interacting with another root's tree switches focus (per-root `folderStates` already preserves each root's selection/expansion). Cross-root selection = phase 5.
- **Path-keyed stores stay:** `folderStates`/token-cache/`FileTreeIndex` keys remain `handle.path`. Accepted phase-4 limitation: two same-NAMED web roots collide in display state (consistent with the phase-2 registry same-path merge). RootId re-keying of these stores = phase 5.
- **Add only, no Remove:** removal (with its DB-cascade implications) is deferred entirely.
- **Sync:** sequential per-root `service.sync()` calls; `WorkspaceCollectionSyncRequest` stays single-handle.
- **GREENFIELD:** `FILE_EXPLORER_STORAGE_VERSION` bumps 3→4; the existing migration machinery discards old state on bump (state-migration.ts:147-158 `discardInvalidPayload`) — that reset is the intended behavior, no migration written.

**Tech Stack:** React 19, Zustand persist, TreeTable (`packages/ui/src/tree-table`), Vitest + @testing-library/react.

**Context (verified by design dossier — trust these file:line references):**
- Render chain: `useFileSystem` (use-file-system.ts:54, single `rootDirectoryHandle` reducer) → `useFileExplorer` (file-explorer-ui/src/shell/use-file-explorer-context.ts:164) → `FileTreeProvider` (tree/file-tree-provider.tsx:97, single-handle prop, clears `FileTreeIndex` on root change :131-137) → `FileExplorerSidebar` (shell/file-explorer-sidebar.tsx:91, `folderId={getRootFolderId(rootDirectoryHandle) ?? currentFolderId ?? ''}` :128) → `OptimizedFileTree` (tree/optimized-file-tree.tsx:318, `nodesArePreFlattened` :885) → TreeTable (`TreeNode<T>` has `depth`/`parentId: string | null` — N depth-0 roots already legal).
- `IFileNode.rootFolderId = rootHandle.path` (use-file-tree.ts:437); selection keys are `encodeFileSelection(folderId, path)` composites.
- Store: `currentFolderId`, `folderStates: Record<path, FolderState>` (per-root selection/expansion already separated!), `folderAccessOrder`, top-level active sets swapped by `hydrateFolderState`. Persistence: `FILE_EXPLORER_STORAGE_KEY='file-explorer-storage-v4'`, `FILE_EXPLORER_STORAGE_VERSION=3` (persistence-constants.ts).
- Restore: use-restore-access.ts has `getAllRootHandles()` already feeding `storedFolders`; `beginRestore` (:384) re-grants ONE handle. Chrome 122+ batches multiple `requestPermission` calls from one gesture into a single prompt. Banner component: file-explorer-ui/src/components/restore-access-banner.tsx:32 (`folderName: string` prop).
- Toolbar: shell/file-explorer-toolbar.tsx:14 `select-root-button` → `onDirectorySelect` → `selectRootDirectory()` → `requestDirectoryAccess()`.
- Watchers: `adapter.watchDirectory` exists on both adapters but has NO production call site today (test mocks only) — phase 4 introduces the first one.
- Sync: provider reads `rootDirectoryHandle` from `useFileSystem()` (workspace-collection-sync-provider.tsx:289) and passes it in `service.sync({...})` (:683); `service.sync()` self-serializes via runId/abort.
- Adapter API (landed): `addRoot?(): Promise<RootDescriptor>`, `restoreRoots?(): Promise<RootDescriptor[]>` (`RootDescriptor` = displayName/handle/kind/permissionState/persisted/rootId).
- House rules: TDD; no `any`; never `git checkout` files you didn't author; pre-commit formats; sync from main bottom-up before the PR.

---

### Task 1: Store — active roots + version bump

**Files:**
- Modify: `packages/types/src/file-explorer-types.ts`, `packages/file-explorer/src/store.ts` (+ actions file if split), `packages/file-explorer/src/persistence/persistence-constants.ts`, persistence serialization if it enumerates fields
- Tests: extend `packages/file-explorer/src/__tests__/store.test.ts`; update `store-version-guard.test.ts`; persistence tests as needed

Contract:
- `FileExplorerData` gains `activeRootIds: string[]` (RootId strings; ordered = sidebar order) and `rootDescriptors: Record<string, StoredRootDescriptor>` where `StoredRootDescriptor = { displayName: string; path: string; rootId: string }` (a SERIALIZABLE projection — do NOT store the live handle; handles stay in `useFileSystem` state).
- Actions: `setActiveRoots(roots: StoredRootDescriptor[])` (replaces both fields atomically), `addActiveRoot(root: StoredRootDescriptor)` (append if absent by rootId).
- Both fields persist; `FILE_EXPLORER_STORAGE_VERSION` 3→4 (reset-on-load is the intended greenfield behavior — update the version guard test to pin 4 and assert the discard path).

TDD steps: failing store tests (set/add/dedupe-by-rootId/persist-roundtrip) → implement → whole `packages/file-explorer` suite green → commit `feat(file-explorer): active roots state + storage version 4` + trailer.

---

### Task 2: useFileSystem — multi-handle state + addRootDirectory

**Files:**
- Modify: `packages/file-explorer-hooks/src/use-file-system.ts`
- Tests: extend `packages/file-explorer-hooks/src/__tests__/use-file-system.test.ts`

Contract (backward-compatible — every existing consumer keeps working):
- Internal reducer keeps `rootDirectoryHandle` (the FOCUSED root) and gains `rootDirectoryHandles: DirectoryHandle[]` (all active, ordered) + `rootIdByPath: Map<string, string>` populated from descriptors.
- New `addRootDirectory(): Promise<void>` — calls `adapter.addRoot()` when available (else falls back to `requestDirectoryAccess()` wrapped into a synthetic descriptor with a crypto.randomUUID rootId and persisted:true), appends the handle, sets it as focused, calls the store's `addActiveRoot` + `setCurrentFolderId(handle.path)`.
- New `setFocusedRoot(path: string)` — switches `rootDirectoryHandle` to the matching handle + `setCurrentFolderId(path)` (no-op if unknown).
- Boot restore: where the auto-restore effect currently applies ONE restored folder, when `adapter.restoreRoots` exists use it to restore ALL granted roots (permissionState 'granted'): populate `rootDirectoryHandles`, focus the most-recently-used one (first in `folderAccessOrder` if present, else first descriptor), call `setActiveRoots(descriptors)`. Non-granted roots are left to the restore banner (Task 3). Keep the legacy single-root path intact when `restoreRoots` is absent.
- `selectRootDirectory` (legacy button path) now routes through `addRootDirectory`.

TDD: failing hook tests (addRootDirectory via addRoot; fallback path; restoreRoots boot populates handles+store; setFocusedRoot switches; legacy adapter unchanged) → implement → `pnpm vitest run` in file-explorer-hooks green → commit `feat(file-explorer-hooks): multi-root handles, addRootDirectory, restore-all boot` + trailer.

---

### Task 3: Restore banner — "Restore access to N folders"

**Files:**
- Modify: `packages/file-explorer-hooks/src/use-restore-access.ts`
- Modify: `packages/file-explorer-ui/src/components/restore-access-banner.tsx`
- Tests: `use-restore-access.test.tsx`, `restore-access-banner.test.tsx`

Contract:
- `beginRestore` iterates ALL stored handles needing re-grant (from `getAllRootHandles()` results with permission 'prompt'), calling `requestPermission({mode:'read'})` on each within the same click-handler tick (NO await between the permission calls' initiation — collect promises first, then await; Chrome batches one prompt). Each granted handle flows to the same per-handle restore path the single flow used (handle registration via the Task 2 multi-root setters — check what use-file-system exposes and wire through the existing context).
- Banner props: `folderName: string` → `folderNames: readonly string[]`; copy renders "Restore access to ${n} folders" when n>1, the single name when n===1. Update every banner render site.
- Denied/NotFound handling stays per-handle (one denied root must not abort the others — aggregate results, log per failure).

TDD: failing tests (N-handle re-grant in one gesture: all requestPermission calls initiated before any await; partial grant: granted ones restored, denied one logged and skipped; banner copy n===1 vs n>1) → implement → both packages' suites green → commit `feat(file-explorer): restore access to all folders in one prompt` + trailer.

---

### Task 4: Forest sidebar + Add Folder toolbar

**Files:**
- Modify: `packages/file-explorer-ui/src/shell/file-explorer-sidebar.tsx` (+ its context/props chain: use-file-explorer-context.ts, the panel shell that owns FileTreeProvider)
- Modify: `packages/file-explorer-ui/src/shell/file-explorer-toolbar.tsx`
- Create: `packages/file-explorer-ui/src/components/root-section-header.tsx` (folder displayName + chevron collapse for the whole section; no remove button in phase 4)
- Tests: extend `optimized-file-tree`/sidebar tests with a forest scenario; new root-section-header test; toolbar test update

Contract:
- Sidebar renders, for each handle in `rootDirectoryHandles` (Task 2): a `RootSectionHeader` + a `FileTreeProvider`-wrapped `OptimizedFileTree` for THAT handle (`folderId = handle.path`). One provider per root (Option A — stacked). Section collapse state is local component state (not persisted, phase 4).
- Interacting with a tree (row focus/selection) calls `setFocusedRoot(handle.path)` so `currentFolderId`/preview/token panes follow VS Code focus semantics. Wire via the existing selection/click handlers — find where row interaction dispatches into the store and add the focus switch there (report the exact site chosen).
- When `rootDirectoryHandles.length <= 1`, render EXACTLY today's single-tree layout (golden-path regression safety; assert in a test).
- Toolbar: button label "Add Folder" (keep `data-testid="select-root-button"` to avoid e2e churn — note this in a comment), wired to `addRootDirectory`.

TDD: forest test (two handles → two section headers + two trees; focus switch on interaction; single-root layout unchanged) → implement → file-explorer-ui suite green → commit `feat(file-explorer-ui): forest sidebar with root sections and Add Folder` + trailer.

---

### Task 5: Watcher lifecycle — Map<RootId, disposer>

**Files:**
- Create: `packages/file-explorer-hooks/src/use-file-system-watcher.ts` (hooks package so both shell layers can use it; it needs the adapter + handles, no DB)
- Modify: mount it where the file-explorer shell has adapter + active handles (use-file-explorer-context or the sidebar shell — pick the narrowest spot with both, report choice)
- Tests: new `use-file-system-watcher.test.ts`

Contract:
- Input: `{ adapter, roots: ReadonlyArray<{ rootId: string; handle: DirectoryHandle }>, onChanges: (rootId: string, changes: FileSystemChange[]) => void }`.
- Maintains `Map<rootId, disposer>`: diff on roots change — start watchers for added roots (`adapter.watchDirectory?.(handle, cb)`; absent method → no-op), dispose removed ones, dispose ALL on unmount. Keyed by rootId, never path.
- `onChanges` default wiring at the mount site: dispatch the existing `FILE_EXPLORER_REFRESH_EVENT` (find its constant/dispatch idiom and reuse) so refresh/sync piggyback on the existing pipeline.

TDD: failing tests (start per root; diff add/remove disposes correctly; unmount disposes all; adapter without watchDirectory no-ops) → implement + mount → suite green → commit `feat(file-explorer-hooks): per-root file watcher lifecycle` + trailer.

---

### Task 6: Sync provider — sequential per-root passes

**Files:**
- Modify: `packages/app-shell/src/background-indexing/workspace-collection-sync-provider.tsx`
- Tests: extend `workspace-collection-sync-provider.test.tsx`

Contract:
- The provider consumes the multi-root surface from `useFileSystem()` (Task 2): when `rootDirectoryHandles.length > 1`, `triggerSync` loops the handles SEQUENTIALLY, awaiting `service.sync({ ...request, rootDirectoryHandle: handle })` per root (the service's runId/abort self-serialization makes a sequential loop safe; do NOT parallelize). Single root → exactly today's behavior.
- Abort semantics: if a new triggerSync fires mid-loop, the service's own abort kills the in-flight pass; the OLD loop must stop iterating (guard each iteration on a loop-generation counter captured at loop start).
- `WorkspaceCollectionSyncRequest`/service internals unchanged.

TDD: failing provider tests (two handles → sync called twice, in order, sequentially; re-trigger mid-loop stops the stale loop; single handle unchanged) → implement → app-shell suite + tsconfig.test.json gate green → commit `feat(app-shell): sequential per-root sync passes` + trailer.

---

### Task 7: Sync from main, full verification, push + PR

- [ ] `git fetch origin`; bottom-up sync if main moved (watch migration numbers + lane registries; phases 1→2→3→4).
- [ ] `pnpm dlx ultracite fix` (expect no-op); suites green package-local in one run each: file-explorer, file-explorer-hooks, file-explorer-ui, app-shell (+ its tsconfig.test.json gate), ui, desktop (`pnpm test`), db (`pnpm test`); turbo build of the affected filter set; both db lane checks.
- [ ] Push `feat/multi-root-4-forest-ui`; PR base `feat/multi-root-3-queue-sync`, title `feat: multi-root phase 4 — forest sidebar and multi-root restore`; body: summary (stacked-trees design, single-active-root focus semantics, accepted same-name-web-roots display limitation, storage v4 reset, first watchDirectory production call site) + test plan with manual checks (add two folders → both trees render with headers; restore banner re-grants both in ONE Chrome prompt; rename a file in either root → refresh fires; switching trees switches the preview panel's root) + Generated-with-Claude-Code footer.

## Deferred (phase 5+)
- Cross-root selection + report generation; `folderStates`/token-cache/`SelectionQueryDescriptor` RootId re-keying; Remove Folder (cascade UX); single-merged-tree keyboard continuity; multi-root `WorkspaceCollectionSyncRequest` redesign; retiring `source_root_path` + the 029 index.
