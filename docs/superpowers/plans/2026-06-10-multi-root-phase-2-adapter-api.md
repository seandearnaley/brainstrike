# Multi-Root Phase 2: Adapter API Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the file-system adapter layer multi-root native — `addRoot()`/`restoreRoots()` with durable RootIds — while the UI stays single-active-root and every existing consumer keeps working unchanged.

**Architecture:** Additive, behind the existing `FileSystemAdapter` seam. (1) New `RootDescriptor` type + optional `addRoot?()`/`restoreRoots?()` methods. (2) Web: IndexedDB handle store re-keyed from `handle.name` (collides!) to generated RootIds via a v1→v2 upgrade; `requestDirectoryAccess` becomes a shim over `addRoot`. (3) Desktop: new `rootsList` storage key (JSON array) + `fs:addRoot`/`fs:restoreRoots` IPC channels; legacy `lastFolderPath` migrates on first restore. (4) A root registry in app-shell reconciles `kind:'legacy'` DB rows to the platform kind and maps adapter RootIds ↔ DB root ids by path-match — **no id re-keying across layers**; DB `roots.id` is canonical, new roots share one id because the registry inserts the adapter's RootId.

**Explicitly deferred (per design dossier):** `file_token_cache.folder_id` and Zustand `folderStates` keys keep today's `handle.name`/path semantics (Phase 3/4). `currentFolderId` stays `handle.path`. Import-pipeline `root_id` writes are Phase 3.

**Tech Stack:** TypeScript strict, idb (IndexedDB), Electron IPC, Vitest (fake-indexeddb for cache tests), PGlite.

**Context for the engineer (verified facts from the design dossier):**
- `FileSystemAdapter` lives at `packages/types/src/file-system.ts:209-299`; `requestDirectoryAccess()` is required, `restoreLastFolder?()` optional.
- Web adapter (`packages/file-system/src/adapters/web-adapter.ts`): `requestDirectoryAccess` stores the handle keyed by `dirHandle.name` (line 216) and sets `lastRootFolderId = dirHandle.name`. `resolveRootFolderId` (lines 178-192) prefers `lastRootFolderId` whenever set — opaque ids degrade gracefully; first-segment fallback only fires when `lastRootFolderId` is null (acceptable best-effort cache miss).
- Handle cache (`packages/file-system/src/adapters/web-handle-cache.ts`): `DB_NAME='brainstrike-file-handles'`, `DB_VERSION=1`, stores `root-handles` (keyPath `folderId`, index `by-last-accessed`) and `file-handles` (keyPath `path`, index `by-folder`). Upgrade callback at lines 280-295; a corrupted-store recovery path at lines 297-334 deletes and recreates the DB.
- `use-restore-access.ts:214-216` validates `storedFolderId === rawHandle.name` and **cleans up the handle on mismatch** — with UUID keys this would delete every stored root; it MUST be updated in the same task that re-keys.
- Desktop: channels declared in `apps/desktop/src/platform/desktop-ipc-channels.ts` (files.* at lines 31-39); the sandboxed preload (`apps/desktop/src/preload.ts`) duplicates channel strings as local consts — keep both in sync manually. `LAST_FOLDER_STORAGE_KEY = 'lastFolderPath'` at `file-system-ipc.ts:36`; storage is a flat JSON-file `ElectronStorageAdapter`. `ElectronRendererFileSystemAdapter` (`apps/desktop/src/renderer/adapters.ts`) calls `api.saveLastFolder(handle.path)` inside `requestDirectoryAccess` (lines 16-21).
- `packages/file-system` has NO `@brainstrike/db` dependency and must stay that way. The one place with both adapter and DB is `packages/app-shell/src/background-indexing/workspace-collection-sync-provider.tsx` (`useAdapters()` + `usePGliteDatabase()`).
- DB phase 1 (landed): `roots` table (id text uuidv7, kind 'path'|'fsa'|'snapshot'|'legacy', display_name, path, status, created_at, last_verified_at); backfilled legacy rows have `path` = `source_root_path` (bare dir name on web, absolute path on desktop).
- Known accepted limitation: on web, legacy DB rows are keyed by bare dir name, so two same-named legacy roots merged historically; the registry matches legacy rows by path-string and this merge persists until Phase 3 retires `source_root_path`.
- House rules: TDD; no `any`; tests in BOTH lane registries if added under `packages/db/__tests__` (none planned here); run affected package suites green together; pre-commit hooks auto-format.

---

### Task 1: RootDescriptor type + optional adapter methods

**Files:**
- Modify: `packages/types/src/file-system.ts`

- [ ] **Step 1: Add the types.** In `packages/types/src/file-system.ts`, immediately after the `DirectoryHandle` interface (ends ~line 124), add:

```typescript
/**
 * Durable identity for a user-selected root directory. Generated once when a
 * root is added (crypto.randomUUID) and stable across sessions. Never derived
 * from the directory name or path — names collide and web handles expose no
 * absolute path.
 */
export type RootId = string;

export type RootPermissionState = 'granted' | 'prompt' | 'denied' | 'unknown';

/**
 * A root directory known to the adapter's persistence layer.
 * - kind 'fsa': web — handle persisted in IndexedDB; permissionState reflects
 *   queryPermission at restore time (never prompts).
 * - kind 'path': desktop — absolute path persisted in main-process storage;
 *   permissionState is always 'granted' (OS-level access).
 */
export interface RootDescriptor {
  readonly displayName: string;
  readonly handle: DirectoryHandle;
  readonly kind: 'fsa' | 'path';
  readonly permissionState: RootPermissionState;
  readonly rootId: RootId;
}
```

- [ ] **Step 2: Extend the adapter interface.** Inside `FileSystemAdapter`, after the `requestDirectoryAccess()` member, add:

```typescript
  /**
   * Multi-root: pick a directory and persist it as a new root with a generated
   * RootId. requestDirectoryAccess() is the legacy single-root shim over this.
   */
  addRoot?(): Promise<RootDescriptor>;
  /**
   * Multi-root: return every persisted root with its current permission state.
   * Never prompts (web queryPermission only); never throws on individual stale
   * roots — stale entries are pruned and omitted.
   */
  restoreRoots?(): Promise<RootDescriptor[]>;
```

- [ ] **Step 3: Build.** Run `pnpm --filter @brainstrike/types build` — clean. Then `pnpm turbo run build --filter=@brainstrike/types...` to confirm no dependent breaks (optional methods are non-breaking).

- [ ] **Step 4: Commit.**

```bash
git add packages/types/src/file-system.ts
git commit -m "feat(types): RootDescriptor and optional multi-root adapter methods

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: WebHandleCache v2 — RootId keying with v1→v2 upgrade

**Files:**
- Modify: `packages/file-system/src/adapters/web-handle-cache.ts`
- Test: `packages/file-system/src/__tests__/web-handle-cache-v2-upgrade.test.ts` (create)

The `folderId` parameter/field across the `HandleCache` interface keeps its NAME (no churn for callers) but its VALUE becomes an opaque RootId. The v1→v2 IDB upgrade re-keys existing root records from `handle.name` to `crypto.randomUUID()` and drops all file-handle records (best-effort cache; re-populates on access).

- [ ] **Step 1: Write the failing upgrade test.** Create `packages/file-system/src/__tests__/web-handle-cache-v2-upgrade.test.ts`:

```typescript
import 'fake-indexeddb/auto';
import { openDB } from 'idb';
import { beforeEach, describe, expect, it } from 'vitest';
import { WebHandleCache } from '../adapters/web-handle-cache';

const DB_NAME = 'brainstrike-file-handles';

function makeDirectoryHandle(name: string): FileSystemDirectoryHandle {
  return {
    kind: 'directory',
    name,
    entries: () => ({}),
    getDirectoryHandle: () => Promise.reject(new Error('not implemented')),
    getFileHandle: () => Promise.reject(new Error('not implemented')),
  } as unknown as FileSystemDirectoryHandle;
}

async function seedV1Database(): Promise<void> {
  const db = await openDB(DB_NAME, 1, {
    upgrade(upgradeDb) {
      const rootStore = upgradeDb.createObjectStore('root-handles', { keyPath: 'folderId' });
      rootStore.createIndex('by-last-accessed', 'lastAccessedAt');
      const fileStore = upgradeDb.createObjectStore('file-handles', { keyPath: 'path' });
      fileStore.createIndex('by-folder', 'folderId');
    },
  });
  await db.put('root-handles', {
    folderId: 'my-project',
    handle: makeDirectoryHandle('my-project'),
    lastAccessedAt: 100,
    name: 'my-project',
    storedAt: 100,
  });
  await db.put('file-handles', {
    folderId: 'my-project',
    handle: makeDirectoryHandle('stale') as unknown,
    name: 'file.ts',
    path: 'my-project::src/file.ts',
    storedAt: 100,
  });
  db.close();
}

describe('WebHandleCache v1→v2 upgrade', () => {
  beforeEach(async () => {
    await new Promise<void>((resolve, reject) => {
      const req = globalThis.indexedDB.deleteDatabase(DB_NAME);
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
      req.onblocked = () => resolve();
    });
  });

  it('re-keys v1 name-keyed roots to generated RootIds, preserving name and timestamps', async () => {
    await seedV1Database();

    const cache = new WebHandleCache();
    const roots = await cache.getAllRootHandles();

    expect(roots).toHaveLength(1);
    const migrated = roots[0];
    expect(migrated?.name).toBe('my-project');
    expect(migrated?.lastAccessedAt).toBe(100);
    expect(migrated?.storedAt).toBe(100);
    // Re-keyed: opaque UUID, not the directory name.
    expect(migrated?.folderId).not.toBe('my-project');
    expect(migrated?.folderId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('drops v1 file-handle records during upgrade (best-effort cache)', async () => {
    await seedV1Database();

    const cache = new WebHandleCache();
    await cache.getAllRootHandles(); // force open/upgrade
    const fileHandle = await cache.getFileHandle('my-project', 'src/file.ts');
    expect(fileHandle).toBeNull();
  });

  it('fresh database opens at v2 and stores roots under caller-provided RootIds', async () => {
    const cache = new WebHandleCache();
    const rootId = crypto.randomUUID();
    await cache.storeRootHandle(rootId, makeDirectoryHandle('docs'));

    const roots = await cache.getAllRootHandles();
    expect(roots).toHaveLength(1);
    expect(roots[0]?.folderId).toBe(rootId);
    expect(roots[0]?.name).toBe('docs');
  });

  it('two same-named directories coexist under distinct RootIds (the v1 collision)', async () => {
    const cache = new WebHandleCache();
    const a = crypto.randomUUID();
    const b = crypto.randomUUID();
    await cache.storeRootHandle(a, makeDirectoryHandle('docs'));
    await cache.storeRootHandle(b, makeDirectoryHandle('docs'));

    const roots = await cache.getAllRootHandles();
    expect(roots).toHaveLength(2);
    expect(new Set(roots.map((r) => r.folderId))).toEqual(new Set([a, b]));
  });
});
```

- [ ] **Step 2: Run it — must fail** (v1 cache keeps name keys; same-named roots collide):
`cd packages/file-system && pnpm vitest run src/__tests__/web-handle-cache-v2-upgrade.test.ts`

- [ ] **Step 3: Implement v2.** In `web-handle-cache.ts`:
1. `const DB_VERSION = 2 as const;` (line 8).
2. Replace the upgrade callback in `openDbWithRecovery` (lines 280-295) with a version-aware migration. The idb `upgrade` signature is `upgrade(db, oldVersion, newVersion, transaction)` — use the transaction for same-upgrade data access:

```typescript
    const db = await openDB<HandleCacheSchema>(DB_NAME, DB_VERSION, {
      upgrade(upgradeDb, oldVersion, _newVersion, transaction) {
        logger.debug('openDbWithRecovery: running upgrade', {
          oldVersion,
          stores: Array.from(upgradeDb.objectStoreNames),
        });
        if (!upgradeDb.objectStoreNames.contains(ROOT_STORE)) {
          const store = upgradeDb.createObjectStore(ROOT_STORE, { keyPath: 'folderId' });
          store.createIndex(ROOT_LAST_ACCESSED_INDEX, 'lastAccessedAt');
        }
        if (!upgradeDb.objectStoreNames.contains(FILE_STORE)) {
          const store = upgradeDb.createObjectStore(FILE_STORE, { keyPath: 'path' });
          store.createIndex(FILE_BY_FOLDER_INDEX, 'folderId');
        }
        if (oldVersion === 1) {
          // v1 keyed roots by handle.name — same-named directories collided.
          // Re-key every root under a generated RootId; drop file-handle rows
          // (best-effort cache, re-populates on access).
          const rootStore = transaction.objectStore(ROOT_STORE);
          void (async () => {
            const existing = await rootStore.getAll();
            for (const record of existing) {
              await rootStore.delete(record.folderId);
              await rootStore.put({ ...record, folderId: crypto.randomUUID() });
            }
            await transaction.objectStore(FILE_STORE).clear();
          })();
        }
      },
    });
```
   IMPORTANT implementation note: idb upgrade transactions stay open as long as requests are queued each tick — the async IIFE pattern above works with `idb` because its promisified requests chain within the upgrade transaction; if you find the transaction auto-commits early in tests, restructure to cursor-based synchronous iteration (`rootStore.openCursor()` loop with `cursor.delete()`/`store.put()` then `FILE_STORE` `.clear()`); report which form you needed.
3. Update the recovery-path `openDB` call (lines 325-333) the same way (it creates fresh stores; no migration branch needed — fresh DB has no v1 data).
4. Update the doc comments on `storeRootHandle`/`getRootHandle`/`StoredRootHandle.folderId` to state folderId is an opaque RootId supplied by the caller, and `name` is the display name.

- [ ] **Step 4: Run the new test (expect pass) plus the existing cache suites:**
`cd packages/file-system && pnpm vitest run src/__tests__/web-handle-cache-v2-upgrade.test.ts src/__tests__/web-handle-cache.test.ts src/__tests__/web-handle-cache-indexeddb.test.ts`
The two existing suites may assert v1 behaviors (e.g. version number, name-keyed semantics): update ONLY assertions that encode "version is 1" or "folderId equals name" — the interface itself is unchanged. Report every assertion you change.

- [ ] **Step 5: Commit** (`feat(file-system): re-key web handle cache by RootId with v1→v2 upgrade`, same trailer).

---

### Task 3: WebFileSystemAdapter addRoot/restoreRoots + restore-access fix

**Files:**
- Modify: `packages/file-system/src/adapters/web-adapter.ts`
- Modify: `packages/file-explorer-hooks/src/use-restore-access.ts`
- Test: extend `packages/file-system/src/__tests__/web-adapter.test.ts`, update `packages/file-explorer-hooks/src/__tests__/use-restore-access.test.tsx`

- [ ] **Step 1: Failing adapter tests.** In `web-adapter.test.ts`, add a describe block (mirror the file's existing mock style — mocked `HandleCache`, mocked `window.showDirectoryPicker`):

```typescript
describe('multi-root API', () => {
  it('addRoot stores the handle under a generated RootId and returns a descriptor', async () => {
    const { adapter, handleCache, dirHandle } = setupAdapterWithPicker('my-project');
    const descriptor = await adapter.addRoot();

    expect(descriptor.kind).toBe('fsa');
    expect(descriptor.displayName).toBe('my-project');
    expect(descriptor.permissionState).toBe('granted');
    expect(descriptor.rootId).toMatch(/^[0-9a-f-]{36}$/);
    expect(descriptor.handle.platform).toBe('web');
    expect(handleCache.storeRootHandle).toHaveBeenCalledWith(descriptor.rootId, dirHandle);
  });

  it('requestDirectoryAccess delegates to addRoot (same storage path, legacy return shape)', async () => {
    const { adapter, handleCache } = setupAdapterWithPicker('my-project');
    const handle = await adapter.requestDirectoryAccess();

    expect(handle.name).toBe('my-project');
    const [storedRootId] = (handleCache.storeRootHandle as Mock).mock.calls[0] ?? [];
    expect(storedRootId).toMatch(/^[0-9a-f-]{36}$/); // NOT dirHandle.name any more
  });

  it('restoreRoots returns one descriptor per stored root with queried permission, never prompting', async () => {
    // two stored roots: one granted, one prompt
    const { adapter } = setupAdapterWithStoredRoots([
      { folderId: 'id-granted', name: 'a', permission: 'granted' },
      { folderId: 'id-prompt', name: 'b', permission: 'prompt' },
    ]);
    const roots = await adapter.restoreRoots();

    expect(roots).toHaveLength(2);
    expect(roots.find((r) => r.rootId === 'id-granted')?.permissionState).toBe('granted');
    expect(roots.find((r) => r.rootId === 'id-prompt')?.permissionState).toBe('prompt');
    // requestPermission must never have been called on either handle
  });
});
```
Write the two `setupAdapterWith*` helpers against the file's existing test utilities (it already mocks `HandleCache` and the picker — reuse; if helpers with these exact shapes don't fit the file's pattern, adapt the NAMES to the local idiom but keep the assertions). Run → fail (`addRoot is not a function`).

- [ ] **Step 2: Implement in `web-adapter.ts`.**
1. Add `addRoot()`:

```typescript
  async addRoot(): Promise<RootDescriptor> {
    if (!('showDirectoryPicker' in window)) {
      throw new Error('File System Access API not supported');
    }
    const dirHandle = await window.showDirectoryPicker();
    const rootId = crypto.randomUUID();
    try {
      await this.ensurePersistentStorage();
      await this.handleCache.storeRootHandle(rootId, dirHandle);
      logger.info('Stored root handle to IndexedDB', { name: dirHandle.name, rootId });
    } catch (err) {
      // Best-effort persistence; ignore failures (matches requestDirectoryAccess).
      logger.warn('Failed to store root handle', { error: err });
    }
    this.lastRootFolderId = rootId;
    return {
      displayName: dirHandle.name,
      handle: this.toDirectoryHandle(dirHandle),
      kind: 'fsa',
      permissionState: 'granted',
      rootId,
    };
  }
```
   Extract the existing `requestDirectoryAccess` return-object construction (web-adapter.ts:224-230) into a private `toDirectoryHandle(dirHandle: FileSystemDirectoryHandle): DirectoryHandle` and reuse it.
2. Rewrite `requestDirectoryAccess` as the shim: `const root = await this.addRoot(); return root.handle;`
3. Add `restoreRoots()`:

```typescript
  async restoreRoots(): Promise<RootDescriptor[]> {
    const stored = await this.handleCache.getAllRootHandles();
    const descriptors: RootDescriptor[] = [];
    for (const record of stored) {
      const permissionState = await queryHandlePermission(record.handle);
      descriptors.push({
        displayName: record.name,
        handle: this.toDirectoryHandle(record.handle),
        kind: 'fsa',
        permissionState,
        rootId: record.folderId,
      });
    }
    return descriptors;
  }
```
   `queryHandlePermission` = the cache's existing query helper if exported, else a small local helper calling `handle.queryPermission?.({ mode: 'read' })` with try/catch → `'unknown'`. Check what web-handle-cache.ts exports before writing a duplicate; reuse if possible and report which you did.
4. `restoreLastFolder` semantics unchanged (most-recently-accessed granted root) — it already reads `latest.folderId`, which is now a RootId; verify `lastRootFolderId = latest.folderId` assignment stays.

- [ ] **Step 3: Fix `use-restore-access.ts`.** At lines 214-216, `getValidatedFolderIdAndCleanup` cleans up any stored handle whose `folderId !== rawHandle.name`. Under RootId keys that destroys every root. Remove the name-equality cleanup entirely (the collision it guarded against is structurally impossible with UUID keys). Keep the surrounding stale-handle (`NotFoundError`) and permission handling. Update `use-restore-access.test.tsx` mocks/assertions that encode `folderId === name` — report each changed assertion.

- [ ] **Step 4: Run the affected suites together:**
`cd packages/file-system && pnpm vitest run` then `cd ../file-explorer-hooks && pnpm vitest run`
All green. Any failure outside the files you touched: report, don't fix silently.

- [ ] **Step 5: Commit** (`feat(file-system): addRoot/restoreRoots with RootId identity on web`, trailer).

---

### Task 4: Desktop roots list — storage, IPC, renderer adapter

**Files:**
- Modify: `apps/desktop/src/platform/desktop-ipc-channels.ts`
- Modify: `apps/desktop/src/ipc-domains/file-system-ipc.ts`
- Modify: `apps/desktop/src/preload.ts`
- Modify: `apps/desktop/src/renderer/adapters.ts`
- Test: extend `apps/desktop/src/__tests__/ipc-domains/file-system-ipc.test.ts`

Storage model: new key `'rootsList'` holding `JSON.stringify(Array<{ addedAt: number; path: string; rootId: string }>)`. Legacy `'lastFolderPath'` migrates into the list on first `restoreRoots` read, then is removed. `'fs:saveLastFolder'`/`'fs:restoreLastFolder'` channels stay functional (deprecated shims) — `saveLastFolder` ALSO upserts into `rootsList` so the two stores can't diverge.

- [ ] **Step 1: Failing IPC tests.** In the existing `file-system-ipc.test.ts` pattern (mocked electron, captured handler map, fake storage/fileSystem), add:

```typescript
describe('fs:restoreRoots', () => {
  it('returns roots from rootsList, validating each path and pruning stale entries', async () => {
    // storage: rootsList with two entries, fileSystem.exists true for first, false for second
    // expect: result has 1 RootDescriptor-shaped entry { rootId, kind: 'path', displayName: basename, handle }
    // expect: storage rewritten with only the surviving entry
  });

  it('migrates legacy lastFolderPath into rootsList on first read, then removes the legacy key', async () => {
    // storage: only lastFolderPath set, path exists
    // expect: result has 1 entry with a generated rootId; rootsList now persisted; lastFolderPath removed
  });

  it('returns [] when nothing is stored', async () => {});
});

describe('fs:addRoot', () => {
  it('opens the directory dialog, generates a rootId, appends to rootsList, returns the descriptor', async () => {});
  it('re-uses the existing rootId when the picked path is already in rootsList', async () => {});
});

describe('fs:saveLastFolder (legacy shim)', () => {
  it('still writes lastFolderPath AND upserts the path into rootsList', async () => {});
});
```
Fill the test bodies concretely against the file's existing fake-storage helpers (read the file first; mirror how `restoreLastFolder` tests arrange storage/fileSystem fakes). Run → fail (channels unregistered).

- [ ] **Step 2: Implement.**
1. `desktop-ipc-channels.ts` files block: add `addRoot: 'fs:addRoot',` and `restoreRoots: 'fs:restoreRoots',` (alphabetical position).
2. `file-system-ipc.ts`: add `const ROOTS_LIST_STORAGE_KEY = 'rootsList' as const;` next to `LAST_FOLDER_STORAGE_KEY`. Add a `StoredRootEntry` type `{ addedAt: number; path: string; rootId: string }`, plus `readRootsList(storage): Promise<StoredRootEntry[]>` (JSON.parse with strict shape validation — malformed JSON: log + treat as empty, per existing stale-key handling) and `writeRootsList(storage, entries)`. Implement handlers:
   - `restoreRoots`: read list; if empty, read `lastFolderPath` → if present and exists, seed `[{ addedAt: Date.now(), path, rootId: crypto.randomUUID() }]`, persist, `storage.removeItem(LAST_FOLDER_STORAGE_KEY)`. Validate each entry via `resolveFileSystemIpcPath` + `fileSystem.exists`; prune failures (rewrite list); return survivors as `RootDescriptor[]` with `kind: 'path'`, `permissionState: 'granted'`, `displayName: path.basename(entry.path)`, `handle: { kind: 'directory', name: basename, path: entry.path, platform: 'electron' }`, `rootId: entry.rootId`.
   - `addRoot`: run the same dialog flow as `requestDirectoryAccess`; on pick, upsert into rootsList keyed by resolved path (existing path → keep its rootId, update addedAt); return the descriptor. Also keep writing `lastFolderPath` (legacy shim parity).
   - `saveLastFolder`: after the existing setItem, upsert the path into rootsList (generate rootId if new).
3. `preload.ts`: add the two channel const strings + `addRoot: () => ipcRenderer.invoke('fs:addRoot')`, `restoreRoots: () => ipcRenderer.invoke('fs:restoreRoots')` on the fileSystem bridge. Check whether a preload contract test asserts the bridge surface (search `apps/desktop/src/__tests__` for preload tests) and update it.
4. `adapters.ts` (`ElectronRendererFileSystemAdapter`): add `addRoot = () => api.addRoot()` and `restoreRoots = () => api.restoreRoots()` passthroughs (match the class's existing method style). `requestDirectoryAccess` keeps its current behavior (dialog + saveLastFolder) — saveLastFolder now upserts rootsList, so both APIs converge on the same storage.

- [ ] **Step 3: Run desktop tests:** `cd apps/desktop && pnpm vitest run src/__tests__/ipc-domains/ src/__tests__/main/` — green, including the pre-existing `restoreLastFolder` tests (unchanged behavior). Then the full desktop unit suite if the package has one script (`pnpm --filter @brainstrike/desktop test` — check package.json; report what you ran).

- [ ] **Step 4: Commit** (`feat(desktop): rootsList storage and addRoot/restoreRoots IPC`, trailer).

---

### Task 5: Root registry — DB reconciliation in app-shell

**Files:**
- Create: `packages/app-shell/src/roots/root-registry.ts`
- Create: `packages/app-shell/src/roots/use-roots-reconciliation.ts`
- Modify: `packages/app-shell/src/background-indexing/workspace-collection-sync-provider.tsx` (mount the hook)
- Test: `packages/app-shell/src/__tests__/root-registry.test.ts` (create)

Semantics (the no-rekey design):
- DB `roots.id` is canonical for DB-side identity (file_records.root_id references it). Adapter RootId is storage-side identity. The registry bridges them **by path-string match** (`roots.path` = bare name on web legacy rows, absolute path on desktop): matched pair → in-memory mapping `{ adapterRootId → dbRootId }`; legacy row's `kind` updated `'legacy'` → adapter platform kind (`'fsa'` web / `'path'` electron) and `last_verified_at = NOW()`.
- Adapter root with NO matching DB row → INSERT a roots row using the **adapter's RootId as the row id** (one shared id; this is how all post-phase-2 roots are born).
- DB row with no adapter root → leave untouched (kind stays 'legacy'; its files remain; Phase 3+ owns cleanup UX).
- Reconciliation runs once per app boot, after adapter + db are both available, BEFORE the first sync cycle would write file records (mount it at the top of `WorkspaceCollectionSyncProvider`).

- [ ] **Step 1: Failing registry test.** `packages/app-shell/src/__tests__/root-registry.test.ts` — pure-logic test with a fake `query` function capturing SQL, plus a fake adapter:

```typescript
import { describe, expect, it, vi } from 'vitest';
import { reconcileRoots } from '../roots/root-registry';
import type { RootDescriptor } from '@brainstrike/types';

function fsaRoot(rootId: string, name: string): RootDescriptor {
  return {
    displayName: name,
    handle: { kind: 'directory', name, path: name, platform: 'web' },
    kind: 'fsa',
    permissionState: 'granted',
    rootId,
  };
}

describe('reconcileRoots', () => {
  it('maps adapter roots onto legacy DB rows by path, updates kind, and returns the id mapping', async () => {
    const dbRows = [{ id: 'db-1', kind: 'legacy', path: 'my-project' }];
    const query = vi.fn(async (sql: string) =>
      sql.includes('SELECT') ? { rows: dbRows } : { rows: [] }
    );

    const result = await reconcileRoots({
      adapterRoots: [fsaRoot('adapter-1', 'my-project')],
      platformKind: 'fsa',
      query,
    });

    expect(result.dbRootIdByAdapterRootId.get('adapter-1')).toBe('db-1');
    const updateCall = query.mock.calls.find(([sql]) => sql.includes('UPDATE roots'));
    expect(updateCall?.[0]).toContain("kind = 'fsa'");
    expect(updateCall?.[1]).toEqual(['db-1']);
  });

  it('inserts a new roots row with the adapter RootId when no DB row matches', async () => {
    const query = vi.fn(async (sql: string) =>
      sql.includes('SELECT') ? { rows: [] } : { rows: [] }
    );

    const result = await reconcileRoots({
      adapterRoots: [fsaRoot('adapter-2', 'fresh-folder')],
      platformKind: 'fsa',
      query,
    });

    expect(result.dbRootIdByAdapterRootId.get('adapter-2')).toBe('adapter-2');
    const insertCall = query.mock.calls.find(([sql]) => sql.includes('INSERT INTO roots'));
    expect(insertCall?.[1]).toEqual(
      expect.arrayContaining(['adapter-2', 'fsa', 'fresh-folder', 'fresh-folder'])
    );
  });

  it('leaves unmatched legacy DB rows untouched', async () => {
    const dbRows = [{ id: 'db-orphan', kind: 'legacy', path: 'gone-folder' }];
    const query = vi.fn(async (sql: string) =>
      sql.includes('SELECT') ? { rows: dbRows } : { rows: [] }
    );

    await reconcileRoots({ adapterRoots: [], platformKind: 'fsa', query });

    expect(query.mock.calls.some(([sql]) => sql.includes('UPDATE roots'))).toBe(false);
    expect(query.mock.calls.some(([sql]) => sql.includes('INSERT'))).toBe(false);
  });
});
```
Adjust the `query` fake's shape to whatever `usePGliteDatabase`'s handle actually exposes (check `packages/db` exports — likely `db.query(sql, params)`); the test asserts SQL intent, not exact whitespace (use `expect.stringContaining` where helpful). Run → fail (module missing).

- [ ] **Step 2: Implement `root-registry.ts`:**

```typescript
import { createLogger } from '@brainstrike/utils';
import type { RootDescriptor } from '@brainstrike/types';

const logger = createLogger('RootRegistry');

export interface RootsQueryFn {
  (sql: string, params?: unknown[]): Promise<{ rows: unknown[] }>;
}

export interface ReconcileRootsArgs {
  adapterRoots: readonly RootDescriptor[];
  platformKind: 'fsa' | 'path';
  query: RootsQueryFn;
}

export interface ReconcileRootsResult {
  dbRootIdByAdapterRootId: Map<string, string>;
}

interface DbRootRow {
  id: string;
  kind: string;
  path: string | null;
}

function isDbRootRow(row: unknown): row is DbRootRow {
  return (
    typeof row === 'object' &&
    row !== null &&
    typeof (row as DbRootRow).id === 'string' &&
    typeof (row as DbRootRow).kind === 'string'
  );
}

/**
 * Bridges adapter-side roots (storage identity) onto DB roots rows (canonical
 * identity for file_records.root_id). No id re-keying: legacy rows keep their
 * backfilled ids and are matched by path-string; brand-new roots are inserted
 * under the adapter's RootId so the two identities coincide going forward.
 * Unmatched legacy rows are deliberately left alone (phase 3+ owns cleanup).
 */
export async function reconcileRoots(args: ReconcileRootsArgs): Promise<ReconcileRootsResult> {
  const { adapterRoots, platformKind, query } = args;
  const mapping = new Map<string, string>();

  const result = await query('SELECT id, kind, path FROM roots');
  const dbRows = result.rows.filter(isDbRootRow);
  const dbByPath = new Map(dbRows.filter((r) => r.path !== null).map((r) => [r.path, r]));

  for (const root of adapterRoots) {
    // Adapter "path": bare dir name on web, absolute path on desktop — the
    // same value migration 038 backfilled into roots.path from source_root_path.
    const matched = dbByPath.get(root.handle.path);
    if (matched) {
      mapping.set(root.rootId, matched.id);
      if (matched.kind === 'legacy') {
        await query(
          `UPDATE roots SET kind = '${platformKind}', last_verified_at = NOW() WHERE id = $1`,
          [matched.id]
        );
        logger.info('Reconciled legacy root', { dbRootId: matched.id, kind: platformKind });
      }
      continue;
    }
    await query(
      `INSERT INTO roots (id, kind, display_name, path, last_verified_at)
       VALUES ($1, $2, $3, $4, NOW())
       ON CONFLICT (id) DO NOTHING`,
      [root.rootId, platformKind, root.displayName, root.handle.path]
    );
    mapping.set(root.rootId, root.rootId);
    logger.info('Registered new root', { rootId: root.rootId, kind: platformKind });
  }

  return { dbRootIdByAdapterRootId: mapping };
}
```
NOTE the `kind` value is interpolated, not parameterized — it is a closed union from our own type, but house style may still prefer `$2`; use a parameter (`kind = $2 ... [platformKind, matched.id]`) — adjust the test accordingly. Web path-collision caveat: `dbByPath` keyed by bare name means two same-named adapter roots map to the same legacy row — acceptable phase-2 limitation, documented in the plan header.

- [ ] **Step 3: Implement `use-roots-reconciliation.ts`:** a hook that (a) no-ops unless `adapter.restoreRoots` exists and the db handle is ready, (b) runs exactly once (ref guard), (c) calls `adapter.restoreRoots()` then `reconcileRoots(...)` with `platformKind: adapter.platform === 'electron' ? 'path' : 'fsa'`, (d) logs-and-swallows errors (reconciliation must never block boot; log at error level — this is observability, not silent fallback: the app works identically without it in phase 2). Mount it as the first hook inside `WorkspaceCollectionSyncProvider` (it already has `useAdapters()` + `usePGliteDatabase()` — read the provider to wire identically). Export the mapping via module-level store or React context ONLY if trivially fitting an existing pattern; otherwise return void and let Phase 3 wire consumers — do not invent state plumbing now (YAGNI).

- [ ] **Step 4: Run app-shell tests:** `cd packages/app-shell && pnpm vitest run` — green; provider tests may need the new hook mocked (follow how sibling hooks are mocked there; report changes).

- [ ] **Step 5: Commit** (`feat(app-shell): root registry reconciles legacy roots and registers adapter roots`, trailer).

---

### Task 6: Full verification

- [ ] **Step 1:** `pnpm dlx ultracite fix` → no unexpected diffs (commit formatting-only churn in touched files as `style:` if any).
- [ ] **Step 2:** Affected package suites green TOGETHER, package-local: `packages/types`, `packages/file-system`, `packages/file-explorer-hooks`, `packages/app-shell`, `apps/desktop` (unit), `packages/db` (`pnpm test`, unchanged but FK-adjacent). Re-run any failed lane once in isolation (turbo-concurrency flakes); report both outcomes.
- [ ] **Step 3:** `pnpm turbo run build --filter=@brainstrike/types... --filter=@brainstrike/file-system...` (and dependents) + `pnpm dlx ultracite check` — clean.
- [ ] **Step 4:** `git log --oneline main..HEAD` — confirm history; do not push without confirmation (user has standing approval for this stack: push + PR after verification).

---

## Out of scope (later phases)
- Import pipeline writing `file_records.root_id` (Phase 3 — uses the registry mapping).
- `file_token_cache.folder_id` / Zustand `folderStates` re-keying (Phase 3/4).
- Forest UI, multi-root restore banner, `FileSystemObserver` (Phases 3-4).
- Factory reset: the handle-cache DB name is unchanged (already in the reset list); `rootsList` lives in existing Electron storage cleared by reset — verify in Phase 4 when state surface grows.
