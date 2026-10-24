// @vitest-environment node
import { join, resolve } from 'node:path';
import { expect, test, vi } from 'vitest';
import {
  createRegistry,
  createRegistryCatalogRequest,
  createStorage,
  secureRoot,
} from './workspace-root-registry-test-helpers';

const FIRST = resolve('/first');
const SECOND = resolve('/second');

test.each(['recent-roots read', 'managed-worktree authorization'] as const)(
  'close joins an accepted pickerless %s through mount and catalog ACK',
  async (authorization) => {
    const path = resolve('/authorized');
    const storage = createStorage({
      ...(authorization === 'recent-roots read'
        ? { recentRootsList: JSON.stringify([{ lastGrantedAt: 1, path }]) }
        : {}),
    });
    const entered = Promise.withResolvers<void>();
    const authorize = Promise.withResolvers<void>();
    const originalRead = vi.mocked(storage.getItem).getMockImplementation();
    if (!originalRead) {
      throw new Error('Missing storage fixture');
    }
    let heldRead = false;
    vi.mocked(storage.getItem).mockImplementation(async (key) => {
      if (authorization === 'recent-roots read' && key === 'recentRootsList' && !heldRead) {
        heldRead = true;
        entered.resolve();
        await authorize.promise;
      }
      return originalRead(key);
    });
    const request = createRegistryCatalogRequest();
    const originalRequest = request.getMockImplementation();
    if (!originalRequest) {
      throw new Error('Missing catalog fixture');
    }
    const committed = Promise.withResolvers<void>();
    const ack = Promise.withResolvers<void>();
    request.mockImplementation(async (input) => {
      const result = await originalRequest(input);
      if (input.operation === 'register') {
        committed.resolve();
        await ack.promise;
      }
      return result;
    });
    const handle = secureRoot(path);
    const open = vi.fn(async () => handle);
    const registry = createRegistry(
      {
        createSecureRoot: open,
        resolveReadPath: async (requested) => requested,
        storage,
      },
      request
    );
    const authorizer = vi.fn(async () => {
      if (authorization === 'managed-worktree authorization') {
        entered.resolve();
        await authorize.promise;
      }
      return 'authorized' as const;
    });
    registry.setManagedWorktreeAuthorizer(authorizer);
    const adding = registry.addRootByPath(path);
    void adding.catch(() => undefined);
    await entered.promise;
    const preparation = registry.prepareClose();
    const settled = vi.fn();
    void preparation.then(settled, settled);
    try {
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(settled).not.toHaveBeenCalled();
      expect(open).not.toHaveBeenCalled();
      authorize.resolve();
      await committed.promise;
      expect(settled).not.toHaveBeenCalled();
      expect(handle.close).not.toHaveBeenCalled();
      ack.resolve();
      const root = await adding;
      await preparation;
      expect(root).toMatchObject({ handle: { path }, persisted: true });
      await expect(
        registry.readFileByAbsolutePath(join(path, 'file.txt'), path, root.rootId)
      ).resolves.toBe('inside');
      expect(open).toHaveBeenCalledOnce();
      expect(handle.close).not.toHaveBeenCalled();
      expect(authorizer).toHaveBeenCalledTimes(authorization === 'recent-roots read' ? 0 : 1);
      const stored = await originalRead('recentRootsList');
      if (authorization === 'recent-roots read') {
        expect(JSON.parse(stored ?? '[]')).toHaveLength(1);
      } else {
        expect(stored).toBeNull();
      }
    } finally {
      authorize.resolve();
      ack.resolve();
      await Promise.allSettled([adding, preparation]);
      await registry.dispose();
    }
    expect(handle.close).toHaveBeenCalledOnce();
  }
);

test.each(['recents', 'managed'] as const)(
  'a new pickerless %s request after close refuses before any authorization',
  async (source) => {
    const storage = createStorage(
      source === 'recents'
        ? {
            recentRootsList: JSON.stringify([{ lastGrantedAt: 1, path: '/late' }]),
          }
        : {}
    );
    const open = vi.fn(async () => secureRoot('/late'));
    const registry = createRegistry({ createSecureRoot: open, storage });
    const authorizer = vi.fn(async () => 'authorized' as const);
    registry.setManagedWorktreeAuthorizer(authorizer);
    await registry.prepareClose();
    try {
      await expect(registry.addRootByPath('/late')).rejects.toMatchObject({
        failure: {
          category: 'availability',
          code: 'workspace.root-mutations-closed',
          kind: 'refusal',
        },
      });
      expect(storage.getItem).not.toHaveBeenCalled();
      expect(authorizer).not.toHaveBeenCalled();
      expect(open).not.toHaveBeenCalled();
      expect(storage.setItem).not.toHaveBeenCalled();
    } finally {
      await registry.dispose();
    }
  }
);

test.each(['storage failure', 'authorizer exception', 'authorizer denial'] as const)(
  'close joins %s and preserves its failure without a grant',
  async (control) => {
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const cause = new Error('Expected authorization boundary failure');
    const storage = createStorage();
    if (control === 'storage failure') {
      vi.mocked(storage.getItem).mockImplementation(async () => {
        entered.resolve();
        await release.promise;
        throw cause;
      });
    }
    const request = createRegistryCatalogRequest();
    const open = vi.fn(async () => secureRoot('/denied'));
    const granted = vi.fn();
    const registry = createRegistry(
      { createSecureRoot: open, onRootGranted: granted, storage },
      request
    );
    const authorizer = vi.fn(async () => {
      entered.resolve();
      await release.promise;
      if (control === 'authorizer exception') {
        throw cause;
      }
      return 'managed-but-unauthorized' as const;
    });
    registry.setManagedWorktreeAuthorizer(authorizer);
    const adding = registry.addRootByPath('/denied');
    void adding.catch(() => undefined);
    await entered.promise;
    const preparation = registry.prepareClose();
    const settled = vi.fn();
    void preparation.then(settled, settled);
    try {
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(settled).not.toHaveBeenCalled();
      release.resolve();
      const failure: unknown = await adding.catch((error: unknown) => error);
      if (control === 'storage failure') {
        expect(failure).toBe(cause);
      } else if (control === 'authorizer exception') {
        expect(failure).toMatchObject({
          cause,
          failure: { code: 'workspace.authorization-unavailable', kind: 'fault' },
        });
        if (!(failure instanceof Error)) {
          throw failure;
        }
        expect(failure.cause).toBe(cause);
      } else {
        expect(failure).toMatchObject({
          failure: {
            category: 'authorization',
            code: 'workspace.managed-not-authorized',
            kind: 'refusal',
          },
        });
      }
      await expect(preparation).rejects.toMatchObject({ errors: [failure] });
      expect(open).not.toHaveBeenCalled();
      expect(request).not.toHaveBeenCalled();
      expect(storage.setItem).not.toHaveBeenCalled();
      expect(granted).not.toHaveBeenCalled();
    } finally {
      release.resolve();
      await Promise.allSettled([adding, preparation]);
      await registry.dispose();
    }
  }
);

test('a pickerless workflow queued before close finishes without re-entering the mutation queue', async () => {
  const firstOpened = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const handles = [secureRoot(FIRST), secureRoot(SECOND)];
  const request = createRegistryCatalogRequest();
  const registry = createRegistry(
    {
      createSecureRoot: async (path) => {
        if (path === FIRST) {
          firstOpened.resolve();
          await release.promise;
        }
        const handle = handles.find((item) => item.canonicalPath === path);
        if (!handle) {
          throw new Error('Unexpected root');
        }
        return handle;
      },
      storage: createStorage({
        recentRootsList: JSON.stringify([{ lastGrantedAt: 1, path: SECOND }]),
      }),
    },
    request
  );
  const first = registry.addRoot({
    kind: 'directory',
    name: 'first',
    path: FIRST,
    platform: 'electron',
  });
  await firstOpened.promise;
  const second = registry.addRootByPath(SECOND);
  const preparation = registry.prepareClose();
  try {
    release.resolve();
    await expect(first).resolves.toMatchObject({ handle: { path: FIRST } });
    await expect(second).resolves.toMatchObject({ handle: { path: SECOND } });
    await preparation;
    expect(
      request.mock.calls.flatMap(([input]) =>
        input.operation === 'register' ? [input.root.path] : []
      )
    ).toEqual([FIRST, SECOND]);
    expect(handles.every((handle) => vi.mocked(handle.close).mock.calls.length === 0)).toBe(true);
  } finally {
    release.resolve();
    await Promise.allSettled([first, second, preparation]);
    await registry.dispose();
  }
  for (const handle of handles) {
    expect(handle.close).toHaveBeenCalledOnce();
  }
});
