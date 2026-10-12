import path from 'node:path';
import type { CanonicalWorkspaceLease } from '@brainstrike/canonical-ingestion';
import { getFileSizeConfig } from '@brainstrike/file-system';
import { ParcelWatchRetirementError } from '@brainstrike/file-system/native-watch';
import { describe, expect, it, vi } from 'vitest';
import type { SubscribeMountedWorkspaceRoot } from '../../ipc-domains/workspace-root-registry';
import type { SecureWorkspaceRoot } from '../../ipc-domains/workspace-root-types';
import { createRegistry, rootHandle, secureRoot } from './workspace-root-registry-test-helpers';

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function context(signal = new AbortController().signal): {
  requestId: string;
  signal: AbortSignal;
} {
  return { requestId: 'canonical-source-test', signal };
}

function subscriber(): ReturnType<typeof vi.fn<SubscribeMountedWorkspaceRoot>> {
  return vi.fn<SubscribeMountedWorkspaceRoot>(async () => ({
    close: vi.fn(async () => undefined),
  }));
}

async function mounted(root: SecureWorkspaceRoot = secureRoot('/workspace')): Promise<{
  createSecureRoot: ReturnType<typeof vi.fn<(rootPath: string) => Promise<SecureWorkspaceRoot>>>;
  registry: ReturnType<typeof createRegistry>;
  rootId: string;
}> {
  const createSecureRoot = vi.fn(async () => root);
  const registry = createRegistry({
    createSecureRoot,
    resolveReadPath: async (requestedPath) => path.normalize(requestedPath),
  });
  const descriptor = await registry.addRoot(rootHandle('/workspace'));
  return { createSecureRoot, registry, rootId: descriptor.rootId };
}

function waitForAbort(signal: AbortSignal): Promise<void> {
  if (signal.aborted) {
    return Promise.resolve();
  }
  return new Promise((resolve) =>
    signal.addEventListener('abort', () => resolve(), { once: true })
  );
}

describe('WorkspaceRootRegistry canonical source borrows', () => {
  it('retains failed acquisition retirement ownership before disconnect can close the shared root', async () => {
    const exit = Promise.withResolvers<void>();
    const retire = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error('native watcher retirement is uncertain'))
      .mockReturnValueOnce(exit.promise);
    const failure = new ParcelWatchRetirementError([new Error('late watch acquisition')], retire);
    const subscribe = vi.fn<SubscribeMountedWorkspaceRoot>().mockRejectedValueOnce(failure);
    const root = secureRoot('/workspace');
    const f = await mounted(root);
    const lease = await f.registry.borrowSourceRoot(f.rootId, subscribe);
    await expect(lease.subscribe(vi.fn(), vi.fn(), vi.fn(), context())).rejects.toBe(failure);
    await expect(f.registry.removeRoot(f.rootId)).rejects.toThrow('retirement failed');
    expect(retire).toHaveBeenCalledTimes(1);
    expect(root.close).not.toHaveBeenCalled();
    await expect(f.registry.borrowSourceRoot(f.rootId, subscriber())).rejects.toThrow();
    await expect(f.registry.borrowSourceRootForPath('/workspace', subscriber())).rejects.toThrow();
    let disconnected = false;
    const retry = f.registry.removeRoot(f.rootId).then(() => {
      disconnected = true;
    });
    await vi.waitFor(() => expect(retire).toHaveBeenCalledTimes(2));
    expect(disconnected).toBe(false);
    expect(root.close).not.toHaveBeenCalled();
    exit.resolve();
    await retry;
    expect(root.close).toHaveBeenCalledTimes(1);
  });

  it('resolves a visible root watch through the actual mounted capability and refuses arbitrary paths', async () => {
    const root = secureRoot('/workspace');
    const f = await mounted(root);
    const subscribe = subscriber();
    const lease = await f.registry.borrowSourceRootForPath('/workspace', subscribe);
    await lease.subscribe(vi.fn(), vi.fn(), vi.fn(), context());
    expect(subscribe.mock.calls[0]?.[0]).toMatchObject({
      canonicalPath: '/workspace',
      root,
      rootId: f.rootId,
    });
    expect(f.createSecureRoot).toHaveBeenCalledTimes(1);
    await expect(
      f.registry.borrowSourceRootForPath('/workspace/subdirectory', subscribe)
    ).rejects.toThrow('mounted root');
    await expect(f.registry.borrowSourceRootForPath('/other-root', subscribe)).rejects.toThrow(
      'mounted root'
    );
    await lease.retire();
    expect(root.close).not.toHaveBeenCalled();
  });

  it('uses the same opened capability and exact bounded relative operations', async () => {
    const root = secureRoot('/workspace');
    const { createSecureRoot, registry, rootId } = await mounted(root);
    const lease = await registry.borrowSourceRoot(rootId, subscriber());

    expect(lease.rootId).toBe(rootId);
    expect(lease.canonicalPath).toBe(root.canonicalPath);
    expect(lease.generation).toMatch(/^[\da-f-]{36}$/u);
    await lease.listDir('.', 7, context());
    await lease.readFile('src/file.txt', 37, context());
    expect(root.listDir).toHaveBeenCalledExactlyOnceWith('.', 7);
    expect(root.readFile).toHaveBeenCalledExactlyOnceWith('src/file.txt', 37);
    expect(createSecureRoot).toHaveBeenCalledTimes(1);

    await lease.retire();
    expect(root.close).not.toHaveBeenCalled();
    await expect(registry.readFile('/workspace/src/file.txt')).resolves.toBe('inside');
  });

  it('refuses a missing or path-shaped identity without opening another root', async () => {
    const { registry, createSecureRoot } = await mounted();
    await expect(registry.borrowSourceRoot('/workspace', subscriber())).rejects.toThrow();
    await expect(
      registry.borrowSourceRoot('b67ef28a-aab8-4ab1-a7d9-3c003184d869', subscriber())
    ).rejects.toThrow('not mounted');
    expect(createSecureRoot).toHaveBeenCalledTimes(1);
  });

  it('refuses malformed relative paths and out-of-policy bounds before native I/O', async () => {
    const root = secureRoot('/workspace');
    const { registry, rootId } = await mounted(root);
    const lease = await registry.borrowSourceRoot(rootId, subscriber());
    for (const relativePath of [
      '/outside',
      '../secret',
      'dir/../secret',
      'a//b',
      'a\\b',
      'C:/secret',
      'a\0b',
    ]) {
      await expect(lease.listDir(relativePath, 7, context())).rejects.toThrow();
      await expect(lease.readFile(relativePath, 37, context())).rejects.toThrow();
    }
    for (const maxEntries of [0, -1, 10_001, Number.NaN]) {
      await expect(lease.listDir('.', maxEntries, context())).rejects.toThrow();
    }
    for (const maxBytes of [0, -1, getFileSizeConfig().maxFileSize + 1, Number.NaN]) {
      await expect(lease.readFile('inside.txt', maxBytes, context())).rejects.toThrow();
    }
    expect(root.listDir).not.toHaveBeenCalled();
    expect(root.readFile).not.toHaveBeenCalled();
    await lease.retire();
  });

  it('joins a physically held read after cancellation and discards its late bytes', async () => {
    const started = deferred<void>();
    const nativeRead = deferred<Awaited<ReturnType<SecureWorkspaceRoot['readFile']>>>();
    const root = {
      ...secureRoot('/workspace'),
      readFile: vi.fn(() => {
        started.resolve();
        return nativeRead.promise;
      }),
    };
    const { registry, rootId } = await mounted(root);
    const lease = await registry.borrowSourceRoot(rootId, subscriber());
    const controller = new AbortController();
    const canceled = new Error('request canceled');
    const outcome = lease
      .readFile('inside.txt', 37, context(controller.signal))
      .catch((error: unknown) => error);
    await started.promise;
    controller.abort(canceled);
    let retired = false;
    const retirement = lease.retire().then(() => {
      retired = true;
    });
    expect(lease.signal.aborted).toBe(true);
    await Promise.resolve();
    expect(retired).toBe(false);
    expect(root.close).not.toHaveBeenCalled();
    nativeRead.resolve({ content: Buffer.from('late bytes'), status: 'ok' });
    expect(await outcome).toBe(canceled);
    await retirement;
    expect(root.close).not.toHaveBeenCalled();
  });

  it('disconnect revokes admission and joins the borrow before closing the shared mount', async () => {
    const started = deferred<void>();
    const nativeRead = deferred<Awaited<ReturnType<SecureWorkspaceRoot['readFile']>>>();
    const root = {
      ...secureRoot('/workspace'),
      readFile: vi.fn(() => {
        started.resolve();
        return nativeRead.promise;
      }),
    };
    const { registry, rootId } = await mounted(root);
    const lease = await registry.borrowSourceRoot(rootId, subscriber());
    const outcome = lease.readFile('inside.txt', 37, context()).catch((error: unknown) => error);
    await started.promise;
    let disconnected = false;
    const disconnect = registry.removeRoot(rootId).then(() => {
      disconnected = true;
    });
    await waitForAbort(lease.signal);
    await expect(lease.listDir('.', 7, context())).rejects.toThrow();
    expect(disconnected).toBe(false);
    expect(root.close).not.toHaveBeenCalled();
    nativeRead.resolve({ content: Buffer.from('revoked bytes'), status: 'ok' });
    expect(await outcome).toBeInstanceOf(Error);
    await disconnect;
    expect(root.close).toHaveBeenCalledTimes(1);
    await expect(registry.borrowSourceRoot(rootId, subscriber())).rejects.toThrow('not mounted');
  });

  it.each(['replacement', 'unmount'] as const)(
    'refuses a path borrow resolving after %s captured its retirement snapshot',
    async (retirementKind) => {
      const readStarted = deferred<void>();
      const nativeRead = deferred<Awaited<ReturnType<SecureWorkspaceRoot['readFile']>>>();
      const pathStarted = deferred<void>();
      const resolvedPath = deferred<string>();
      const original = {
        ...secureRoot('/workspace'),
        readFile: vi.fn(() => {
          readStarted.resolve();
          return nativeRead.promise;
        }),
      };
      const replacement = secureRoot('/replacement');
      const registry = createRegistry({
        createSecureRoot: vi
          .fn<(rootPath: string) => Promise<SecureWorkspaceRoot>>()
          .mockResolvedValueOnce(original)
          .mockResolvedValueOnce(replacement),
        resolveReadPath: async (requestedPath) => {
          if (requestedPath === '/workspace') {
            pathStarted.resolve();
            return resolvedPath.promise;
          }
          return path.normalize(requestedPath);
        },
      });
      const { rootId } = await registry.addRoot(rootHandle('/workspace'));
      const admitted = await registry.borrowSourceRoot(rootId, subscriber());
      const read = admitted.readFile('inside.txt', 37, context()).catch((error: unknown) => error);
      await readStarted.promise;
      const lateBorrow = registry
        .borrowSourceRootForPath('/workspace', subscriber())
        .catch((error: unknown) => error);
      await pathStarted.promise;
      const retirement =
        retirementKind === 'replacement' ? registry.restoreRoots() : registry.removeRoot(rootId);
      await waitForAbort(admitted.signal);
      try {
        resolvedPath.resolve('/workspace');
        expect(await lateBorrow).toBeInstanceOf(Error);
        expect(original.close).not.toHaveBeenCalled();
        expect(replacement.close).not.toHaveBeenCalled();
        nativeRead.resolve({ content: Buffer.from('retired bytes'), status: 'ok' });
        expect(await read).toBeInstanceOf(Error);
        await retirement;
        expect(original.close).toHaveBeenCalledTimes(1);
        if (retirementKind === 'replacement') {
          const fresh = await registry.borrowSourceRoot(rootId, subscriber());
          expect(fresh.generation).not.toBe(admitted.generation);
          await expect(fresh.readFile('inside.txt', 37, context())).resolves.toMatchObject({
            status: 'ok',
          });
          expect(replacement.close).not.toHaveBeenCalled();
        }
      } finally {
        resolvedPath.resolve('/workspace');
        nativeRead.resolve({ content: Buffer.from('cleanup'), status: 'ok' });
        await read;
        await retirement;
        await registry.dispose();
      }
    }
  );

  it('retains an unchanged incumbent but fences a replacement mount with a fresh generation', async () => {
    const original = secureRoot('/workspace');
    const redundant = secureRoot('/workspace');
    const replacement = secureRoot('/replacement');
    const createSecureRoot = vi
      .fn<(rootPath: string) => Promise<SecureWorkspaceRoot>>()
      .mockResolvedValueOnce(original)
      .mockResolvedValueOnce(redundant)
      .mockResolvedValueOnce(replacement);
    const registry = createRegistry({
      createSecureRoot,
      resolveReadPath: async (requestedPath) => path.normalize(requestedPath),
    });
    const descriptor = await registry.addRoot(rootHandle('/workspace'));
    const first = await registry.borrowSourceRoot(descriptor.rootId, subscriber());
    await registry.addRoot(rootHandle('/workspace'));
    expect(first.signal.aborted).toBe(false);
    expect(redundant.close).toHaveBeenCalledTimes(1);
    await registry.restoreRoots();
    expect(first.signal.aborted).toBe(true);
    await expect(first.readFile('inside.txt', 37, context())).rejects.toThrow();
    const second = await registry.borrowSourceRoot(descriptor.rootId, subscriber());
    expect(second.generation).not.toBe(first.generation);
    expect(second.canonicalPath).toBe('/replacement');
    expect(original.close).toHaveBeenCalledTimes(1);
    await second.retire();
    expect(replacement.close).not.toHaveBeenCalled();
  });

  it('retains failed watch retirement for an explicit retry and suppresses late callbacks', async () => {
    const close = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error('native unsubscribe failed'))
      .mockResolvedValueOnce();
    let onBatch: Parameters<CanonicalWorkspaceLease['subscribe']>[0] | undefined;
    const subscribe = vi.fn<SubscribeMountedWorkspaceRoot>(async (_mounted, batch) => {
      onBatch = batch;
      return { close };
    });
    const root = secureRoot('/workspace');
    const { registry, rootId } = await mounted(root);
    const lease = await registry.borrowSourceRoot(rootId, subscribe);
    const batch = vi.fn();
    await lease.subscribe(batch, vi.fn(), vi.fn(), context());
    onBatch?.([]);
    expect(batch).toHaveBeenCalledTimes(1);
    await expect(lease.retire()).rejects.toThrow('retirement failed');
    onBatch?.([]);
    expect(batch).toHaveBeenCalledTimes(1);
    expect(root.close).not.toHaveBeenCalled();
    await lease.retire();
    expect(close).toHaveBeenCalledTimes(2);
    await expect(registry.readFile('/workspace/inside.txt')).resolves.toBe('inside');
  });

  it('closing one subscription suppresses its queued callbacks while retaining the mounted lease', async () => {
    let onBatch: Parameters<CanonicalWorkspaceLease['subscribe']>[0] | undefined;
    const subscribe = vi.fn<SubscribeMountedWorkspaceRoot>(async (_mounted, batch) => {
      onBatch = batch;
      return { close: vi.fn(async () => undefined) };
    });
    const { registry, rootId } = await mounted();
    const lease = await registry.borrowSourceRoot(rootId, subscribe);
    const batch = vi.fn();
    const subscription = await lease.subscribe(batch, vi.fn(), vi.fn(), context());
    onBatch?.([]);
    await subscription.close();
    onBatch?.([]);
    expect(batch).toHaveBeenCalledTimes(1);
    expect(lease.signal.aborted).toBe(false);
    await expect(lease.readFile('inside.txt', 37, context())).resolves.toMatchObject({
      status: 'ok',
    });
    await lease.retire();
  });

  it('registry disposal revokes immediately and returns only after admitted native work settles', async () => {
    const started = deferred<void>();
    const nativeRead = deferred<Awaited<ReturnType<SecureWorkspaceRoot['readFile']>>>();
    const root = {
      ...secureRoot('/workspace'),
      readFile: vi.fn(() => {
        started.resolve();
        return nativeRead.promise;
      }),
    };
    const { registry, rootId } = await mounted(root);
    const lease = await registry.borrowSourceRoot(rootId, subscriber());
    const outcome = lease.readFile('inside.txt', 37, context()).catch((error: unknown) => error);
    await started.promise;
    let disposed = false;
    const disposal = Promise.resolve(registry.dispose()).then(() => {
      disposed = true;
    });
    expect(lease.signal.aborted).toBe(true);
    await Promise.resolve();
    expect(disposed).toBe(false);
    expect(root.close).not.toHaveBeenCalled();
    nativeRead.resolve({ content: Buffer.from('late bytes'), status: 'ok' });
    expect(await outcome).toBeInstanceOf(Error);
    await disposal;
    expect(root.close).toHaveBeenCalledTimes(1);
  });
});
