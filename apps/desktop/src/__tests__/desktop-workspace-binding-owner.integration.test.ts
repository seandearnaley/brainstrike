// @vitest-environment node
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, realpath, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CanonicalWorkspaceLease } from '@brainstrike/canonical-ingestion';
import { migrate, wasmLoader } from '@brainstrike/db';
import { expect, test } from 'vitest';
import { DesktopWorkspaceBindingAuthority } from '../agent-host-platform/desktop-workspace-binding';
import { loadWorkspaceRootsFromDatabase } from '../assistant-server/workspace-roots';
import { createWorktreeLedger } from '../assistant-server/worktree-ledger';
import { WorkspaceRootRegistry } from '../ipc-domains/workspace-root-registry';
import {
  createNativeSecureRoot,
  resolveCanonicalRootPath,
  resolveValidatedReadPath,
} from '../ipc-domains/workspace-root-seams';
import { createStorage, rootHandle } from './ipc-domains/workspace-root-registry-test-helpers';

async function withWorkspace(
  work: (fixture: {
    authority: DesktopWorkspaceBindingAuthority;
    database: Awaited<ReturnType<typeof wasmLoader.createPGlite>>;
    mount(name: string): Promise<{ rootId: string; path: string; displayName: string }>;
    registry: WorkspaceRootRegistry;
    directory: string;
  }) => Promise<void>,
  wrapBorrow: (lease: CanonicalWorkspaceLease) => CanonicalWorkspaceLease = (lease) => lease
): Promise<void> {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'bs-m3-main-binding-owner-')));
  const database = await wasmLoader.createPGlite(`memory://main-binding-${randomUUID()}`);
  let registry: WorkspaceRootRegistry | undefined;
  let authority: DesktopWorkspaceBindingAuthority | undefined;
  try {
    await migrate(database);
    const catalog = {
      query: <T>(sql: string, params?: readonly unknown[]) =>
        database.query<T>(sql, params ? [...params] : undefined),
    };
    registry = new WorkspaceRootRegistry({
      createSecureRoot: createNativeSecureRoot,
      disposeCommandSessionsForRoot: async () => 0,
      evictLspServersForRoot: async () => undefined,
      getRootsDatabase: async () => catalog,
      pathExists: async (path) => {
        try {
          return (await stat(path)).isDirectory();
        } catch {
          return false;
        }
      },
      resolveCanonicalRoot: resolveCanonicalRootPath,
      resolveReadPath: resolveValidatedReadPath,
      storage: createStorage(),
    });
    const mounted = registry;
    const ledger = createWorktreeLedger(async () => database);
    authority = new DesktopWorkspaceBindingAuthority({
      borrowRoot: async (root) =>
        wrapBorrow(
          await mounted.borrowSourceRootForPath(root.path, async () => {
            throw new Error('Binding validation must not construct a watcher');
          })
        ),
      readRoots: () => loadWorkspaceRootsFromDatabase(catalog),
      readWorktree: (id) => ledger.get(id),
    });
    await work({
      authority,
      database,
      directory,
      mount: async (name) => {
        const path = join(directory, name);
        await mkdir(path);
        const descriptor = await mounted.addRoot(rootHandle(path));
        await database.query(
          'INSERT INTO roots (id,kind,display_name,path,last_verified_at) VALUES ($1,$2,$3,$4,NOW())',
          [descriptor.rootId, 'path', name, path]
        );
        return { displayName: name, path, rootId: descriptor.rootId };
      },
      registry,
    });
  } finally {
    await authority?.close();
    await registry?.dispose();
    await database.close();
    await rm(directory, { force: true, recursive: true });
  }
}

test('Main authority retains the existing pinned mount and fences actual catalog/mount revocation', async () => {
  await withWorkspace(async ({ authority, database, mount, registry }) => {
    const root = await mount('workspace');
    const signal = new AbortController().signal;
    const request = {
      binding: { operatingRootDisplayName: 'View label', operatingRootId: root.rootId },
      signal,
      threadId: randomUUID(),
    };
    const borrowed = await authority.acquire(request);
    expect(borrowed.roots).toEqual([root]);
    await borrowed.revalidate(signal);
    await database.query('UPDATE roots SET status=$1 WHERE id=$2', ['disconnected', root.rootId]);
    await expect(borrowed.revalidate(signal)).rejects.toThrow();
    await database.query('UPDATE roots SET status=$1 WHERE id=$2', ['live', root.rootId]);
    await borrowed.revalidate(signal);
    await registry.removeRoot(root.rootId);
    await expect(borrowed.revalidate(signal)).rejects.toThrow();
    await borrowed.close();
    await expect(authority.acquire(request)).rejects.toThrow();
  });
});

test('revocation during an actual held native access fences the next selected root', async () => {
  let rootA = '';
  let rootB = '';
  let rootBReads = 0;
  let release = (): void => undefined;
  let entered = (): void => undefined;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  await withWorkspace(
    async ({ authority, database, mount }) => {
      const a = await mount('a');
      const b = await mount('b');
      rootA = a.rootId;
      rootB = b.rootId;
      const pending = authority.acquire({
        binding: {
          operatingRootDisplayName: 'A',
          operatingRootId: a.rootId,
          secondaryRootIds: [b.rootId],
        },
        signal: new AbortController().signal,
        threadId: randomUUID(),
      });
      try {
        await started;
        await database.query('UPDATE roots SET status=$1 WHERE id=$2', ['disconnected', b.rootId]);
        release();
        await expect(pending).rejects.toThrow();
        expect(rootBReads).toBe(0);
      } finally {
        release();
        await Promise.allSettled([pending]);
      }
    },
    (lease) => ({
      ...lease,
      listDir: async (...args) => {
        if (lease.rootId === rootA) {
          entered();
          await held;
        }
        if (lease.rootId === rootB) {
          rootBReads += 1;
        }
        return await lease.listDir(...args);
      },
    })
  );
});

test('view paths cannot select a root or substitute an unmounted catalog record', async () => {
  await withWorkspace(async ({ authority, database, mount, directory }) => {
    const root = await mount('workspace');
    const foreign = join(directory, 'foreign');
    await mkdir(foreign);
    const request = {
      binding: {
        operatingRootDisplayName: 'View label',
        operatingRootId: root.rootId,
        operatingRootPath: foreign,
      },
      signal: new AbortController().signal,
      threadId: randomUUID(),
    };
    await expect(authority.acquire(request)).rejects.toThrow();
    const unknown = randomUUID();
    await expect(
      authority.acquire({
        ...request,
        binding: { operatingRootDisplayName: 'Unknown', operatingRootId: unknown },
      })
    ).rejects.toThrow();
    await database.query(
      'INSERT INTO roots (id,kind,display_name,path,last_verified_at) VALUES ($1,$2,$3,$4,NOW())',
      [unknown, 'path', 'Unmounted', foreign]
    );
    await expect(
      authority.acquire({
        ...request,
        binding: { operatingRootDisplayName: 'Unmounted', operatingRootId: unknown },
      })
    ).rejects.toThrow();
    const valid = await authority.acquire({
      ...request,
      binding: {
        operatingRootDisplayName: 'View label',
        operatingRootId: root.rootId,
        operatingRootPath: root.path,
      },
    });
    await valid.close();
  });
});

test('worktree checkout uses the live existing ledger and mounted catalog path, including its return root', async () => {
  await withWorkspace(async ({ authority, database, mount }) => {
    const local = await mount('repository');
    const worktree = await mount('worktree');
    const worktreeId = randomUUID();
    const ledger = createWorktreeLedger(async () => database);
    await ledger.insert({
      archivedAt: null,
      archiveSnapshotRef: null,
      baseRef: 'main',
      branch: 'topic',
      createdAt: new Date().toISOString(),
      createdBy: 'user',
      id: worktreeId,
      path: worktree.path,
      repoCommonDir: join(local.path, '.git'),
      runId: null,
      setupOutput: null,
      setupReason: null,
      setupStatus: 'none',
      threadId: null,
    });
    const request = {
      binding: {
        checkoutBranch: 'topic',
        checkoutLocalRootId: local.rootId,
        checkoutMode: 'worktree' as const,
        checkoutWorktreeId: worktreeId,
        checkoutWorktreePath: worktree.path,
        operatingRootDisplayName: 'Worktree',
        operatingRootId: worktree.rootId,
      },
      signal: new AbortController().signal,
      threadId: randomUUID(),
    };
    const borrowed = await authority.acquire(request);
    expect(borrowed.roots).toEqual([worktree]);
    const renamedBranchHint = await authority.acquire({
      ...request,
      binding: { ...request.binding, checkoutBranch: 'current-display-branch' },
    });
    expect(renamedBranchHint.roots).toEqual([worktree]);
    await renamedBranchHint.close();
    await ledger.markArchived(worktreeId, `refs/brainstrike/worktree-archive/${worktreeId}`);
    await expect(borrowed.revalidate(request.signal)).rejects.toThrow();
    await borrowed.close();
    await expect(authority.acquire(request)).rejects.toThrow();
    await ledger.markRestored(worktreeId);
    await database.query('UPDATE roots SET status=$1 WHERE id=$2', ['disconnected', local.rootId]);
    await expect(authority.acquire(request)).rejects.toThrow();
  });
});
