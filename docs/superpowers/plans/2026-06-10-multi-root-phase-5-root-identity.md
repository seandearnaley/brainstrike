# Multi-Root Phase 5: Root Identity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. **Implement ONLY the task you are dispatched for — stop after committing it.** Steps use checkbox (`- [ ]`) syntax.

**Goal:** Root identity becomes the durable RootId everywhere in the explorer (same-named web roots stop colliding), roots added mid-session get their DB row immediately, and roots can be disconnected from the UI.

**Scope (locked by the design dossier's dependency analysis):**
- **5a Re-keying:** `currentFolderId`/`folderStates`/`folderAccessOrder`/composite-key `folderId`/`IFileNode.rootFolderId`/`FileTreeIndex`/`SelectionQueryDescriptor.folderId` all carry the RootId UUID; paths remain paths everywhere else. Storage v5 greenfield reset.
- **5d Mid-session registration:** `registerRoot` on the reconciliation hook; new roots get their `roots` row + path-map entry at add time (no more `root_id = NULL` until reboot).
- **5c Disconnect-only removal:** forget handle/storage/store state + watcher, KEEP all DB rows (re-adding the same folder resumes without re-indexing). Full cascade delete is deliberately Phase 6 (irreversible; needs its own UX).
- **Deferred to Phase 6:** cross-root selection (requires this re-key), cascade delete, citations rootId, snapshot tier + PWA prompt.

**Tech Stack:** React 19, Zustand persist (v5 bump), Electron IPC, PGlite, Vitest.

**Context (verified by dossier — trust these file:line refs):**
- Composite keys: `encodeFileSelection(folderId, path)` → `"folderId|@|path"` (packages/utils/src/selection-utils.ts:11-36). Encoders: use-selection-manager-context.ts:72, use-selection-resolver.ts:366, use-background-token-indexer-integration.ts (~:1420). Decoders: use-shared-file-content-loading.ts:566 (validates `fileNode.rootFolderId === folderId` at :63 — the LINCHPIN equality; both sides must flip together), use-persistent-token-cache.ts:61,152,253,337.
- `IFileNode.rootFolderId` is populated from `rootHandle.path` inside `useFileTree`; `getRootFolderId(handle)` (file-explorer-ui/src/utils/get-root-folder-id.ts:7) returns `handle?.path`. `rootIdByPath: Map<path, RootId>` already exists on `useFileSystem` state (use-file-system.ts:46) — the identity source.
- `FileTreeProvider` clears `FileTreeIndex` keyed by `rootDirectoryHandle?.path` (file-tree-provider.tsx:132); `FileTreeIndex.getNode(folderId, path)`.
- Store: `folderStates` keys flow through folder-state-actions.ts:11-171 (`setCurrentFolderId` :122, `hydrateFolderState` :142) — the actions are key-agnostic strings; the re-key is about WHAT value flows in. Persistence: `FILE_EXPLORER_STORAGE_KEY='file-explorer-storage-v4'`, `FILE_EXPLORER_STORAGE_VERSION=4` (persistence-constants.ts); version mismatch discards (state-migration.ts:155-158).
- `SelectionQueryDescriptor` (packages/types/src/file-explorer-types.ts:20-33): `folderId` (becomes RootId) + `rootPath` (KEEP as the display/query path — recursive-selection-query uses it).
- Token cache: `file_token_cache.folder_id` is plain TEXT, no FK — NO db migration; greenfield hygiene wipe via `clearAll()` once on v5 first boot (dossier Option A). Writers/readers: drizzle/token-cache-store.ts:66-82, token-cache-context.tsx:144, use-persistent-token-cache.ts:171.
- Reconciliation: useRootsReconciliation (app-shell/src/roots/) — once-per-boot, settling promise; `reconcileRoots({adapterRoots, platformKind, query})` is already single-root-callable. `WorkspaceCollectionSyncProvider` has db + the useFileSystem surface — the registration mount site.
- Desktop IPC: `fs:addRoot`/`fs:restoreRoots` exist (file-system-ipc.ts:454+); **no removeRoot channel exists**. rootsList entries: `{addedAt, path, rootId}`. Web: `handleCache.removeRootHandle(folderId)` exists (web-handle-cache.ts interface :173) — folderId IS the RootId since phase 2.
- Cascade chain confirmed: roots → file_records (039 ON DELETE CASCADE) → file_chunks (004) — which is WHY phase 5 ships disconnect only. Token cache is NOT in the cascade (no FK) — disconnect calls `clearFolder(rootId)`.
- Destructive-dialog pattern to mirror: AlertDialog as used in packages/ui/src/prompt-management/prompt-manager.tsx (NOT window.confirm).
- House rules: TDD; no `any`; never `git checkout` files you didn't author; pre-commit formats; the ultracite plugin rejects `useEffect(() => () => {...})` curried cleanups — use a block body with a captured const; sync from main bottom-up before the PR.

---

### Task 1: Storage v5 + descriptor types (the contract flip)

**Files:** packages/file-explorer/src/persistence/persistence-constants.ts; packages/types/src/file-explorer-types.ts (doc comments only — `folderId`/`rootPath` types stay `string`); version-guard + migration-coverage tests.

Contract:
- `FILE_EXPLORER_STORAGE_KEY` → `'file-explorer-storage-v5'`; `FILE_EXPLORER_STORAGE_VERSION` → `5`. (Both change — key change makes stale v4 localStorage inert; version change keeps the internal guard honest.)
- `SelectionQueryDescriptor.folderId` doc comment: "RootId UUID (since storage v5); never a path". `rootPath` doc comment: "absolute root path for query scoping/display — NOT identity". Same doc treatment on `FileExplorerData.currentFolderId` and `folderStates`.
- Tests: version guard pins 5; migration coverage updates (5 valid, 6 future-rejected); legacy-key check — `'file-explorer-storage-v4'` data is simply never read (different key, no migration; assert nothing crashes with v4 junk present in localStorage).

TDD → implement → `cd packages/file-explorer && pnpm vitest run` green → commit `feat(file-explorer): storage v5 — folder identity becomes RootId` + trailer.

---

### Task 2: The re-key linchpin — rootFolderId/getRootFolderId/FileTreeIndex/composite flow

**Files:** packages/file-explorer-ui/src/utils/get-root-folder-id.ts; the `useFileTree` rootFolderId population site (find it in file-explorer-hooks/src/use-file-tree.ts); file-explorer-ui/src/tree/file-tree-provider.tsx; file-explorer-ui/src/shell/file-explorer-sidebar.tsx + panel + contexts that pass folderId; use-file-system.ts focus/current-id call sites; tests across both packages.

Contract (everything flips together in ONE commit — a split here breaks the linchpin equality):
- `getRootFolderId(handle, rootIdByPath)` returns `rootIdByPath.get(handle.path) ?? handle.path` — the path fallback covers handles that predate registration (legacy setRoot path) and MUST log debug when it fires (observability for missed identity, not silent).
- `useFileTree` populates `node.rootFolderId` with the SAME resolved RootId (thread the id in as an argument/option rather than re-deriving — one resolution point; report the threading route you choose).
- `useFileSystem`: `setCurrentFolderId`/`updateCurrentFolderId`/`setFocusedRoot`/`addRootDirectory`/`registerRestoredHandles`/boot-restore all write the RootId to the store (`currentFolderId`, `folderStates` keys, `folderAccessOrder`, `addActiveRoot` already takes rootId). `setFocusedRoot(path)` keeps its path PARAMETER (callers have handles) but resolves to rootId before touching the store.
- `FileTreeProvider`: index clearing + provider keying by rootId; `OptimizedFileTree`'s `folderId` prop receives the rootId; selection composite keys therefore carry rootId end-to-end; `use-shared-file-content-loading`'s `fileNode.rootFolderId === folderId` now compares rootId to rootId.
- `SelectionQueryDescriptor`: `folderId` set from rootId at the descriptor construction sites (file-selection-actions.ts:170-277 region); `rootPath` keeps receiving the path.
- Tests: update pinned fixtures across folder-state-actions/file-selection-actions/sidebar/file-tree-index/use-shared-file-content-loading suites — same-named-roots regression test NEW: two roots, same display name, different rootIds → distinct folderStates entries, distinct composite keys, both trees load content (the collision this whole phase kills).

TDD → implement → `cd packages/file-explorer-hooks && pnpm vitest run`, `cd packages/file-explorer && pnpm vitest run`, `cd packages/file-explorer-ui && pnpm vitest run && npx tsc --noEmit -p tsconfig.test.json` all green → commit `feat(file-explorer-ui): RootId flows through tree, index, and selection keys` + trailer.

---

### Task 3: Token cache v5 hygiene wipe

**Files:** packages/file-explorer-ui/src/indexing/token-cache-context.tsx (or the narrowest boot site with store access — report choice); its test.

Contract: once per profile after the v5 transition, `clearAll()` the token cache (old rows are keyed by paths — unreachable dead weight). Gate with a localStorage marker `'token-cache-rekey-v5-done'`; set AFTER the clear resolves; clear failure logs warn and does NOT set the marker (retries next boot — observable, not silent). No DB migration (TEXT column; both lane registries untouched).

TDD (marker absent → clearAll called once + marker set; marker present → no clear; clear rejects → warn + no marker) → implement → file-explorer-ui suite green → commit `chore(file-explorer-ui): one-time token cache wipe for RootId re-key` + trailer.

---

### Task 4: Mid-session root registration

**Files:** packages/app-shell/src/roots/use-roots-reconciliation.ts (+ its test); packages/app-shell/src/background-indexing/workspace-collection-sync-provider.tsx (+ its test).

Contract:
- The hook keeps the settling promise for boot, but the resolved map is held in a `pathMapRef` so it can grow. New exposed callback `registerRoot(descriptor: RootDescriptor): Promise<void>` — ref-stable; awaits the boot settle first (ordering: boot reconcile wins races), skips unregistrable descriptors (persisted:false / permissionState 'unknown' — same filter as reconcileRoots), calls `reconcileRoots({adapterRoots: [descriptor], ...})`, merges the returned mapping into `pathMapRef.current`. `resolveDbRootId` reads through the ref so later imports see the new root immediately.
- Provider wiring: when `rootDirectoryHandles` grows, register descriptors for the NEW handles. The handles array lacks descriptors — get them from the useFileSystem surface (check what it exposes; `rootIdByPath` + handle gives `{rootId, path, displayName: handle.name}`; kind from adapter.platform; persisted is the open question — if the surface doesn't expose per-root persisted state, construct with persisted:true ONLY for handles that came through addRoot/restore (they did — both paths persist) and document that reasoning in a comment; report what you found).
- Effect must not re-register boot roots (track a registered-ids ref seeded by the boot reconcile result).
- Tests: hook — registerRoot adds a mapping visible via resolveDbRootId + issues exactly one INSERT for a new path + skips unregistrable; provider — handle added mid-session → registerRoot called once for it, not for pre-existing ones.

TDD → implement → app-shell suite + tsconfig.test.json gate green → commit `feat(app-shell): register roots in the DB at add time` + trailer.

---

### Task 5: Disconnect a root

**Files:** apps/desktop/src/platform/desktop-ipc-channels.ts + ipc-domains/file-system-ipc.ts + preload.ts + renderer/adapters.ts (+ IPC tests); packages/types/src/file-system.ts (`removeRoot?(rootId: string): Promise<void>` optional adapter method) + electron-api.ts; packages/file-system web adapter (`removeRoot` → `handleCache.removeRootHandle(rootId)`); packages/file-explorer/src/actions/active-root-actions.ts (`removeActiveRoot`); packages/file-explorer-hooks/src/use-file-system.ts (`removeRootDirectory(rootId)`); packages/file-explorer-ui root-section-header.tsx + sidebar wiring + AlertDialog; token cache clearFolder call; tests throughout.

Contract:
- **Adapter:** new optional `removeRoot?(rootId)` — desktop: new `fs:removeRoot` channel (filter rootsList by rootId, write back; also clear lastFolderPath if it matches the removed root's path — keep the dual stores coherent); web: `removeRootHandle(rootId)` (+ remove from in-memory state). NEVER touches the DB (disconnect ≠ delete; comment this).
- **Store:** `removeActiveRoot(rootId)` purges activeRootIds/rootDescriptors/folderStates[rootId]/folderAccessOrder atomically.
- **Hook:** `removeRootDirectory(rootId)`: adapter.removeRoot best-effort (warn on failure, proceed — the UI state must win), dispatch handle removal from `rootDirectoryHandles` (new reducer action `removeHandle`), `removeActiveRoot`, token `clearFolder(rootId)` (via the context that owns the store — find the seam, report it), focus shift: if the removed root was focused → focus the first remaining (or null/clear when empty). Watchers tear down automatically via the existing watcherRoots diff — add a test pinning that.
- **UI:** `RootSectionHeader` gains a remove (X) icon button (aria-label "Disconnect folder") → AlertDialog (mirror prompt-manager.tsx's pattern): title "Disconnect {name}?", body explicitly states indexed data is KEPT and the folder can be re-added, confirm → `removeRootDirectory(rootId)`. Single-root mode (no headers) unaffected.
- Tests: IPC handler (removes matching entry, leaves others, clears matching lastFolderPath); store action atomic purge + focus-shift; hook orchestration incl. adapter-failure-proceeds; header dialog confirm/cancel flows; watcher teardown on shrink.

TDD → implement → suites green: desktop ipc-domains, file-system, file-explorer, file-explorer-hooks, file-explorer-ui → commit `feat(file-explorer): disconnect roots from the forest` + trailer.

---

### Task 6: Ship

- [ ] `git fetch origin`; bottom-up main sync if drifted (migration numbers + lane registries are the collision points).
- [ ] Full verification: ultracite fix/check; suites package-local in one run each (types, file-explorer, file-explorer-hooks, file-explorer-ui + test-tsc, app-shell + test-tsc, ui, desktop `pnpm test`, db `pnpm test`); turbo build web+desktop; both db lane checks.
- [ ] Final whole-branch review (fresh reviewer, full diff vs phase 4) — fix anything Critical/Important before push.
- [ ] Push `feat/multi-root-5-root-identity`; PR base `feat/multi-root-4-forest-ui`, title `feat: multi-root phase 5 — durable root identity and disconnect`; body: summary (re-key + registration + disconnect, deferred items), test plan incl. manual checks (two same-named web folders → both trees independent; add folder mid-session → import rows carry root_id immediately; disconnect → folder gone, re-add → instantly indexed) + Generated-with-Claude-Code footer.

## Deferred (Phase 6)
Cross-root selection + token budget aggregation; cascade DELETE UX; citations rootId (+ packages/agent/src/types.ts duplicate interface — both must change together); snapshot tier (Safari/Firefox OPFS import) + PWA install prompt; retiring source_root_path + the 029 index.
