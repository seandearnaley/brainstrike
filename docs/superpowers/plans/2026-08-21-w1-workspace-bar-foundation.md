# W1 — Workspace Bar Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the hidden, display-only `OperatingRootChip` with an always-visible composer **workspace bar** — a clickable Folder chip (this thread's primary + secondary folders, recent folders, Add folder…) and a read-only Branch chip (branch · detached · ahead/behind · dirty, desktop only) — backed by durable per-thread `secondaryRootIds` metadata and a main-owned recent-folders ledger that allows re-mounting a previously granted folder without the OS picker.

**Architecture:** Pure, prop-driven UI in `packages/assistant-ui` (`WorkspaceBar` → `FolderChip` + `BranchChip`), wired by one app-shell hook (`useWorkspaceBar`) that composes the existing thread root binding, thread metadata, the new recents bridge, and a git-status hook refreshed by the existing `changes:invalidated` push channel. Desktop main gains `fs:listRecentRoots` + `fs:addRootByPath` (previously-granted paths only) on the existing `electronAPI.fileSystem` surface; web omits them (capability absent, never stubbed).

**Tech Stack:** React 19, TypeScript strict, Radix DropdownMenu via `@brainstrike/ui`, zustand stores already in place, Electron IPC (`registry.registerInvoke`), Vitest + Testing Library, Playwright (desktop Electron fixture, web), Chrome DevTools MCP for live verification.

**Linear:** epic [BST-1387](https://linear.app/brainstrike/issue/BST-1387) → W1 [BST-1388](https://linear.app/brainstrike/issue/BST-1388) → tasks BST-1394 … BST-1398. **Spec:** `docs/superpowers/specs/2026-08-21-workspace-checkout-awareness-design.md` §4, §5.1, §5.5, §7.

## Global Constraints

- **Branching:** every task is its own branch `feat/bst-<ticket>-<slug>` created from (and PR'd into) `integration/workspace-checkout-awareness` via `gh stack` (Task N+1 branches from Task N). NEVER target `main`. Commit at every "Commit" step (small, conventional messages prefixed with the ticket: `feat(BST-1394): …`). End git commit messages with `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.
- **TDD:** every behavior lands RED → GREEN → commit. Run the named test file, confirm the exact failure, implement, rerun, then commit.
- **NO SILENT FALLBACKS:** malformed metadata throws; an unknown recent path is rejected with a visible error; a malformed bridge disables the feature with a logged error; web omits desktop-only chips.
- **Package gates before each PR:** `pnpm --filter <pkg> test`, `pnpm --filter <pkg> type-check` (or `pnpm run type-check` at root), `pnpm dlx ultracite fix` on touched files, `pnpm run react-doctor`. The 1500-line composition budget and the `assistant-ui-panel-architecture.test.ts` line budget are enforced — keep the panel diff minimal.
- **Desktop-only through capability, never `isElectron()`:** new renderer calls go through `FileSystemAdapter` optional methods and `useFileSystem()`; chips render only when the capability/data is present.
- **Docs in-band:** Task 5 updates `docs/agents/workspace-context.md` (MAIN vs FOCUSED section) and adds the new storage key to `docs/agents/platform-contracts.md`'s persistence list.
- **Naming:** kebab-case files; `use-*.ts` hooks; PascalCase components; `@brainstrike/utils/logger` / `@brainstrike/logging` `createLogger` for logs.
- **Deviation from spec §5.5 (recorded here):** recents are a **main-owned** storage ledger (`recentRootsList`), not `roots` rows, because the picker-less mount must be authorized by main and the `roots` table is renderer-owned. Spec §5.1's `checkoutMode/checkoutWorktreeId/checkoutWorktreePath/checkoutBranch/forgePrUrl` fields are deferred to W3/W4 where their producers land (YAGNI); W1 adds only `secondaryRootIds`.
- **Further deviations, recorded as built:**
  - **Web omits recents ENTIRELY** (not "names only", spec §12). Re-mounting a folder without a picker needs a main-authorized grant; the browser has no equivalent, and a name the user cannot act on is worse than no list. `listRecentRoots`/`addRootDirectoryByPath` are absent capabilities on web, so the hook returns no `recentRoots` and no `onAddRecent` — omit, don't stub.
  - **"Open in Terminal" (§4.1) and "Remove from recents" (§7) are deferred to W6 (BST-1393).** Both need surfaces W1 does not own: a terminal-session seam for the former, a main-side ledger mutation (plus its factory-reset and corruption story) for the latter.
  - **The bar is an app-shell-rendered SLOT, not a props object.** `AssistantUiPanel.workspaceBar` is a `ReactNode`; app-shell's `WorkspaceBarHost` (`packages/app-shell/src/workspace-bar/workspace-bar-host.tsx`) owns `useWorkspaceBar` and renders `<WorkspaceBar />`. Composing the props in `assistant-ui-panel-wrapper.tsx` put the bar's two live-refresh subscriptions in that ~1860-line component, so every git push re-rendered it. assistant-ui stays store-free either way.
  - **The working-tree refresh registration uses the file-explorer ADAPTER rootId, not the durable `roots.id`.** `window.git.status` speaks the DB space, but `use-changes-live-refresh.ts` maps `FILE_EXPLORER_REFRESH_EVENT` roots by adapter id; the two diverge for legacy path-matched roots, so registering the durable id left the dirty dot stale for exactly those. `useThreadCheckoutStatus` takes both ids, and the adapter id is derived by matching `rootDescriptors` on PATH — the only thing the two id spaces share. A primary that is not mounted here registers nothing and logs debug.

---

## File structure (what each unit owns)

| File | Responsibility |
| --- | --- |
| `packages/assistant-data/src/assistant-memory-repository.ts` (modify) | `AssistantThreadMetadata.secondaryRootIds`, allowlist, sanitizer, persistable assert |
| `apps/desktop/src/ipc-domains/workspace-root-registry.ts` (modify) | `recentRootsList` ledger (`recordRecentRoot`, `listRecentRoots`), `addRootByPath(path)` guarded by the ledger |
| `apps/desktop/src/platform/desktop-ipc-channels.ts`, `ipc-domains/file-system-ipc.ts`, `preload.ts`, `packages/types/src/electron-api.ts`, `apps/desktop/src/renderer/adapters.ts` (modify) | `fs:listRecentRoots`, `fs:addRootByPath` end to end |
| `packages/types/src/file-system.ts` (modify) | `FileSystemAdapter.listRecentRoots?` / `addRootByPath?` + `RecentRootEntry` |
| `packages/file-explorer-hooks/src/use-file-system.ts`, `packages/file-explorer-ui/src/shell/use-file-system-context.ts`, `use-file-explorer-context.ts` (modify) | `addRootDirectoryByPath`, `listRecentRoots` on the hook/context |
| `packages/assistant-ui/src/workspace-bar/workspace-bar.tsx` (create) | Row container + prop types |
| `packages/assistant-ui/src/workspace-bar/folder-chip.tsx` (create) | Folder chip + menu |
| `packages/assistant-ui/src/workspace-bar/branch-chip.tsx` (create) | Read-only branch chip |
| `packages/assistant-ui/src/operating-root-chip.tsx` (delete) | superseded |
| `packages/assistant-ui/src/assistant-ui-panel.tsx` (modify) | `operatingRoot` prop → `workspaceBar` prop; mount `<WorkspaceBar>` |
| `packages/app-shell/src/hooks/use-thread-checkout-status.ts` (create) | `window.git.status(rootId)` → `WorkspaceBarCheckout`, refetch on `anyInvalidationNonce` |
| `packages/app-shell/src/hooks/use-workspace-bar.ts` (create) | Composes binding + metadata + recents + actions into `WorkspaceBarProps` |
| `packages/app-shell/src/hooks/use-assistant-thread-root-binding.ts` (modify) | Remove the `activeRootCount >= 2` gate |
| `packages/app-shell/src/assistant-ui-panel-wrapper.tsx` (modify) | Pass `workspaceBar` |
| `apps/desktop/e2e/workspace-bar.desktop.test.ts`, `apps/web/e2e/workspace-bar.test.ts` (create) | E2E |

---

### Task 1: Thread metadata `secondaryRootIds` — BST-1394

**Branch:** `git checkout integration/workspace-checkout-awareness && git pull && git checkout -b feat/bst-1394-thread-secondary-root-ids`

**Files:**
- Modify: `packages/assistant-data/src/assistant-memory-repository.ts:86-99` (interface), `:1279-1290` (allowlist), `:1505-1566` (sanitizer), `:1567-1595` (persistable assert)
- Test: `packages/assistant-data/src/__tests__/assistant-memory-repository.integration.test.ts` (append next to the `'rejects an incomplete operating-root binding before persistence'` test at `:2091`)

**Interfaces:**
- Produces: `AssistantThreadMetadata.secondaryRootIds?: readonly string[]` (deduped, non-empty strings, order preserved). Rejects: non-array, empty string members, non-string members — error text `Invalid assistant thread metadata secondary root ids.`

- [ ] **Step 1: Write the failing tests**

Append inside the existing `describe` that contains the `'rejects an incomplete operating-root binding before persistence'` test (uses that file's `createMockDb`):

```ts
  it('persists and reloads secondaryRootIds as a deduped string array', async () => {
    const db = createMockDb();
    const repository = createPgliteAssistantThreadRepository(db as unknown as DbHandle);

    await repository.updateThreadMetadata('thread-1', {
      secondaryRootIds: ['db-root-b', 'db-root-c', 'db-root-b'],
    });

    const update = db.query.mock.calls.find(([sql]) => sql.includes('UPDATE mastra_threads'));
    expect(update).toBeDefined();
    const persisted = JSON.parse(String(update?.[1]?.[0])) as { secondaryRootIds?: unknown };
    expect(persisted.secondaryRootIds).toEqual(['db-root-b', 'db-root-c']);
  });

  it('rejects secondaryRootIds that are not an array of non-empty strings', async () => {
    const db = createMockDb();
    const repository = createPgliteAssistantThreadRepository(db as unknown as DbHandle);

    await expect(
      repository.updateThreadMetadata('thread-1', {
        secondaryRootIds: ['db-root-b', ''],
      })
    ).rejects.toThrow('Invalid assistant thread metadata secondary root ids.');
    await expect(
      repository.updateThreadMetadata('thread-1', {
        secondaryRootIds: 'db-root-b' as never,
      })
    ).rejects.toThrow('Invalid assistant thread metadata secondary root ids.');
    expect(db.query).not.toHaveBeenCalledWith(
      expect.stringContaining('UPDATE mastra_threads'),
      expect.anything()
    );
  });

  it('drops a malformed persisted secondaryRootIds while loading instead of coercing it', async () => {
    const db = createMockDb();
    db.query.mockImplementation(async (sql: string) => {
      if (!sql.includes('FROM mastra_threads')) {
        return { rows: [] };
      }
      return {
        rows: [
          {
            createdAt: new Date('2026-08-21T09:00:00Z'),
            id: 'thread-bad-secondaries',
            metadata: JSON.stringify({ secondaryRootIds: [42] }),
            resourceId: 'workspace-a',
            title: 'Bad secondaries',
            updatedAt: new Date('2026-08-21T09:00:00Z'),
          },
        ],
      };
    });
    const repository = createPgliteAssistantThreadRepository(db as unknown as DbHandle);

    await expect(repository.listThreads('workspace-a')).rejects.toThrow(
      'Invalid assistant thread metadata secondary root ids.'
    );
  });
```

> If `listThreads` is not the repository's list method name, use the same method the neighbouring `'rejects an incomplete operating-root binding while loading persisted metadata'` test calls — copy its call verbatim.

- [ ] **Step 2: Run to verify RED**

Run: `pnpm --filter @brainstrike/assistant-data exec vitest run src/__tests__/assistant-memory-repository.integration.test.ts -t "secondaryRootIds"`
Expected: 3 failures — first test: `Invalid assistant thread metadata key: secondaryRootIds.`; second: resolves instead of rejecting / wrong message; third: does not throw.

- [ ] **Step 3: Implement**

In `AssistantThreadMetadata` (after `providerOptions`):
```ts
  /**
   * Durable DB `roots.id` values of the thread's SECONDARY folders (the
   * primary is `operatingRootId`). Display + per-thread folder set only:
   * tool scope still follows the server's workspace-root inventory.
   */
  readonly secondaryRootIds?: readonly string[];
```
Add `'secondaryRootIds',` to `ASSISTANT_THREAD_METADATA_KEYS` (after `'providerOptions'`).

Add next to `optionalOperatingRootMetadataString`:
```ts
function optionalSecondaryRootIds(value: unknown): readonly string[] | undefined {
  if (value === undefined) {
    return;
  }
  if (!Array.isArray(value)) {
    throw new Error('Invalid assistant thread metadata secondary root ids.');
  }
  const ids: string[] = [];
  for (const entry of value) {
    if (typeof entry !== 'string' || entry.length === 0) {
      throw new Error('Invalid assistant thread metadata secondary root ids.');
    }
    if (!ids.includes(entry)) {
      ids.push(entry);
    }
  }
  return ids;
}
```
In `sanitizeThreadMetadata`, after `const source = optionalString(value['source']);` add `const secondaryRootIds = optionalSecondaryRootIds(value['secondaryRootIds']);` and before `if (providerOptions)` add:
```ts
  if (secondaryRootIds) {
    metadata.secondaryRootIds = secondaryRootIds;
  }
```
In `assertPersistableThreadMetadata`, after the `source` assertion add:
```ts
  if (metadata.secondaryRootIds !== undefined) {
    optionalSecondaryRootIds(metadata.secondaryRootIds);
  }
```
Make sure `MutableAssistantThreadMetadata` permits `secondaryRootIds` (it is the mutable mirror of the interface — add `secondaryRootIds?: readonly string[];` if it is a hand-written type rather than a mapped `-readonly` type). Persisting must write the DEDUPED array: in `updateThreadMetadata`, route the incoming metadata through `sanitizeThreadMetadata` before serialization if it is not already (check the existing code path at the `UPDATE mastra_threads` site; if it only asserts, add `const normalized = { ...metadata, ...(metadata.secondaryRootIds ? { secondaryRootIds: optionalSecondaryRootIds(metadata.secondaryRootIds) } : {}) };` and persist `normalized`).

- [ ] **Step 4: Run to verify GREEN**

Run: `pnpm --filter @brainstrike/assistant-data exec vitest run src/__tests__/assistant-memory-repository.integration.test.ts`
Expected: all pass (including the three new ones).

- [ ] **Step 5: Gate + commit**

```bash
pnpm --filter @brainstrike/assistant-data type-check && pnpm dlx ultracite fix packages/assistant-data/src/assistant-memory-repository.ts packages/assistant-data/src/__tests__/assistant-memory-repository.integration.test.ts
git add packages/assistant-data
git commit -m "feat(BST-1394): thread metadata secondaryRootIds (allowlist, sanitizer, persistable assert)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
gh stack push   # or: git push -u origin feat/bst-1394-thread-secondary-root-ids && gh pr create --base integration/workspace-checkout-awareness --fill
```

---

### Task 2: Recent folders ledger + `fs:addRootByPath` — BST-1395

**Branch:** `git checkout -b feat/bst-1395-recent-roots-add-by-path` (from Task 1's branch; stacked)

**Files:**
- Modify: `apps/desktop/src/ipc-domains/workspace-root-registry.ts` (storage keys `:34-38`, class `:252+`, `addRoot` `:312`, `restoreRoots` `:561`)
- Modify: `apps/desktop/src/platform/desktop-ipc-channels.ts:88-106` (`files.*`)
- Modify: `apps/desktop/src/ipc-domains/file-system-ipc.ts:585-600`
- Modify: `apps/desktop/src/preload.ts:37, 652`
- Modify: `packages/types/src/electron-api.ts:189-195`
- Modify: `packages/types/src/file-system.ts:320-335` (`FileSystemAdapter`)
- Modify: `apps/desktop/src/renderer/adapters.ts:199-203`
- Modify: `packages/file-explorer-hooks/src/use-file-system.ts:420-470, 795-825`
- Modify: `packages/file-explorer-ui/src/shell/use-file-system-context.ts:630`, `packages/file-explorer-ui/src/shell/use-file-explorer-context.ts:60, 247`
- Test: `apps/desktop/src/__tests__/ipc-domains/workspace-root-registry.test.ts` (existing file — locate with `ls apps/desktop/src/__tests__/ipc-domains/ | grep workspace-root-registry`; if it is an `.integration.test.ts`, append there), `apps/desktop/src/__tests__/preload-runtime-contract.test.ts` (channel constant pin), `packages/file-explorer-hooks/src/__tests__/use-file-system.test.ts` (existing)

**Interfaces:**
- Produces (types, `packages/types/src/file-system.ts`):
```ts
export interface RecentRootEntry {
  readonly displayName: string;
  readonly lastGrantedAt: number;
  readonly path: string;
}
// FileSystemAdapter (optional, desktop-only)
listRecentRoots?(): Promise<readonly RecentRootEntry[]>;
addRootByPath?(path: string): Promise<RootDescriptor>;
```
- Produces (`useFileSystem()` / file-explorer context): `listRecentRoots: (() => Promise<readonly RecentRootEntry[]>) | undefined`, `addRootDirectoryByPath: ((path: string) => Promise<DirectoryHandle | null>) | undefined` — both `undefined` when the adapter lacks the capability (web).
- Main registry: `recordRecentRoot(path)` (private, called by `addRoot`, `addRootByPath`, and per restored entry in `restoreRoots`), `listRecentRoots(): Promise<readonly RecentRootEntry[]>` (newest first, cap `RECENT_ROOTS_LIMIT = 20`, excludes nothing — the renderer filters out currently-mounted paths), `addRootByPath(path): Promise<RootDescriptor>` (throws `AccessError`-style `Error('Folder was never granted in this app; use Add Folder to grant it.')` when the normalized path is not in the ledger).
- Channels: `files.listRecentRoots: 'fs:listRecentRoots'`, `files.addRootByPath: 'fs:addRootByPath'`; preload constants `FILE_SYSTEM_LIST_RECENT_ROOTS_CHANNEL`, `FILE_SYSTEM_ADD_ROOT_BY_PATH_CHANNEL`.

- [ ] **Step 1: RED — registry ledger + addRootByPath**

In the existing registry test file (it already builds a registry with an in-memory storage stub and a fake `createSecureRoot`; reuse its helpers — read the top of that file and mirror its `createRegistry()` helper name), add:

```ts
describe('recent roots ledger + addRootByPath', () => {
  it('records every successful addRoot in recentRootsList, newest first, deduped, capped at 20', async () => {
    const { registry, storage } = createRegistry();
    await registry.addRoot(handleFor('/ws/alpha'));
    await registry.addRoot(handleFor('/ws/beta'));
    await registry.addRoot(handleFor('/ws/alpha'));
    const recents = await registry.listRecentRoots();
    expect(recents.map((r) => r.path)).toEqual(['/ws/alpha', '/ws/beta']);
    expect(recents[0]?.displayName).toBe('alpha');
    expect(JSON.parse((await storage.getItem('recentRootsList')) ?? '[]')).toHaveLength(2);
  });

  it('addRootByPath mounts a previously granted path without a picker and rejects an unknown one', async () => {
    const { registry } = createRegistry();
    await registry.addRoot(handleFor('/ws/alpha'));
    await registry.removeRoot((await registry.restoreRoots())[0]!.rootId);
    const descriptor = await registry.addRootByPath('/ws/alpha');
    expect(descriptor.handle.path).toBe('/ws/alpha');
    expect(descriptor.permissionState).toBe('granted');
    await expect(registry.addRootByPath('/ws/never')).rejects.toThrow(
      'Folder was never granted in this app; use Add Folder to grant it.'
    );
  });

  it('restoreRoots records restored entries as recents', async () => {
    const { registry, storage } = createRegistry();
    await storage.setItem(
      'rootsList',
      JSON.stringify([{ addedAt: 1, path: '/ws/gamma', rootId: 'r-gamma' }])
    );
    await registry.restoreRoots();
    expect((await registry.listRecentRoots()).map((r) => r.path)).toEqual(['/ws/gamma']);
  });
});
```
(`handleFor(path)` = `{ kind: 'directory', name: path.split('/').pop()!, path, platform: 'electron' }` — add this tiny helper if the file lacks one.)

Run: `pnpm --filter @brainstrike/desktop exec vitest run src/__tests__/ipc-domains/workspace-root-registry` → Expected: FAIL `registry.listRecentRoots is not a function`.

- [ ] **Step 2: GREEN — registry**

In `workspace-root-registry.ts`:
```ts
const RECENT_ROOTS_STORAGE_KEY = 'recentRootsList';
const RECENT_ROOTS_LIMIT = 20;

interface StoredRecentRoot {
  readonly lastGrantedAt: number;
  readonly path: string;
}

function parseStoredRecentRoots(raw: string | null): StoredRecentRoot[] {
  if (!raw) {
    return [];
  }
  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed)) {
    throw new Error('recentRootsList is not an array.');
  }
  return parsed.map((entry: unknown) => {
    if (
      typeof entry !== 'object' ||
      entry === null ||
      typeof (entry as StoredRecentRoot).path !== 'string' ||
      typeof (entry as StoredRecentRoot).lastGrantedAt !== 'number'
    ) {
      throw new Error('recentRootsList entry is malformed.');
    }
    return { lastGrantedAt: (entry as StoredRecentRoot).lastGrantedAt, path: (entry as StoredRecentRoot).path };
  });
}
```
Inside the class:
```ts
  private async readRecentRoots(): Promise<StoredRecentRoot[]> {
    return parseStoredRecentRoots(await this.storage.getItem(RECENT_ROOTS_STORAGE_KEY));
  }

  private async recordRecentRoot(presentationPath: string): Promise<void> {
    const normalized = path.normalize(presentationPath);
    const existing = (await this.readRecentRoots()).filter((entry) => !pathsEqual(entry.path, normalized));
    const next = [{ lastGrantedAt: Date.now(), path: normalized }, ...existing].slice(0, RECENT_ROOTS_LIMIT);
    await this.storage.setItem(RECENT_ROOTS_STORAGE_KEY, JSON.stringify(next));
  }

  listRecentRoots(): Promise<readonly RecentRootEntry[]> {
    return this.serializeMutation(async () =>
      (await this.readRecentRoots()).map((entry) => ({
        displayName: path.basename(entry.path),
        lastGrantedAt: entry.lastGrantedAt,
        path: entry.path,
      }))
    );
  }

  async addRootByPath(requestedPath: string): Promise<RootDescriptor> {
    const normalized = path.normalize(requestedPath);
    const granted = (await this.readRecentRoots()).some((entry) => pathsEqual(entry.path, normalized));
    if (!granted) {
      throw new Error('Folder was never granted in this app; use Add Folder to grant it.');
    }
    return this.addRoot({
      kind: 'directory',
      name: path.basename(normalized),
      path: normalized,
      platform: 'electron',
    });
  }
```
In `addRoot`, after `const persisted = await this.persistAddedRoot(entries, existing, entry);` succeeds (inside the same try, before returning), call `await this.recordRecentRoot(entry.path);`. In `restoreRoots`, after a successful `tryMountStoredEntry` (where `descriptors.push(descriptorFor(entry, 'granted'))` happens) call `await this.recordRecentRoot(entry.path);` (inside the already-serial loop; add a matching `// eslint-disable-next-line react-doctor/async-await-in-loop` comment mirroring the existing one). Import `RecentRootEntry` from `@brainstrike/types`.

Run the registry test → GREEN. Commit: `feat(BST-1395): main recent-roots ledger + addRootByPath guarded by prior grant`.

- [ ] **Step 3: RED — channel constants + preload pin**

`preload-runtime-contract.test.ts` has an `expectedConstants` map that pins channel string constants (see its first `it`). Add `FILE_SYSTEM_LIST_RECENT_ROOTS_CHANNEL: 'fs:listRecentRoots'` and `FILE_SYSTEM_ADD_ROOT_BY_PATH_CHANNEL: 'fs:addRootByPath'` entries to that map. Run: `pnpm --filter @brainstrike/desktop exec vitest run src/__tests__/preload-runtime-contract.test.ts` → FAIL (constants missing).

- [ ] **Step 4: GREEN — channels, IPC, preload, types, renderer adapter**

`desktop-ipc-channels.ts` `files`: add `addRootByPath: 'fs:addRootByPath',` and `listRecentRoots: 'fs:listRecentRoots',` (keep keys alphabetical).

`file-system-ipc.ts` next to the `files.addRoot` registration:
```ts
  registry.registerInvoke(
    'files',
    DESKTOP_IPC_CHANNELS.files.addRootByPath,
    async (_event, requestedPath: unknown) => {
      if (typeof requestedPath !== 'string' || requestedPath.length === 0) {
        throw new Error('fs:addRootByPath requires a non-empty path.');
      }
      return roots.addRootByPath(requestedPath);
    }
  );
  registry.registerInvoke('files', DESKTOP_IPC_CHANNELS.files.listRecentRoots, async () =>
    roots.listRecentRoots()
  );
```
`preload.ts`: add `const FILE_SYSTEM_LIST_RECENT_ROOTS_CHANNEL = 'fs:listRecentRoots' as const;` and `const FILE_SYSTEM_ADD_ROOT_BY_PATH_CHANNEL = 'fs:addRootByPath' as const;` beside line 37; in `fileSystem:` add
```ts
      addRootByPath: (path: string) => ipcRenderer.invoke(FILE_SYSTEM_ADD_ROOT_BY_PATH_CHANNEL, path),
      listRecentRoots: () => ipcRenderer.invoke(FILE_SYSTEM_LIST_RECENT_ROOTS_CHANNEL),
```
`packages/types/src/electron-api.ts` `ElectronFileSystemAPI`:
```ts
  /** Re-mount a PREVIOUSLY GRANTED folder (main's recent-roots ledger) without the OS picker. Rejects unknown paths. */
  addRootByPath: (path: string) => Promise<RootDescriptor>;
  /** Newest-first recent folders from main's ledger (cap 20). */
  listRecentRoots: () => Promise<readonly RecentRootEntry[]>;
```
`packages/types/src/file-system.ts`: add the `RecentRootEntry` interface (exported) and the two optional `FileSystemAdapter` methods from the Interfaces block above; export `RecentRootEntry` from the package index if exports are explicit.

`apps/desktop/src/renderer/adapters.ts` in `ElectronRendererFileSystemAdapter`:
```ts
  async addRootByPath(path: string): Promise<RootDescriptor> {
    return requireElectronAPI().fileSystem.addRootByPath(path);
  }

  async listRecentRoots(): Promise<readonly RecentRootEntry[]> {
    return requireElectronAPI().fileSystem.listRecentRoots();
  }
```
Run the preload contract test → GREEN. Run `pnpm --filter @brainstrike/desktop type-check` and `pnpm --filter @brainstrike/types type-check`. Commit: `feat(BST-1395): fs:addRootByPath + fs:listRecentRoots bridge (channels, preload, types, renderer adapter)`.

- [ ] **Step 5: RED — hook**

In `packages/file-explorer-hooks/src/__tests__/use-file-system.test.ts` (mirror the existing `addRootDirectory` test's adapter stub and `renderHook` wrapper):
```ts
  it('exposes addRootDirectoryByPath/listRecentRoots only when the adapter has them, and registers the root on success', async () => {
    const descriptor = {
      displayName: 'alpha',
      handle: { kind: 'directory', name: 'alpha', path: '/ws/alpha', platform: 'electron' },
      kind: 'path',
      permissionState: 'granted',
      persisted: true,
      rootId: 'root-alpha',
    } as const;
    const adapter = {
      ...createAdapterStub(),
      addRootByPath: vi.fn(async () => descriptor),
      listRecentRoots: vi.fn(async () => [{ displayName: 'alpha', lastGrantedAt: 1, path: '/ws/alpha' }]),
    };
    const addActiveRoot = vi.fn();
    const { result } = renderHook(() => useFileSystem({ ...baseArgs, addActiveRoot, fileSystemAdapter: adapter }));
    expect(result.current.addRootDirectoryByPath).toBeDefined();
    await act(async () => {
      await result.current.addRootDirectoryByPath?.('/ws/alpha');
    });
    expect(adapter.addRootByPath).toHaveBeenCalledWith('/ws/alpha');
    expect(addActiveRoot).toHaveBeenCalledWith({ displayName: 'alpha', path: '/ws/alpha', rootId: 'root-alpha' });
    expect(await result.current.listRecentRoots?.()).toEqual([{ displayName: 'alpha', lastGrantedAt: 1, path: '/ws/alpha' }]);

    const { result: webResult } = renderHook(() => useFileSystem({ ...baseArgs, fileSystemAdapter: createAdapterStub() }));
    expect(webResult.current.addRootDirectoryByPath).toBeUndefined();
    expect(webResult.current.listRecentRoots).toBeUndefined();
  });
```
(`createAdapterStub` / `baseArgs` = whatever the existing test file names its adapter factory and hook args — reuse them.) Run → FAIL `addRootDirectoryByPath` undefined.

- [ ] **Step 6: GREEN — hook + context**

In `use-file-system.ts` after `addRootDirectory`:
```ts
  const adapterAddRootByPath = (fileSystemAdapter as { addRootByPath?: (p: string) => Promise<RootDescriptor> }).addRootByPath;
  const adapterListRecentRoots = (fileSystemAdapter as { listRecentRoots?: () => Promise<readonly RecentRootEntry[]> }).listRecentRoots;

  /**
   * Desktop-only: re-mount a PREVIOUSLY GRANTED folder by path (main's recent
   * roots ledger authorizes it; unknown paths reject visibly). Same post-add
   * registration as addRootDirectory. `undefined` when the adapter lacks it.
   */
  const addRootDirectoryByPath = useMemo(() => {
    if (typeof adapterAddRootByPath !== 'function') {
      return;
    }
    return async (rootPath: string): Promise<DirectoryHandle | null> => {
      dispatch({ loading: true, type: 'setAccessLoading' });
      try {
        const { handle, rootId, displayName, persisted } = await adapterAddRootByPath.call(fileSystemAdapter, rootPath);
        dispatch({ handle, rootId, type: 'addOrFocusHandle' });
        updateCurrentFolderId(rootId);
        if (persisted) {
          addActiveRoot({ displayName, path: getCanonicalFolderId(handle), rootId });
        }
        return handle;
      } catch (error) {
        throw mapFileSystemError(error);
      } finally {
        dispatch({ loading: false, type: 'setAccessLoading' });
      }
    };
  }, [adapterAddRootByPath, addActiveRoot, fileSystemAdapter, updateCurrentFolderId]);

  const listRecentRoots = useMemo(() => {
    if (typeof adapterListRecentRoots !== 'function') {
      return;
    }
    return () => adapterListRecentRoots.call(fileSystemAdapter);
  }, [adapterListRecentRoots, fileSystemAdapter]);
```
Add both to the returned object (both places around `:799` and `:819`) and to the hook's return type. In `use-file-system-context.ts:630` pass `addRootDirectoryByPath: coreApi.addRootDirectoryByPath, listRecentRoots: coreApi.listRecentRoots,`; in `use-file-explorer-context.ts:60` add
```ts
  addRootDirectoryByPath: ((path: string) => Promise<DirectoryHandle | null>) | undefined;
  listRecentRoots: (() => Promise<readonly RecentRootEntry[]>) | undefined;
```
and thread them at `:247`. Run hook tests → GREEN; `pnpm --filter @brainstrike/file-explorer-hooks test`, `pnpm --filter @brainstrike/file-explorer-ui type-check`.

- [ ] **Step 7: Gate + commit + PR**

```bash
pnpm dlx ultracite fix $(git diff --name-only) && pnpm run type-check
git add -A && git commit -m "feat(BST-1395): addRootDirectoryByPath + listRecentRoots on useFileSystem (desktop capability, web omits)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
gh stack push
```

---

### Task 3: `WorkspaceBar` / `FolderChip` / `BranchChip` in assistant-ui — BST-1396

**Branch:** `git checkout -b feat/bst-1396-workspace-bar-ui` (stacked on Task 2)

**Files:**
- Create: `packages/assistant-ui/src/workspace-bar/workspace-bar.tsx`, `folder-chip.tsx`, `branch-chip.tsx`, `index.ts`
- Delete: `packages/assistant-ui/src/operating-root-chip.tsx`
- Modify: `packages/assistant-ui/src/assistant-ui-panel.tsx:400-405` (prop), `:900`, `:1096`, `:1160-1173`, `:1300-1305` (render); `packages/assistant-ui/src/index.ts` (export the bar types; remove `OperatingRootChip`/`OperatingRootInfo` exports if present)
- Modify: `packages/assistant-ui/src/__tests__/assistant-ui-panel-architecture.test.ts:84` (the chip pin) and the panel line budget comment if the diff moves it
- Test: `packages/assistant-ui/src/__tests__/workspace-bar.test.tsx` (create)

**Interfaces (produces — the contract Task 4 fills):**
```ts
// workspace-bar.tsx
export interface WorkspaceBarRoot {
  readonly displayName: string;
  readonly path?: string | undefined;
  readonly rootId: string;
}
export interface WorkspaceBarRecentRoot {
  readonly displayName: string;
  readonly path: string;
}
export interface WorkspaceBarCheckout {
  readonly ahead: number | null;
  readonly behind: number | null;
  /** null = detached HEAD */
  readonly branch: string | null;
  readonly dirty: boolean;
}
export interface WorkspaceBarProps {
  /** Desktop only — read-only git state for the primary root; undefined hides the chip. */
  readonly checkout?: WorkspaceBarCheckout | undefined;
  readonly onAddFolder: () => void;
  /** Present only when the platform can re-mount a recent folder without a picker (desktop). */
  readonly onAddRecent?: ((path: string) => void) | undefined;
  readonly onCopyPath?: ((path: string) => void) | undefined;
  readonly onMakePrimary: (rootId: string) => void;
  readonly onRemoveSecondary: (rootId: string) => void;
  readonly onRevealRoot?: ((path: string) => void) | undefined;
  /** undefined = no folder connected → the chip renders the "Choose a folder" CTA. */
  readonly primaryRoot?: WorkspaceBarRoot | undefined;
  readonly recentRoots: readonly WorkspaceBarRecentRoot[];
  readonly secondaryRoots: readonly WorkspaceBarRoot[];
}
export const WorkspaceBar: (props: WorkspaceBarProps) => ReactElement;
```
Test ids: `workspace-bar`, `workspace-bar-folder-chip`, `workspace-bar-branch-chip`, menu items `workspace-bar-add-folder`, `workspace-bar-recent-<path>`, `workspace-bar-make-primary-<rootId>`, `workspace-bar-remove-secondary-<rootId>`.

- [ ] **Step 1: RED — component tests**

`packages/assistant-ui/src/__tests__/workspace-bar.test.tsx`:
```tsx
import '@testing-library/jest-dom/vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { WorkspaceBar, type WorkspaceBarProps } from '../workspace-bar/workspace-bar';

function baseProps(overrides: Partial<WorkspaceBarProps> = {}): WorkspaceBarProps {
  return {
    onAddFolder: vi.fn(),
    onMakePrimary: vi.fn(),
    onRemoveSecondary: vi.fn(),
    primaryRoot: { displayName: 'brainstrike', path: '/ws/brainstrike', rootId: 'r-main' },
    recentRoots: [],
    secondaryRoots: [],
    ...overrides,
  };
}

describe('WorkspaceBar', () => {
  it('renders the primary folder name and a +N suffix for secondaries', () => {
    render(
      <WorkspaceBar
        {...baseProps({ secondaryRoots: [{ displayName: 'docs', rootId: 'r-docs' }, { displayName: 'site', rootId: 'r-site' }] })}
      />
    );
    const chip = screen.getByTestId('workspace-bar-folder-chip');
    expect(chip).toHaveTextContent('brainstrike');
    expect(chip).toHaveTextContent('+2');
    expect(chip).toHaveAttribute('title', '/ws/brainstrike');
  });

  it('renders a "Choose a folder" CTA with zero roots and calls onAddFolder from the menu', async () => {
    const onAddFolder = vi.fn();
    render(<WorkspaceBar {...baseProps({ onAddFolder, primaryRoot: undefined })} />);
    const chip = screen.getByTestId('workspace-bar-folder-chip');
    expect(chip).toHaveTextContent('Choose a folder');
    await userEvent.click(chip);
    await userEvent.click(await screen.findByTestId('workspace-bar-add-folder'));
    expect(onAddFolder).toHaveBeenCalledTimes(1);
  });

  it('lists recents only when onAddRecent is provided and calls it with the path', async () => {
    const onAddRecent = vi.fn();
    const { rerender } = render(
      <WorkspaceBar {...baseProps({ recentRoots: [{ displayName: 'alpha', path: '/ws/alpha' }] })} />
    );
    await userEvent.click(screen.getByTestId('workspace-bar-folder-chip'));
    expect(screen.queryByTestId('workspace-bar-recent-/ws/alpha')).not.toBeInTheDocument();
    await userEvent.keyboard('{Escape}');

    rerender(
      <WorkspaceBar {...baseProps({ onAddRecent, recentRoots: [{ displayName: 'alpha', path: '/ws/alpha' }] })} />
    );
    await userEvent.click(screen.getByTestId('workspace-bar-folder-chip'));
    await userEvent.click(await screen.findByTestId('workspace-bar-recent-/ws/alpha'));
    expect(onAddRecent).toHaveBeenCalledWith('/ws/alpha');
  });

  it('offers Make primary / Remove for a secondary and never Remove for the primary', async () => {
    const onMakePrimary = vi.fn();
    const onRemoveSecondary = vi.fn();
    render(
      <WorkspaceBar
        {...baseProps({ onMakePrimary, onRemoveSecondary, secondaryRoots: [{ displayName: 'docs', rootId: 'r-docs' }] })}
      />
    );
    await userEvent.click(screen.getByTestId('workspace-bar-folder-chip'));
    expect(screen.queryByTestId('workspace-bar-remove-secondary-r-main')).not.toBeInTheDocument();
    await userEvent.click(await screen.findByTestId('workspace-bar-make-primary-r-docs'));
    expect(onMakePrimary).toHaveBeenCalledWith('r-docs');
    await userEvent.click(screen.getByTestId('workspace-bar-folder-chip'));
    await userEvent.click(await screen.findByTestId('workspace-bar-remove-secondary-r-docs'));
    expect(onRemoveSecondary).toHaveBeenCalledWith('r-docs');
  });

  it('renders the branch chip states and hides it without checkout data', () => {
    const { rerender } = render(<WorkspaceBar {...baseProps()} />);
    expect(screen.queryByTestId('workspace-bar-branch-chip')).not.toBeInTheDocument();

    rerender(<WorkspaceBar {...baseProps({ checkout: { ahead: 2, behind: 0, branch: 'main', dirty: false } })} />);
    expect(screen.getByTestId('workspace-bar-branch-chip')).toHaveTextContent('main');
    expect(screen.getByTestId('workspace-bar-branch-chip')).toHaveTextContent('↑2');
    expect(screen.getByTestId('workspace-bar-branch-chip')).not.toHaveTextContent('↓');

    rerender(<WorkspaceBar {...baseProps({ checkout: { ahead: null, behind: null, branch: null, dirty: true } })} />);
    expect(screen.getByTestId('workspace-bar-branch-chip')).toHaveTextContent('detached');
    expect(screen.getByTestId('workspace-bar-branch-chip')).toHaveAttribute('data-dirty', 'true');
  });
});
```
Run: `pnpm --filter @brainstrike/assistant-ui exec vitest run --project unit src/__tests__/workspace-bar.test.tsx` → FAIL (module not found).

- [ ] **Step 2: GREEN — components**

`packages/assistant-ui/src/workspace-bar/branch-chip.tsx`:
```tsx
import { GitBranch } from 'lucide-react';
import type { ReactElement } from 'react';
import type { WorkspaceBarCheckout } from './workspace-bar';

/** Read-only git state for the primary root (W1). Interactive branch menu lands later. */
export const BranchChip = ({ checkout }: { readonly checkout: WorkspaceBarCheckout }): ReactElement => {
  const label = checkout.branch ?? 'detached';
  const ahead = checkout.ahead && checkout.ahead > 0 ? `↑${checkout.ahead}` : null;
  const behind = checkout.behind && checkout.behind > 0 ? `↓${checkout.behind}` : null;
  const title = [
    checkout.branch ? `On branch ${checkout.branch}` : 'Detached HEAD',
    ahead ? `${checkout.ahead} ahead` : null,
    behind ? `${checkout.behind} behind` : null,
    checkout.dirty ? 'uncommitted changes' : 'clean',
  ]
    .filter(Boolean)
    .join(' · ');
  return (
    <span
      className="inline-flex h-6 max-w-[14rem] items-center gap-1 rounded-full border border-border/70 bg-muted/40 px-2 font-mono text-[11px] text-muted-foreground"
      data-dirty={checkout.dirty ? 'true' : 'false'}
      data-testid="workspace-bar-branch-chip"
      title={title}
    >
      <GitBranch aria-hidden="true" className="size-3 shrink-0" />
      <span className="truncate">{label}</span>
      {ahead ? <span>{ahead}</span> : null}
      {behind ? <span>{behind}</span> : null}
      {checkout.dirty ? (
        <span aria-label="uncommitted changes" className="text-amber-600 dark:text-amber-400">
          ●
        </span>
      ) : null}
    </span>
  );
};
BranchChip.displayName = 'BranchChip';
```

`packages/assistant-ui/src/workspace-bar/folder-chip.tsx`:
```tsx
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@brainstrike/ui';
import { ChevronDown, Folder, FolderPlus, History, Star } from 'lucide-react';
import type { ReactElement } from 'react';
import type { WorkspaceBarProps } from './workspace-bar';

type FolderChipProps = Omit<WorkspaceBarProps, 'checkout'>;

export const FolderChip = ({
  onAddFolder,
  onAddRecent,
  onCopyPath,
  onMakePrimary,
  onRemoveSecondary,
  onRevealRoot,
  primaryRoot,
  recentRoots,
  secondaryRoots,
}: FolderChipProps): ReactElement => {
  const label = primaryRoot ? primaryRoot.displayName : 'Choose a folder';
  const suffix = primaryRoot && secondaryRoots.length > 0 ? `+${secondaryRoots.length}` : null;
  const visibleRecents = recentRoots.filter(
    (recent) =>
      recent.path !== primaryRoot?.path && !secondaryRoots.some((root) => root.path === recent.path)
  );
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-label={primaryRoot ? `Folder: ${primaryRoot.displayName}` : 'Choose a folder'}
        className="inline-flex h-6 max-w-[16rem] items-center gap-1 rounded-full border border-border/70 bg-muted/40 px-2 text-[11px] text-muted-foreground hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring data-[state=open]:bg-muted"
        data-testid="workspace-bar-folder-chip"
        {...(primaryRoot?.path ? { title: primaryRoot.path } : {})}
      >
        <Folder aria-hidden="true" className="size-3 shrink-0" />
        <span className="truncate">{label}</span>
        {suffix ? <span className="text-muted-foreground/80">{suffix}</span> : null}
        <ChevronDown aria-hidden="true" className="size-3 shrink-0 opacity-70" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-72">
        {primaryRoot ? (
          <>
            <DropdownMenuLabel className="text-[10px] uppercase tracking-wide text-muted-foreground">
              This thread
            </DropdownMenuLabel>
            <RootRow onCopyPath={onCopyPath} onRevealRoot={onRevealRoot} primary root={primaryRoot} />
            {secondaryRoots.map((root) => (
              <div className="flex items-center" key={root.rootId}>
                <RootRow onCopyPath={onCopyPath} onRevealRoot={onRevealRoot} primary={false} root={root} />
                <DropdownMenuItem
                  className="text-[11px]"
                  data-testid={`workspace-bar-make-primary-${root.rootId}`}
                  onSelect={() => onMakePrimary(root.rootId)}
                >
                  Make primary
                </DropdownMenuItem>
                <DropdownMenuItem
                  className="text-[11px]"
                  data-testid={`workspace-bar-remove-secondary-${root.rootId}`}
                  onSelect={() => onRemoveSecondary(root.rootId)}
                >
                  Remove
                </DropdownMenuItem>
              </div>
            ))}
            <DropdownMenuSeparator />
          </>
        ) : null}
        {onAddRecent && visibleRecents.length > 0 ? (
          <>
            <DropdownMenuLabel className="text-[10px] uppercase tracking-wide text-muted-foreground">
              Recent
            </DropdownMenuLabel>
            {visibleRecents.map((recent) => (
              <DropdownMenuItem
                data-testid={`workspace-bar-recent-${recent.path}`}
                key={recent.path}
                onSelect={() => onAddRecent(recent.path)}
                title={recent.path}
              >
                <History aria-hidden="true" className="mr-2 size-3.5" />
                <span className="truncate">{recent.displayName}</span>
              </DropdownMenuItem>
            ))}
            <DropdownMenuSeparator />
          </>
        ) : null}
        <DropdownMenuItem data-testid="workspace-bar-add-folder" onSelect={onAddFolder}>
          <FolderPlus aria-hidden="true" className="mr-2 size-3.5" />
          Add folder…
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
};
FolderChip.displayName = 'FolderChip';

const RootRow = ({
  onCopyPath,
  onRevealRoot,
  primary,
  root,
}: {
  readonly onCopyPath: FolderChipProps['onCopyPath'];
  readonly onRevealRoot: FolderChipProps['onRevealRoot'];
  readonly primary: boolean;
  readonly root: NonNullable<FolderChipProps['primaryRoot']>;
}): ReactElement => (
  <DropdownMenuItem
    className="flex-1 gap-2"
    data-testid={`workspace-bar-root-${root.rootId}`}
    onSelect={(event) => {
      // Row itself is informational; the explicit actions below do the work.
      event.preventDefault();
    }}
    {...(root.path ? { title: root.path } : {})}
  >
    {primary ? <Star aria-label="primary" className="size-3.5 fill-current" /> : <Folder aria-hidden="true" className="size-3.5" />}
    <span className="truncate">{root.displayName}</span>
    {root.path && onRevealRoot ? (
      <button
        aria-label={`Reveal ${root.displayName}`}
        className="ml-auto text-[10px] underline-offset-2 hover:underline"
        onClick={(event) => {
          event.stopPropagation();
          onRevealRoot(root.path as string);
        }}
        type="button"
      >
        Reveal
      </button>
    ) : null}
    {root.path && onCopyPath ? (
      <button
        aria-label={`Copy path of ${root.displayName}`}
        className="text-[10px] underline-offset-2 hover:underline"
        onClick={(event) => {
          event.stopPropagation();
          onCopyPath(root.path as string);
        }}
        type="button"
      >
        Copy path
      </button>
    ) : null}
  </DropdownMenuItem>
);
```
> Note for the implementer: the `secondaryRoots.map` block puts three menu items in a flex row so Make primary / Remove sit beside the name; if Radix roving focus proves awkward in the RTL test, switch to a `DropdownMenuSub` per secondary with the two actions as sub-items — keep the test ids identical.

`packages/assistant-ui/src/workspace-bar/workspace-bar.tsx`:
```tsx
import type { ReactElement } from 'react';
import { BranchChip } from './branch-chip';
import { FolderChip } from './folder-chip';

/* interfaces from the Interfaces block above go here, verbatim */

/**
 * The composer workspace bar: Folder chip (this thread's primary + secondary
 * folders, recents, Add folder…) and a read-only Branch chip (desktop). Always
 * rendered — its job is orientation, not disambiguation. Pure + prop-driven:
 * app-shell's useWorkspaceBar() supplies everything.
 */
export const WorkspaceBar = ({ checkout, ...folder }: WorkspaceBarProps): ReactElement => (
  <div className="flex flex-wrap items-center gap-1.5 px-1 pb-1" data-testid="workspace-bar">
    <FolderChip {...folder} />
    {checkout ? <BranchChip checkout={checkout} /> : null}
  </div>
);
WorkspaceBar.displayName = 'WorkspaceBar';
```
`index.ts` re-exports `WorkspaceBar` + the four types. Run the test → GREEN. Commit: `feat(BST-1396): WorkspaceBar / FolderChip / BranchChip (pure, prop-driven)`.

- [ ] **Step 3: RED — panel architecture pin**

In `assistant-ui-panel-architecture.test.ts`, change the `OperatingRootChip` sibling pin (line ≈84 and the assertion it supports) to assert `<WorkspaceBar` is mounted inside the `bs-composer-shell` block BEFORE `<ThreadContextMeter` and that `OperatingRootChip` no longer appears anywhere in the panel source. Run: `pnpm --filter @brainstrike/assistant-ui exec vitest run --project unit src/__tests__/assistant-ui-panel-architecture.test.ts` → FAIL.

- [ ] **Step 4: GREEN — panel swap**

In `assistant-ui-panel.tsx`: replace the `operatingRoot?: OperatingRootInfo;` prop (`:400-405`) with
```ts
  /**
   * Composer workspace bar (folder · branch). App-shell ALWAYS passes it when
   * the assistant is mounted in a workspace shell; absent = no bar (storybook /
   * bare embeds).
   */
  workspaceBar?: WorkspaceBarProps;
```
thread `workspaceBar` through the three spread sites that threaded `operatingRoot` (`:900`, `:1096`, `:1160-1173`), and replace the render at `:1300-1305` with
```tsx
            {workspaceBar ? <WorkspaceBar {...workspaceBar} /> : null}
```
Import `{ WorkspaceBar, type WorkspaceBarProps } from './workspace-bar/workspace-bar'`; delete `operating-root-chip.tsx` and its import/exports (`git rm`). Fix `packages/assistant-ui/src/index.ts` exports. Run the whole assistant-ui unit project: `pnpm --filter @brainstrike/assistant-ui test` → GREEN (update any snapshot/test that referenced `operating-root-chip`; grep `operating-root-chip` must be empty in `packages/`). `pnpm --filter @brainstrike/assistant-ui type-check`. App-shell will fail type-check until Task 4 — that is expected within the stack; do NOT stub.

- [ ] **Step 5: Gate + commit + PR**

```bash
pnpm dlx ultracite fix $(git diff --name-only --diff-filter=AM)
git add -A && git commit -m "feat(BST-1396): mount WorkspaceBar in the composer stack; retire OperatingRootChip

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
gh stack push
```

---

### Task 4: app-shell wiring — `useThreadCheckoutStatus` + `useWorkspaceBar` — BST-1397

**Branch:** `git checkout -b feat/bst-1397-use-workspace-bar` (stacked on Task 3)

**Files:**
- Create: `packages/app-shell/src/hooks/use-thread-checkout-status.ts`, `packages/app-shell/src/hooks/use-workspace-bar.ts`
- Modify: `packages/app-shell/src/hooks/use-assistant-thread-root-binding.ts:59-65` (drop the `activeRootCount >= 2` gate; keep `activeRootCount` arg unused-removal), `packages/app-shell/src/assistant-ui-panel-wrapper.tsx:487, 796-803, 1808`
- Test: `packages/app-shell/src/__tests__/use-thread-checkout-status.test.ts`, `packages/app-shell/src/__tests__/use-workspace-bar.test.tsx` (create); update `packages/app-shell/src/__tests__/use-assistant-thread-root-binding.test.ts` expectation (`operatingRoot` now defined at count 1)

**Interfaces:**
- Consumes: `WorkspaceBarProps`, `WorkspaceBarCheckout`, `WorkspaceBarRoot`, `WorkspaceBarRecentRoot` from `@brainstrike/assistant-ui`; `resolveGitBridge` from `../git-panel/git-bridge`; `useChangesLiveRefreshStore` + `useChangesLiveRefreshSubscription` from `../changes/...`; `useFileSystem` from `@brainstrike/file-explorer-ui/shell` (now exposing `addRootDirectory`, `addRootDirectoryByPath`, `listRecentRoots`); `useAssistantThreadRootBinding`; `resolveAssistantOperatingRootBinding` (`../assistant-operating-root`); `useAssistantThreadStore.updateThreadMetadata`; `resolvePlatformBridge` (`../platform-bridge`) for reveal; `useCopyToClipboard` (already used by the panel's action bar — `rg -n "useCopyToClipboard" packages/assistant-ui/src | head -1` for its import path).
- Produces: `useThreadCheckoutStatus(rootId: string | null): WorkspaceBarCheckout | undefined`; `useWorkspaceBar(args): WorkspaceBarProps`.

- [ ] **Step 1: RED — checkout status hook**

`packages/app-shell/src/__tests__/use-thread-checkout-status.test.ts`:
```ts
import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useChangesLiveRefreshStore } from '../changes/changes-live-refresh-store';
import { useThreadCheckoutStatus } from '../hooks/use-thread-checkout-status';

const status = vi.fn();
beforeEach(() => {
  useChangesLiveRefreshStore.getState().reset();
  (window as Window & { git?: unknown }).git = {
    aheadBehind: vi.fn(), commit: vi.fn(), commitFiles: vi.fn(), diff: vi.fn(), fetch: vi.fn(),
    history: vi.fn(), pull: vi.fn(), push: vi.fn(), repository: vi.fn(), stage: vi.fn(),
    status, structuredFileDiff: vi.fn(), switchBranch: vi.fn(), unstage: vi.fn(),
  };
});
afterEach(() => {
  delete (window as Window & { git?: unknown }).git;
  status.mockReset();
});

describe('useThreadCheckoutStatus', () => {
  it('maps git status to the bar checkout and refetches on an invalidation event', async () => {
    status.mockResolvedValueOnce({ ok: true, value: { ahead: 2, behind: 0, branch: 'main', clean: true, files: [], isRepository: true, upstream: 'origin/main' } });
    const { result } = renderHook(() => useThreadCheckoutStatus('root-a'));
    await waitFor(() => expect(result.current).toEqual({ ahead: 2, behind: 0, branch: 'main', dirty: false }));

    status.mockResolvedValueOnce({ ok: true, value: { ahead: null, behind: null, branch: null, clean: false, files: [{ path: 'a', staged: false, status: 'M', unstaged: true, untracked: false }], isRepository: true, upstream: null } });
    act(() => {
      useChangesLiveRefreshStore.getState().ingestInvalidation({ generation: 1, gitCommonDir: '/ws/a/.git', repositoryRoot: '/ws/a' });
    });
    await waitFor(() => expect(result.current).toEqual({ ahead: null, behind: null, branch: null, dirty: true }));
    expect(status).toHaveBeenCalledTimes(2);
  });

  it('returns undefined for a non-repository, a null root, and when the bridge is absent', async () => {
    status.mockResolvedValueOnce({ ok: true, value: { ahead: null, behind: null, branch: null, clean: true, files: [], isRepository: false, upstream: null } });
    const { result } = renderHook(() => useThreadCheckoutStatus('root-a'));
    await waitFor(() => expect(status).toHaveBeenCalledTimes(1));
    expect(result.current).toBeUndefined();

    const { result: nullRoot } = renderHook(() => useThreadCheckoutStatus(null));
    expect(nullRoot.current).toBeUndefined();

    delete (window as Window & { git?: unknown }).git;
    const { result: noBridge } = renderHook(() => useThreadCheckoutStatus('root-a'));
    expect(noBridge.current).toBeUndefined();
  });

  it('surfaces a failed status as undefined and logs — never a fake clean state', async () => {
    status.mockResolvedValueOnce({ ok: false, error: 'boom' });
    const { result } = renderHook(() => useThreadCheckoutStatus('root-a'));
    await waitFor(() => expect(status).toHaveBeenCalledTimes(1));
    expect(result.current).toBeUndefined();
  });
});
```
Run: `pnpm --filter @brainstrike/app-shell exec vitest run src/__tests__/use-thread-checkout-status.test.ts` → FAIL (module not found).

- [ ] **Step 2: GREEN — `use-thread-checkout-status.ts`**

```ts
import type { WorkspaceBarCheckout } from '@brainstrike/assistant-ui';
import { createLogger } from '@brainstrike/logging';
import { useEffect, useMemo, useState } from 'react';
import { useChangesLiveRefreshStore } from '../changes/changes-live-refresh-store';
import { useChangesLiveRefreshSubscription } from '../changes/use-changes-live-refresh';
import { resolveGitBridge } from '../git-panel/git-bridge';

const logger = createLogger('ThreadCheckoutStatus');

/**
 * Read-only git state for the workspace bar's Branch chip. Desktop only
 * (`window.git`); `undefined` = no chip (web, no root, not a repository, or a
 * failed status — a failure is logged and never rendered as "clean").
 * Refetches on every accepted `changes:invalidated` event (same nonce the
 * inventory uses) — no polling.
 */
export function useThreadCheckoutStatus(rootId: string | null): WorkspaceBarCheckout | undefined {
  const bridge = useMemo(() => resolveGitBridge(), []);
  useChangesLiveRefreshSubscription();
  const invalidationNonce = useChangesLiveRefreshStore((state) => state.anyInvalidationNonce);
  const [checkout, setCheckout] = useState<{ rootId: string; value: WorkspaceBarCheckout } | null>(null);

  useEffect(() => {
    if (!(bridge && rootId)) {
      setCheckout(null);
      return;
    }
    let cancelled = false;
    bridge
      .status(rootId)
      .then((result) => {
        if (cancelled) {
          return;
        }
        if (!result.ok) {
          logger.warn('git status for the workspace bar failed', { error: result.error, rootId });
          setCheckout(null);
          return;
        }
        if (!result.value.isRepository) {
          setCheckout(null);
          return;
        }
        setCheckout({
          rootId,
          value: {
            ahead: result.value.ahead,
            behind: result.value.behind,
            branch: result.value.branch,
            dirty: !result.value.clean,
          },
        });
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          logger.warn('git status for the workspace bar threw', { error, rootId });
          setCheckout(null);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [bridge, invalidationNonce, rootId]);

  return checkout?.rootId === rootId ? checkout.value : undefined;
}
```
Run → GREEN. Commit: `feat(BST-1397): useThreadCheckoutStatus (window.git status → bar checkout, invalidation-driven)`.

- [ ] **Step 3: RED — root binding gate removal**

In `use-assistant-thread-root-binding.test.ts` add:
```ts
  it('exposes operatingRoot for a single-root workspace (the bar is always visible)', () => {
    useAssistantThreadStore.setState({
      ...useAssistantThreadStore.getState(),
      threadsByResourceId: { [RESOURCE_ID]: [{ createdAt: new Date(), id: THREAD_ID, metadata: {}, resourceId: RESOURCE_ID, title: 't', updatedAt: new Date() }] },
    });
    const { result } = renderHook(() =>
      useAssistantThreadRootBinding({
        activeRootCount: 1,
        assistantThreadRepository: { updateThreadMetadata: vi.fn(async () => {}) } as unknown as AssistantThreadRepository,
        currentMainRoot: { displayName: 'Only', path: '/ws/only' },
        database: { query: vi.fn() } as unknown as DbHandle,
        memoryResourceId: RESOURCE_ID,
        selectedMemoryThreadId: THREAD_ID,
      })
    );
    expect(result.current.operatingRoot).toEqual({ displayName: 'Only', path: '/ws/only' });
  });
```
Run → FAIL (`undefined`). Then in the hook replace
```ts
  const operatingRoot =
    activeRootCount >= 2 && displayRootBinding
```
with
```ts
  const operatingRoot = displayRootBinding
```
and delete the now-unused `activeRootCount` argument from the hook's args interface, its destructuring, the test file's calls, and the wrapper call site (`:796-803`). Run → GREEN. Commit: `feat(BST-1397): show the thread's operating root at any root count`.

- [ ] **Step 4: RED — `useWorkspaceBar`**

`packages/app-shell/src/__tests__/use-workspace-bar.test.tsx` (renderHook with a small wrapper; mock `@brainstrike/file-explorer-ui/shell`'s `useFileSystem` via `vi.mock`, and `../hooks/use-thread-checkout-status`):
```tsx
import type { AssistantThreadRepository } from '@brainstrike/assistant-data';
import { useAssistantThreadStore } from '@brainstrike/assistant-data';
import type { DbHandle } from '@brainstrike/db/react';
import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const fs = {
  addRootDirectory: vi.fn(async () => ({ kind: 'directory', name: 'docs', path: '/ws/docs', platform: 'electron', rootId: 'r-docs' })),
  addRootDirectoryByPath: vi.fn(async (p: string) => ({ kind: 'directory', name: 'alpha', path: p, platform: 'electron', rootId: 'r-alpha' })),
  listRecentRoots: vi.fn(async () => [{ displayName: 'alpha', lastGrantedAt: 1, path: '/ws/alpha' }, { displayName: 'brainstrike', lastGrantedAt: 2, path: '/ws/brainstrike' }]),
  rootDirectoryHandles: [],
};
vi.mock('@brainstrike/file-explorer-ui/shell', () => ({ useFileSystem: () => fs }));
vi.mock('../hooks/use-thread-checkout-status', () => ({ useThreadCheckoutStatus: () => ({ ahead: 0, behind: 0, branch: 'main', dirty: false }) }));

import { useWorkspaceBar } from '../hooks/use-workspace-bar';

const RESOURCE_ID = 'workspace-a';
const THREAD_ID = 'thread-1';
const query = vi.fn(async (sql: string, params?: unknown[]) => {
  if (sql.includes('FROM roots') && sql.includes('= ANY')) {
    return { rows: (params?.[0] as string[]).map((id) => ({ display_name: id.replace('r-', ''), id, path: `/ws/${id.replace('r-', '')}` })) };
  }
  if (sql.includes('FROM roots')) {
    return { rows: [{ id: 'r-docs' }] };
  }
  return { rows: [] };
});
const updateThreadMetadata = vi.fn(async () => {});

function setup(metadata: Record<string, unknown> = {}) {
  useAssistantThreadStore.setState({
    ...useAssistantThreadStore.getState(),
    selectedThreadByResourceId: { [RESOURCE_ID]: THREAD_ID },
    threadsByResourceId: { [RESOURCE_ID]: [{ createdAt: new Date(), id: THREAD_ID, metadata, resourceId: RESOURCE_ID, title: 't', updatedAt: new Date() }] },
  });
  return renderHook(() =>
    useWorkspaceBar({
      assistantThreadRepository: { updateThreadMetadata } as unknown as AssistantThreadRepository,
      currentMainRoot: { displayName: 'brainstrike', path: '/ws/brainstrike' },
      database: { query } as unknown as DbHandle,
      memoryResourceId: RESOURCE_ID,
      rootDescriptors: { 'r-main': { displayName: 'brainstrike', path: '/ws/brainstrike', rootId: 'r-main' } },
      selectedMemoryThreadId: THREAD_ID,
    })
  );
}

beforeEach(() => {
  updateThreadMetadata.mockClear();
  fs.addRootDirectory.mockClear();
  fs.addRootDirectoryByPath.mockClear();
});

describe('useWorkspaceBar', () => {
  it('exposes the primary root, checkout, and recents minus the current roots', async () => {
    const { result } = setup();
    expect(result.current.primaryRoot).toEqual({ displayName: 'brainstrike', path: '/ws/brainstrike', rootId: 'r-main' });
    expect(result.current.checkout).toEqual({ ahead: 0, behind: 0, branch: 'main', dirty: false });
    await vi.waitFor(() => expect(result.current.recentRoots).toEqual([{ displayName: 'alpha', path: '/ws/alpha' }]));
    expect(result.current.onAddRecent).toBeDefined();
  });

  it('resolves secondaryRootIds to display rows from the roots table', async () => {
    const { result } = setup({ secondaryRootIds: ['r-docs'] });
    await vi.waitFor(() => expect(result.current.secondaryRoots).toEqual([{ displayName: 'docs', path: '/ws/docs', rootId: 'r-docs' }]));
  });

  it('Add folder adds globally and records the new root as a thread secondary', async () => {
    const { result } = setup();
    await act(async () => {
      result.current.onAddFolder();
    });
    await vi.waitFor(() => expect(updateThreadMetadata).toHaveBeenCalledWith(expect.anything(), RESOURCE_ID, THREAD_ID, { secondaryRootIds: ['r-docs'] }));
  });

  it('Make primary re-binds the thread (not global MAIN) and demotes the old primary to a secondary', async () => {
    const { result } = setup({ operatingRootDisplayName: 'brainstrike', operatingRootId: 'r-main', operatingRootPath: '/ws/brainstrike', secondaryRootIds: ['r-docs'] });
    await vi.waitFor(() => expect(result.current.secondaryRoots).toHaveLength(1));
    await act(async () => {
      result.current.onMakePrimary('r-docs');
    });
    await vi.waitFor(() =>
      expect(updateThreadMetadata).toHaveBeenCalledWith(expect.anything(), RESOURCE_ID, THREAD_ID, {
        operatingRootDisplayName: 'docs',
        operatingRootId: 'r-docs',
        operatingRootPath: '/ws/docs',
        secondaryRootIds: ['r-main'],
      })
    );
  });

  it('Remove secondary drops only that id', async () => {
    const { result } = setup({ secondaryRootIds: ['r-docs', 'r-site'] });
    await act(async () => {
      result.current.onRemoveSecondary('r-docs');
    });
    expect(updateThreadMetadata).toHaveBeenCalledWith(expect.anything(), RESOURCE_ID, THREAD_ID, { secondaryRootIds: ['r-site'] });
  });
});
```
Run: `pnpm --filter @brainstrike/app-shell exec vitest run src/__tests__/use-workspace-bar.test.tsx` → FAIL (module not found).

- [ ] **Step 5: GREEN — `use-workspace-bar.ts`**

```ts
import type { WorkspaceBarProps, WorkspaceBarRecentRoot, WorkspaceBarRoot } from '@brainstrike/assistant-ui';
import type { AssistantThreadRepository } from '@brainstrike/assistant-data';
import { useAssistantThreadStore } from '@brainstrike/assistant-data';
import type { DbHandle } from '@brainstrike/db/react';
import { useFileSystem } from '@brainstrike/file-explorer-ui/shell';
import { createLogger } from '@brainstrike/logging';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { type AssistantOperatingRootCandidate, resolveAssistantOperatingRootBinding } from '../assistant-operating-root';
import { resolvePlatformBridge } from '../platform-bridge';
import { useAssistantThreadRootBinding } from './use-assistant-thread-root-binding';
import { useThreadCheckoutStatus } from './use-thread-checkout-status';

const logger = createLogger('WorkspaceBar');

export interface UseWorkspaceBarArgs {
  readonly assistantThreadRepository: AssistantThreadRepository | null;
  readonly currentMainRoot?: AssistantOperatingRootCandidate | undefined;
  readonly database: DbHandle | null;
  readonly memoryResourceId: string;
  readonly rootDescriptors: Readonly<Record<string, { displayName: string; path: string; rootId: string }>> | undefined;
  readonly selectedMemoryThreadId: string | undefined;
}

interface RootRow {
  display_name: string;
  id: string;
  path: string | null;
}

/**
 * Everything the composer WorkspaceBar needs, from the thread's point of view.
 * PRIMARY = the thread's persisted operating-root binding, else the current
 * MAIN root (shown at ANY root count). SECONDARIES = metadata.secondaryRootIds
 * resolved against the `roots` table for display. RECENTS = main's ledger
 * (desktop) minus roots already in this thread. "Make primary" re-binds the
 * THREAD (server orders boundWorkspaceRootId first) — it never touches the
 * global MAIN root. Adding a folder adds it globally (existing flow) AND records
 * it as a secondary of this thread.
 */
export function useWorkspaceBar(args: UseWorkspaceBarArgs): WorkspaceBarProps {
  const { assistantThreadRepository, currentMainRoot, database, memoryResourceId, rootDescriptors, selectedMemoryThreadId } = args;
  const fileSystem = useFileSystem();
  const updateThreadMetadata = useAssistantThreadStore((state) => state.updateThreadMetadata);
  const thread = useAssistantThreadStore((state) =>
    selectedMemoryThreadId ? state.threadsByResourceId[memoryResourceId]?.find((t) => t.id === selectedMemoryThreadId) : undefined
  );
  const secondaryRootIds = useMemo(() => thread?.metadata?.secondaryRootIds ?? [], [thread?.metadata?.secondaryRootIds]);
  const { operatingRoot, threadRootBinding } = useAssistantThreadRootBinding({
    assistantThreadRepository,
    ...(currentMainRoot ? { currentMainRoot } : {}),
    database,
    memoryResourceId,
    selectedMemoryThreadId,
  });

  // Primary root id: the persisted binding's DB id, else the MAIN root's adapter id
  // (roots.id == adapter rootId wherever reconcileRoots established identity).
  const primaryRootId = threadRootBinding?.rootId ?? (currentMainRoot ? Object.values(rootDescriptors ?? {}).find((d) => d.path === currentMainRoot.path)?.rootId : undefined);
  const primaryRoot: WorkspaceBarRoot | undefined =
    operatingRoot && primaryRootId ? { displayName: operatingRoot.displayName, ...(operatingRoot.path ? { path: operatingRoot.path } : {}), rootId: primaryRootId } : undefined;

  const [secondaryRoots, setSecondaryRoots] = useState<readonly WorkspaceBarRoot[]>([]);
  useEffect(() => {
    if (!(database && secondaryRootIds.length > 0)) {
      setSecondaryRoots([]);
      return;
    }
    let cancelled = false;
    database
      .query<RootRow>(`SELECT id, display_name, path FROM roots WHERE id = ANY($1::text[])`, [secondaryRootIds])
      .then((result) => {
        if (cancelled) {
          return;
        }
        const byId = new Map(result.rows.map((row) => [row.id, row]));
        setSecondaryRoots(
          secondaryRootIds.flatMap((id) => {
            const row = byId.get(id);
            if (!row) {
              logger.warn('secondary root id has no roots row', { id });
              return [];
            }
            return [{ displayName: row.display_name, ...(row.path ? { path: row.path } : {}), rootId: row.id }];
          })
        );
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          logger.error('failed to load secondary roots', { error });
          setSecondaryRoots([]);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [database, secondaryRootIds]);

  const [recentRoots, setRecentRoots] = useState<readonly WorkspaceBarRecentRoot[]>([]);
  const listRecentRoots = fileSystem.listRecentRoots;
  const mountedPaths = useMemo(() => new Set(Object.values(rootDescriptors ?? {}).map((d) => d.path)), [rootDescriptors]);
  useEffect(() => {
    if (!listRecentRoots) {
      setRecentRoots([]);
      return;
    }
    let cancelled = false;
    listRecentRoots()
      .then((entries) => {
        if (!cancelled) {
          setRecentRoots(entries.filter((e) => !mountedPaths.has(e.path)).map((e) => ({ displayName: e.displayName, path: e.path })));
        }
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          logger.error('failed to list recent roots', { error });
          setRecentRoots([]);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [listRecentRoots, mountedPaths]);

  const writeSecondaries = useCallback(
    async (ids: readonly string[], extra: Record<string, string> = {}) => {
      if (!(assistantThreadRepository && selectedMemoryThreadId)) {
        throw new Error('Cannot update the thread folder set without an active thread.');
      }
      await updateThreadMetadata(assistantThreadRepository, memoryResourceId, selectedMemoryThreadId, { ...extra, secondaryRootIds: [...ids] });
    },
    [assistantThreadRepository, memoryResourceId, selectedMemoryThreadId, updateThreadMetadata]
  );

  const recordAddedAsSecondary = useCallback(
    async (handle: { name: string; path: string }) => {
      if (!database) {
        throw new Error('Cannot record a thread folder before the workspace database is ready.');
      }
      const resolved = await resolveAssistantOperatingRootBinding(database, { displayName: handle.name, path: handle.path });
      if (resolved.rootId === primaryRootId || secondaryRootIds.includes(resolved.rootId)) {
        return;
      }
      await writeSecondaries([...secondaryRootIds, resolved.rootId]);
    },
    [database, primaryRootId, secondaryRootIds, writeSecondaries]
  );

  const onAddFolder = useCallback(() => {
    const add = fileSystem.addRootDirectory;
    if (!add) {
      logger.error('addRootDirectory is unavailable in this shell');
      return;
    }
    add()
      .then((handle) => (handle ? recordAddedAsSecondary(handle) : undefined))
      .catch((error: unknown) => logger.error('Add folder failed', { error }));
  }, [fileSystem.addRootDirectory, recordAddedAsSecondary]);

  const addByPath = fileSystem.addRootDirectoryByPath;
  const onAddRecent = useMemo(() => {
    if (!addByPath) {
      return;
    }
    return (path: string) => {
      addByPath(path)
        .then((handle) => (handle ? recordAddedAsSecondary(handle) : undefined))
        .catch((error: unknown) => logger.error('Recent folder could not be re-mounted', { error, path }));
    };
  }, [addByPath, recordAddedAsSecondary]);

  const onMakePrimary = useCallback(
    (rootId: string) => {
      const next = secondaryRoots.find((r) => r.rootId === rootId);
      if (!(next && next.path)) {
        logger.error('Make primary: unknown secondary root', { rootId });
        return;
      }
      const demoted = primaryRootId && primaryRootId !== rootId ? [primaryRootId] : [];
      const remaining = secondaryRootIds.filter((id) => id !== rootId);
      // ONE metadata write: binding + secondaries together, so the store never
      // shows an intermediate state with the new primary still listed as a
      // secondary. (persistThreadRootBinding is the request-lifecycle seam; the
      // bar writes the same three operatingRoot* keys through the same store
      // action, which keeps the sanitizer's all-or-nothing rule satisfied.)
      writeSecondaries([...remaining, ...demoted], {
        operatingRootDisplayName: next.displayName,
        operatingRootId: rootId,
        operatingRootPath: next.path,
      }).catch((error: unknown) => logger.error('Make primary failed', { error, rootId }));
    },
    [primaryRootId, secondaryRootIds, secondaryRoots, writeSecondaries]
  );

  const onRemoveSecondary = useCallback(
    (rootId: string) => {
      writeSecondaries(secondaryRootIds.filter((id) => id !== rootId)).catch((error: unknown) =>
        logger.error('Remove secondary failed', { error, rootId })
      );
    },
    [secondaryRootIds, writeSecondaries]
  );

  const platform = useMemo(() => resolvePlatformBridge(), []);
  const onRevealRoot = useMemo(() => (platform ? (path: string) => void platform.showItemInFolder(path) : undefined), [platform]);
  const onCopyPath = useCallback((path: string) => {
    navigator.clipboard.writeText(path).catch((error: unknown) => logger.error('Copy path failed', { error }));
  }, []);

  const checkout = useThreadCheckoutStatus(primaryRootId ?? null);

  return {
    ...(checkout ? { checkout } : {}),
    onAddFolder,
    ...(onAddRecent ? { onAddRecent } : {}),
    onCopyPath,
    onMakePrimary,
    onRemoveSecondary,
    ...(onRevealRoot ? { onRevealRoot } : {}),
    ...(primaryRoot ? { primaryRoot } : {}),
    recentRoots,
    secondaryRoots,
  };
}
```
> Implementer notes: (1) `onMakePrimary` is ONE `updateThreadMetadata` write (binding keys + `secondaryRootIds`) — matches the test exactly. (2) `resolvePlatformBridge` / `showItemInFolder`: confirm the method name in `packages/app-shell/src/platform-bridge.ts` and use the exact one. (3) The `roots` table read uses `$1::text[]` — PGlite accepts a JS array param for `= ANY`.

Run → GREEN. Commit: `feat(BST-1397): useWorkspaceBar — primary/secondaries/recents/actions for the composer bar`.

- [ ] **Step 6: Wire the wrapper**

In `assistant-ui-panel-wrapper.tsx`: after the `useAssistantThreadRootBinding` call (keep it — the request lifecycle uses `resolveThreadRootBinding`/`persistThreadRootBinding`), add
```ts
  const workspaceBar = useWorkspaceBar({
    assistantThreadRepository,
    ...(mainRootId && rootDescriptors?.[mainRootId] ? { currentMainRoot: rootDescriptors[mainRootId] } : {}),
    database: db,
    memoryResourceId,
    rootDescriptors,
    selectedMemoryThreadId,
  });
```
and replace `{...(operatingRoot ? { operatingRoot } : {})}` at `:1808` with `workspaceBar={workspaceBar}`; drop `operatingRoot` from the destructure at `:796`. Because `useWorkspaceBar` calls `useAssistantThreadRootBinding` internally and the wrapper still calls it too, both read the same store — acceptable for W1 (pure selectors, no duplicated effects). Run `pnpm --filter @brainstrike/app-shell test` and `pnpm run type-check` (the whole stack now type-checks).

- [ ] **Step 7: Gate + commit + PR**

```bash
pnpm dlx ultracite fix $(git diff --name-only --diff-filter=AM) && pnpm run react-doctor
git add -A && git commit -m "feat(BST-1397): wire the workspace bar into the assistant panel wrapper

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
gh stack push
```

---

### Task 5: E2E (desktop + web), CDT verification, docs — BST-1398

**Branch:** `git checkout -b feat/bst-1398-workspace-bar-e2e-docs` (stacked on Task 4)

**Files:**
- Create: `apps/desktop/e2e/workspace-bar.desktop.test.ts`, `apps/web/e2e/workspace-bar.test.ts`
- Modify: `docs/agents/workspace-context.md:803-991` (MAIN vs FOCUSED section), `docs/agents/platform-contracts.md` (persistence list: `recentRootsList`), `apps/desktop/e2e/README.md` (test catalogue line)

- [ ] **Step 1: Desktop e2e (RED first — runs red until built app includes Tasks 1–4; that is expected)**

`apps/desktop/e2e/workspace-bar.desktop.test.ts` — mirror `git-panel.desktop.test.ts`'s `freshRepo`/`freshNonGitDir`/`seedRoot`/`trackDir` helpers verbatim (copy them; do not import across test files unless a shared helper already exists), then:
```ts
test.describe('Workspace bar (desktop)', () => {
  test('@smoke shows the folder chip for a SINGLE root and the branch chip for a git repo', async ({ window: page }) => {
    test.setTimeout(90_000);
    const repo = freshRepo('bar-repo');
    await seedRoot(page, repo);
    const folderChip = page.getByTestId('workspace-bar-folder-chip');
    await expect(folderChip).toBeVisible({ timeout: 30_000 });
    await expect(folderChip).toContainText(path.basename(repo));
    const branchChip = page.getByTestId('workspace-bar-branch-chip');
    await expect(branchChip).toBeVisible({ timeout: 30_000 });
    await expect(branchChip).toContainText('main');
    await expect(branchChip).toHaveAttribute('data-dirty', 'false');
  });

  test('hides the branch chip for a non-git folder', async ({ window: page }) => {
    test.setTimeout(90_000);
    await seedRoot(page, freshNonGitDir('bar-plain'));
    await expect(page.getByTestId('workspace-bar-folder-chip')).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId('workspace-bar-branch-chip')).toHaveCount(0);
  });

  test('re-mounts a recent folder from the chip without the OS picker and records it as +1', async ({ window: page }) => {
    test.setTimeout(120_000);
    const primary = freshRepo('bar-primary');
    const recent = freshNonGitDir('bar-recent');
    await seedRoot(page, primary);
    // Seed main's ledger directly (the path was "previously granted").
    await page.evaluate(async (p) => {
      const storage = (globalThis as typeof globalThis & { electronAPI?: { storage?: { setItem?: (k: string, v: string) => Promise<void> } } }).electronAPI?.storage;
      if (!storage?.setItem) { throw new Error('electronAPI.storage.setItem unavailable'); }
      await storage.setItem('recentRootsList', JSON.stringify([{ lastGrantedAt: 1, path: p }]));
    }, recent);
    const { reloadRenderer } = await loadElectronHelpers();
    await reloadRenderer(page, 'bar-recent-seed');
    await page.getByTestId('workspace-bar-folder-chip').click();
    await page.getByTestId(`workspace-bar-recent-${recent}`).click();
    await expect(page.getByTestId('workspace-bar-folder-chip')).toContainText('+1', { timeout: 30_000 });
    // The recent is now a mounted root (Explorer shows its section header).
    await expect(page.getByText(path.basename(recent)).first()).toBeVisible({ timeout: 30_000 });
  });
});
```
Run: `pnpm --filter @brainstrike/desktop e2e -- workspace-bar` (use the repo's documented desktop e2e command from `apps/desktop/e2e/README.md`). Expected: all three pass against the built app (if the Explorer header assertion is brittle, assert the `workspace-bar-root-<id>` row count inside the chip menu instead — keep the `+1` assertion).

- [ ] **Step 2: Web e2e**

`apps/web/e2e/workspace-bar.test.ts` — use the same fixture/page-object conventions as `apps/web/e2e/file-explorer.test.ts` (mock FSA adapter; find its "add root" helper name in `apps/web/e2e/page-objects/`):
```ts
test('folder chip shows the CTA with zero roots, then the root name after adding; no branch chip on web', async ({ page }) => {
  await page.goto('/');
  const chip = page.getByTestId('workspace-bar-folder-chip');
  await expect(chip).toContainText('Choose a folder');
  await chip.click();
  await page.getByTestId('workspace-bar-add-folder').click();   // mock adapter resolves a fixture root
  await expect(chip).not.toContainText('Choose a folder', { timeout: 15_000 });
  await expect(page.getByTestId('workspace-bar-branch-chip')).toHaveCount(0);
});
```
Build web first (`pnpm run build:web`) — web e2e serves `apps/web/dist`. Run the web e2e command from `apps/web/e2e/README.md` filtered to `workspace-bar`.

- [ ] **Step 3: CDT manual verification (sonnet subagent) — definition of done for UI**

Dispatch a `general-purpose` subagent with `model: sonnet` and this brief: start `pnpm --filter @brainstrike/desktop dev:agent-debug` (CDP on 9222; exclude `mode=` hidden-host pages when picking the page), open a workspace with one git root, and report **computed values** via `chrome-devtools` MCP: `getBoundingClientRect()` + `getComputedStyle()` (height 24px, font-size 11px, border-radius 9999px) of `[data-testid=workspace-bar-folder-chip]` and `-branch-chip`; the menu's `z-index` vs a Radix dialog (ui-conventions z-index ruling); `:focus-visible` ring on Tab; text is not truncated for a 20-char folder name; light + dark screenshots; then perform Add folder… (picker) and Make primary and confirm `mastra_threads.metadata` via `window` PGlite debug or the thread's expanded details. The subagent returns numbers + screenshot paths; attach them to the PR description.

- [ ] **Step 4: Docs**

`docs/agents/workspace-context.md` MAIN vs FOCUSED section: add a paragraph — "The composer **workspace bar** (`packages/assistant-ui/src/workspace-bar/`, wired by `packages/app-shell/src/hooks/use-workspace-bar.ts`) is ALWAYS visible (single-root included; BST-1396 removed the ≥2-roots gate). Its Folder chip shows the thread's PRIMARY (= persisted `operatingRootId`, else current MAIN) and `metadata.secondaryRootIds`; **Make primary re-binds the THREAD via `persistThreadRootBinding` and never changes the global MAIN root**; Add folder adds globally (existing flow) and records the root as a thread secondary. Recents come from main's `recentRootsList` ledger (`fs:listRecentRoots`); `fs:addRootByPath` re-mounts ONLY a path present in that ledger — the single sanctioned picker-less mount (BST-1395)." `docs/agents/platform-contracts.md`: add `recentRootsList` (desktop main storage; cleared by factory reset via `window.settings.clearAll()` — verify that path clears the storage keys, and if main storage keys need explicit listing, add it where `rootsList` is listed).

- [ ] **Step 5: Gate + commit + PR + integration merge order**

```bash
pnpm dlx ultracite fix $(git diff --name-only --diff-filter=AM)
git add -A && git commit -m "test(BST-1398): workspace bar desktop + web e2e; docs for the bar, recents ledger, addRootByPath

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
gh stack push
```
Merge bottom-up into `integration/workspace-checkout-awareness` (squash, after each PR's full gate is green and bot reviews are addressed with diff notes). Never merge to `main`.

---

## Self-review (done while writing)

- **Spec coverage (W1 row of §15):** always-visible FolderChip ✓ (T3/T4), recents ✓ (T2/T4), add ✓, primary/secondary ✓ (T1/T4), BranchChip read-only ✓ (T3/T4), metadata fields (scoped to `secondaryRootIds` — recorded deviation) ✓ (T1), recents query ✓ (ledger; recorded deviation), zero-root CTA ✓ (T3). Reveal/Copy path ✓ optional; "Open in Terminal" deferred to W6 (not in W1's row).
- **Type consistency:** `WorkspaceBarRoot{rootId,displayName,path?}`, `WorkspaceBarRecentRoot{displayName,path}`, `WorkspaceBarCheckout{ahead,behind,branch,dirty}`, `RecentRootEntry{displayName,lastGrantedAt,path}`, hook names `addRootDirectoryByPath` / `listRecentRoots`, test ids — used identically across T2–T5.
- **Placeholders:** none; where a neighbouring helper's exact name must be copied from the existing test file, the step says which file and which test to copy from.
