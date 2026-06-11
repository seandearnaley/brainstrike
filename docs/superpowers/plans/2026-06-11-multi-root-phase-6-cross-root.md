# Multi-Root Phase 6 — Cross-Root Selection, Cascade Delete, Citations Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
> **Session override (user directive 2026-06-11): execute linear inline, no subagents.**

**Goal:** Selections, imports, token budgets, and citations work across multiple roots simultaneously, and a root can be deleted together with its indexed data.

**Architecture:** Cross-root selection is a READ-level union in the selection manager (per-root `folderStates` stay the source of truth; the snapshot-on-focus-switch model is untouched). Write-backs partition composite keys by their rootId. Cascade delete reuses the FK `ON DELETE CASCADE` from migration 039 via one `DELETE FROM roots WHERE id = $1`, injected from app-shell (the layer that owns the db). Citations thread the rootId that the preview panel already decodes and currently drops.

**Tech Stack:** React 19, Zustand, PGlite, Vitest. Branch `feat/multi-root-6-cross-root` stacked on `feat/multi-root-5-root-identity`; ships as PR #6 (base #1191's branch).

**Explicitly deferred (NOT silently dropped):**
- `source_root_path` + 029-index retirement → its own post-merge cleanup PR. It is woven through 9+ production files including `root-registry.ts`'s legacy reconciliation; retiring it while the 5-PR stack is unmerged would churn every open review. Gate: the stack lands on main first.
- Snapshot tier (Safari/Firefox → OPFS import) + PWA install prompt → own plan (`2026-06-XX-multi-root-phase-7-snapshot-pwa.md`), per the roadmap's "Deferrable" marking. Still committed scope (locked decisions #4/#5).

**Key prior-art invariants (do not regress):**
- Linchpin equality: `fileNode.rootFolderId === folderId` (both RootId UUIDs since phase 5) — `packages/file-explorer-ui/src/use-shared-file-content-loading.ts` `isFileNodeValid`.
- Composite keys are `` `${rootId}|@|${relativePath}` `` (`encodeFileSelection`/`decodeFileSelection` in `@brainstrike/utils/selection-utils`).
- `IFileNode.rootFolderId` carries the node's OWN root identity (`packages/types/src/file-system.ts:45`) — stamped by every loader since phase 5.
- Disconnect ≠ delete (phase 5). Delete is the NEW deliberate destructive action; it must remain opt-in and confirmed.

---

### Task 1: Recursive-select uses the clicked node's root identity

The forest renders every root's tree, but `handleSelectFolderRecursively` resolves `folderId` from the FOCUSED root (`packages/file-explorer-ui/src/shell/file-explorer-panel.tsx:293-309`). Selecting a folder in a non-focused root's tree writes composite keys under the WRONG rootId. The node already knows its root.

**Files:**
- Modify: `packages/file-explorer-ui/src/shell/file-explorer-panel.tsx:293-309`
- Test: `packages/file-explorer-ui/src/__tests__/file-explorer-panel.test.tsx`

- [ ] **Step 1: Failing test** — in the panel test's existing harness, mock `useSelectionManager().selectFolderRecursively` with a `vi.fn()`, render with `rootIdByPath` mapping two roots (`/root` → `UUID_A`, `/other` → `UUID_B`) and focused handle `/root`; invoke the captured `onSelectFolderRecursively` (from the `FileExplorerSidebarMock`'s props) with a node `{ type: 'directory', path: 'sub', rootFolderId: UUID_B, ... }`; assert `selectFolderRecursively` received `folderId === UUID_B` (today it receives `UUID_A`).
- [ ] **Step 2: Run** `cd packages/file-explorer-ui && pnpm vitest run src/__tests__/file-explorer-panel.test.tsx` — expect the new test FAILS (receives `UUID_A`).
- [ ] **Step 3: Implement** — in `handleSelectFolderRecursively`:
```ts
// The node carries its own root identity (stamped by every tree loader since
// storage v5) — the focused root's id is WRONG for clicks in another root's
// tree. Fall back to the focused resolution for legacy nodes only.
const folderId =
  node.rootFolderId ||
  (getRootFolderId(rootDirectoryHandle, rootIdByPath) ?? currentFolderId ?? '');
```
(`selectedDescendantCount` below it already uses `folderId` — no other change.)
- [ ] **Step 4: Run the panel suite** — same command, all green.
- [ ] **Step 5: Commit** `fix(file-explorer-ui): recursive select attributes to the clicked node's root`

---

### Task 2: Union selection — non-focused roots' selections count

`useSelectionManager` (`packages/file-explorer-ui/src/shell/use-selection-manager-context.ts`) derives `effectiveSelection` from top-level `selectedFilePaths` (the FOCUSED root's mirror) in explicit mode. Selections saved in `folderStates[otherRootId]` are invisible to counters and import. Contract:

- **Explicit mode only.** `effectiveSelection = top-level selectedFilePaths ∪ folderStates[r].selectedFilePaths for every r in activeRootIds except currentFolderId` (the focused root's folderState is a STALE snapshot while focused — the top-level set is its live value; never union both for the same root).
- Query/rules modes stay exactly as they are (per-root, scoped to the focused root).
- `selectedCount`/`selectedFilesList` follow automatically (they read `effectiveSelection`).
- **Write-back partitioning:** `setSelectedFilesFromList(list)` must not funnel non-focused roots' keys into the focused top-level set. Partition by `decodeFileSelection(key).folderId`: focused keys (and legacy keys with no `|@|`) → `core.handleSelectionChange`; each non-focused root's subset → new store action `setFolderSelection(rootId, keys)`.
- `maxSelectionCount` applies to the UNION size (the core manager receives the focused set; guard the union in `setSelectedFilesFromList` before partitioning — over-limit → toast via existing `useToastManager` path in the core manager; follow how the core manager reports over-limit today).

**Files:**
- Modify: `packages/file-explorer/src/actions/folder-state-actions.ts` (new `setFolderSelection`), `packages/types/src/file-explorer-types.ts` (interface), `packages/file-explorer-ui/src/shell/use-selection-manager-context.ts`
- Test: `packages/file-explorer/src/__tests__/use-file-explorer-store.folder-state-actions.test.ts`, `packages/file-explorer-ui/src/__tests__/use-selection-manager-context.test.tsx` (create if absent — copy the harness from `use-file-explorer-context.test.ts`)

- [ ] **Step 1: Failing store test** — `setFolderSelection(ROOT_B, [keyB1, keyB2])` writes `folderStates[ROOT_B].selectedFilePaths` and its `selectionModel.explicitPaths` atomically WITHOUT touching top-level `selectedFilePaths` or `currentFolderId`; creating the folderState if absent (defaults from `setCurrentFolderId`'s reset shape).
- [ ] **Step 2: Run** `cd packages/file-explorer && pnpm vitest run src/__tests__/use-file-explorer-store.folder-state-actions.test.ts` — FAILS (action missing).
- [ ] **Step 3: Implement `setFolderSelection`** in `folder-state-actions.ts`:
```ts
setFolderSelection: (folderId: string, compositeKeys: readonly string[]) => {
  set((state: FileExplorerState) => {
    const existing = state.folderStates[folderId];
    const selected = new Set(compositeKeys);
    const base = existing ?? createDefaultFolderState(state); // reuse the reset-shape helper; extract one if inline today
    return {
      folderStates: {
        ...state.folderStates,
        [folderId]: {
          ...base,
          lastAccessed: Date.now(),
          selectedFilePaths: selected,
          selectionModel: { ...base.selectionModel, mode: 'explicit', explicitPaths: selected },
        },
      },
    };
  });
},
```
Register on the `FileExplorerState` interface next to `removeActiveRoot`.
- [ ] **Step 4: Store test green; run the full file-explorer suite.**
- [ ] **Step 5: Failing selection-manager test** — store seeded with `activeRootIds: [A, B]`, `currentFolderId: A`, top-level `selectedFilePaths: {A|@|x}`, `folderStates[B].selectedFilePaths: {B|@|y}`; assert `selectedCount === 2` and `selectedFilesList` contains both keys; then `setSelectedFilesFromList([A|@|x])` (deselecting B's file) → `folderStates[B].selectedFilePaths` is empty and top-level still `{A|@|x}`.
- [ ] **Step 6: Implement the union + partition** in `use-selection-manager-context.ts` (explicit branch of `effectiveSelection` + `setSelectedFilesFromList`); read `activeRootIds`/`folderStates` via `useFileExplorerStoreSelector` with `shallow`.
- [ ] **Step 7: Suites green** — file-explorer-ui full suite + type gates (`tsc --noEmit -p tsconfig.json && tsc --noEmit -p tsconfig.test.json`).
- [ ] **Step 8: Commit** `feat(file-explorer): selection union across active roots`

---

### Task 3: Import and token budget consume the union

**Step 0 decides the shape.** The import content loader resolves nodes via `useOptionalFileTreeIndexContext` keyed `(folderId, path)` with a focused-`fileTree` walk fallback (`use-shared-file-content-loading.ts:141-180`).

- [ ] **Step 1: Verify index sharing** — read `packages/file-explorer-ui/src/tree/file-tree-provider.tsx`: is the FileTreeIndex context a single instance above the forest (RootSections write into one index under their own rootId keys), or per-RootSection-provider? Run the existing index tests to confirm key shape.
  - If SHARED: nodes of every root resolve by `(rootId, path)` → no loader change; document this in a comment at the union site.
  - If PER-PROVIDER: lift a forest-wide index registration (provider writes `(rootId, path)` entries into a parent index context mounted in `file-explorer-provider.tsx`) — smallest change that makes the union resolvable; do NOT restructure providers.
- [ ] **Step 2: Failing integration test** (`packages/file-explorer-ui/src/__tests__/` — extend `same-named-roots.test.tsx`'s two-root harness): select one file in each of two roots, drive the shared content-loading path (`use-shared-file-content-loading` harness exists in its test file), assert BOTH files' contents load (linchpin holds per root).
- [ ] **Step 3: Implement whatever Step 1 dictated; test green.**
- [ ] **Step 4: Token meter** — selection token estimation reads `selectedFilesList` (verify in `packages/file-explorer-ui/src/selection-counter.tsx` + the token estimation hook it uses): with Task 2's union it aggregates automatically; add one assertion to the Task 2 selection-manager test pinning that the estimation input includes both roots' keys. No new wiring unless verification finds a focused-tree-only read — if found, fix at the read site, not by duplicating state.
- [ ] **Step 5: Suites + type gates green; commit** `feat(file-explorer-ui): import and token estimation across roots`

---

### Task 4: Cascade delete — "also delete indexed data"

Disconnect (phase 5) keeps DB rows. This adds the deliberate destructive variant using migration 039's `ON DELETE CASCADE`. Order matters: **delete DB rows FIRST, then run the existing disconnect flow** — if the DB delete fails, abort with a toast and leave the root connected (never disconnect-then-fail-delete, which orphans rows with no UI to retry).

**Files:**
- Modify: `packages/file-explorer-ui/src/components/disconnect-root-dialog.tsx` (checkbox), `packages/file-explorer-ui/src/shell/file-explorer-sidebar.tsx` (thread flag), `packages/file-explorer-ui/src/shell/file-explorer-panel.tsx` + `use-file-explorer-context.ts` + `use-file-system-context.ts` (optional `deleteRootData` seam), `packages/app-shell/src/root-layout-content.tsx` (provide the callback)
- Test: dialog test (new file `packages/file-explorer-ui/src/components/__tests__/disconnect-root-dialog.test.tsx`), sidebar test, app-shell callback test

- [ ] **Step 1: Failing dialog test** — renders a labeled checkbox `Also delete indexed data` (default unchecked); confirm fires `onConfirm({ deleteData: false })` by default and `{ deleteData: true }` when checked; body copy switches to state data WILL be deleted when checked.
- [ ] **Step 2: Implement dialog** — `onConfirm: (options: { deleteData: boolean }) => void`; checkbox via `@brainstrike/ui` `Checkbox` (grep for the existing labeled-checkbox pattern, e.g. in settings); destructive description swap.
- [ ] **Step 3: Thread the flag** — `RootSection.handleDisconnectConfirm(options)` → `onRemoveRoot(rootId, options)`; widen `FileExplorerSidebarProps.onRemoveRoot` and the context's `removeRootDirectory` to `(rootId: string, options?: { deleteData?: boolean })`.
- [ ] **Step 4: The db seam** — `use-file-system-context.ts`'s `removeRootDirectory` wrapper gains: when `options?.deleteData`, call an OPTIONAL injected `deleteRootData(rootId)` BEFORE the core disconnect; failure → toast (existing `useToastManager` import path) + `return` without disconnecting. Inject via a new optional prop on `FileExplorerProvider` (follow how `mockStorageAdapter`-style optional props flow today), provided from `packages/app-shell/src/root-layout-content.tsx`:
```ts
const deleteRootData = useCallback(
  async (rootId: string) => {
    if (!db) {
      throw new Error('Cannot delete root data: database is not ready.');
    }
    // Migration 039: file_records.root_id → roots.id ON DELETE CASCADE; chunks
    // cascade from file_records. Disconnect-without-delete stays the default.
    await db.query('DELETE FROM roots WHERE id = $1', [rootId]);
  },
  [db]
);
```
- [ ] **Step 5: Tests** — sidebar confirm-with-checkbox flow calls `onRemoveRoot(rootId, { deleteData: true })`; context wrapper test: deleteData failure → no disconnect (handles list unchanged) + toast; success → delete called BEFORE `removeActiveRoot`.
- [ ] **Step 6: Suites + type gates green (file-explorer-ui, file-explorer-hooks untouched, app-shell); commit** `feat(file-explorer): delete a root's indexed data on disconnect (opt-in)`

---

### Task 5: Citations carry rootId

The preview panel decodes `(folderId, path)` from each curated composite key (`packages/file-explorer-ui/src/preview/preview-panel.tsx:315`) and drops `folderId`. Thread it to the assistant so same-relative-path files from different roots are distinguishable.

**Files (BOTH metadata copies must change together — they are duplicate interfaces):**
- Modify: `packages/file-explorer-ui/src/workspace-context-curation-store.ts` (`WorkspaceContextCuratedFile` + snapshot builder), `packages/file-explorer-ui/src/preview/preview-panel.tsx` (populate), `packages/assistant-contract/src/runtime-data.ts:66` AND `packages/agent/src/types.ts:140` (`rootId?: string; rootDisplayName?: string`), `packages/app-shell/src/assistant-ui-panel-wrapper-runtime.ts` (pass-through is structural — verify, no code expected), the assistant context-files UI (find the consumer: grep `workspaceContext.files`/`RuntimeWorkspaceContextMetadata` rendering in `packages/ui/src/assistant-ui-panel/` — disambiguate there)
- Test: curation-store test, preview-panel test (snapshot includes rootId), consumer test (duplicate relative paths render with root prefix)

- [ ] **Step 1: Types first** — add to BOTH interfaces (identical):
```ts
/** Durable RootId of the file's root (multi-root); absent for legacy single-root snapshots. */
rootId?: string;
/** Display name of the root, for disambiguating same relative path across roots. */
rootDisplayName?: string;
```
And to `WorkspaceContextCuratedFile`. Type-check the workspace — the duplicate-interface sites must stay structurally identical (compile enforces at the assignment in `assistant-ui-panel-wrapper-runtime.ts:312`).
- [ ] **Step 2: Failing preview test** — curated snapshot for keys from two roots carries each file's `rootId` and `rootDisplayName` (from `rootDescriptors[rootId].displayName`, read via the file-explorer store selector already available in the preview panel; fall back to the rootId's first 8 chars when no descriptor).
- [ ] **Step 3: Populate** at the decode site (`preview-panel.tsx:315` area) — `decoded.folderId` IS the rootId.
- [ ] **Step 4: Consumer disambiguation** — in the context-files UI: when the rendered list contains ≥2 distinct `rootId`s, prefix each filename with `rootDisplayName` (e.g. `docs › notes.md`); single-root lists render unchanged. Failing test first (two files, same relative path, different rootIds → both rendered, distinct labels).
- [ ] **Step 5: Suites green** — file-explorer-ui, assistant-contract, agent (`pnpm --filter @brainstrike/agent test` — its types are compile-only here), app-shell, ui. Type gates for each.
- [ ] **Step 6: Commit** `feat(assistant): citations carry root identity across multi-root selections`

---

### Task 6: Ship

- [ ] `git fetch origin`; if main drifted, bottom-up stack sync (collision points: migration numbers, the shared `db-test-lane-manifest.mjs`).
- [ ] Full verification, one run each: `pnpm dlx ultracite check` on every touched file; suites for types, file-explorer, file-explorer-hooks, file-explorer-ui (+ both tsconfig gates), app-shell (+ test gate), ui, agent, assistant-contract, desktop, db (all lanes); `pnpm turbo run type-check`; `pnpm turbo run build --filter=@brainstrike/web --filter=@brainstrike/desktop`; both lane checks.
- [ ] Whole-branch self-review of `git diff feat/multi-root-5-root-identity...HEAD`: union never double-counts the focused root; write-back partition can't drop legacy (non-composite) keys; delete-before-disconnect ordering; both metadata interfaces identical.
- [ ] Update `docs/superpowers/plans/2026-06-09-multi-root-roadmap.md` status line + this plan's checkboxes; update memory.
- [ ] Push `feat/multi-root-6-cross-root`; PR base `feat/multi-root-5-root-identity`, title `feat: multi-root phase 6 — cross-root selection, cascade delete, citations`; body: summary + deferred items (source_root_path retirement post-merge; snapshot tier + PWA next plan) + test plan with manual checks (select in two roots → Import N counts both and imports both; disconnect with checkbox → rows gone, re-add re-indexes; two same-named files from different roots in assistant context → distinct labels) + Generated-with-Claude-Code footer.
