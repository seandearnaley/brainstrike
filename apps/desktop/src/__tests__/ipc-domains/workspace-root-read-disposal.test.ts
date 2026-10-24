import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { SecureWorkspaceRoot } from '../../ipc-domains/workspace-root-types';
import {
  createRegistry,
  createStorage,
  rootHandle,
  secureRoot,
} from './workspace-root-registry-test-helpers';

type Registry = ReturnType<typeof createRegistry>;
type ReadKind = 'directory' | 'file' | 'absolute';
const ROOT = path.resolve('/workspace');

function read(registry: Registry, rootId: string, kind: ReadKind): Promise<unknown> {
  if (kind === 'directory') {
    return registry.readDirectory({ ...rootHandle(ROOT), rootId });
  }
  const filePath = path.join(ROOT, 'inside.txt');
  if (kind === 'absolute') {
    return registry.readFileByAbsolutePath(filePath, ROOT, rootId);
  }
  return registry.readFile({
    kind: 'file',
    name: 'inside.txt',
    path: filePath,
    platform: 'electron',
    rootId,
  });
}

async function mounted(
  root: SecureWorkspaceRoot,
  overrides: Parameters<typeof createRegistry>[0] = {}
) {
  const registry = createRegistry({
    createSecureRoot: async () => root,
    resolveReadPath: async (requested) => requested,
    ...overrides,
  });
  const descriptor = await registry.addRoot(rootHandle(ROOT));
  return { registry, rootId: descriptor.rootId };
}

function flush(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

describe('WorkspaceRootRegistry direct read disposal (BST-2251)', () => {
  it.each(['directory', 'file', 'absolute'] as const)(
    'joins admitted %s I/O and concurrent disposal while refusing new reads',
    async (kind) => {
      const entered = Promise.withResolvers<void>();
      const native = Promise.withResolvers<void>();
      const root = {
        ...secureRoot(ROOT),
        listDir: vi.fn(async () => {
          entered.resolve();
          await native.promise;
          return { entries: [], inspected: 0, truncated: false };
        }),
        readFile: vi.fn(async () => {
          entered.resolve();
          await native.promise;
          return { content: Buffer.from('inside'), status: 'ok' as const };
        }),
      };
      const { registry, rootId } = await mounted(root);
      const reading = read(registry, rootId, kind);
      await entered.promise;
      const disposing = registry.dispose();
      expect(registry.dispose()).toBe(disposing);
      let disposed = false;
      const observed = disposing.then(() => {
        disposed = true;
      });
      try {
        await flush();
        expect(disposed).toBe(false);
        expect(root.close).not.toHaveBeenCalled();
        await expect(read(registry, rootId, kind)).rejects.toMatchObject({
          code: 'workspace.root-registry-disposed',
        });
        expect(root.listDir.mock.calls.length + root.readFile.mock.calls.length).toBe(1);
        native.resolve();
        await expect(reading).resolves.toEqual(kind === 'directory' ? [] : 'inside');
        await observed;
        expect(root.close).toHaveBeenCalledOnce();
      } finally {
        native.resolve();
        await Promise.allSettled([reading, observed]);
      }
    }
  );

  it('settles a rejected read without losing its cause or closing beside another pending read', async () => {
    const failed = Promise.withResolvers<Awaited<ReturnType<SecureWorkspaceRoot['readFile']>>>();
    const held = Promise.withResolvers<Awaited<ReturnType<SecureWorkspaceRoot['readFile']>>>();
    const root = {
      ...secureRoot(ROOT),
      readFile: vi.fn((relative: string) =>
        relative === 'bad.txt' ? failed.promise : held.promise
      ),
    };
    const { registry } = await mounted(root);
    const bad = registry.readFile(path.join(ROOT, 'bad.txt')).catch((error: unknown) => error);
    const good = registry.readFile(path.join(ROOT, 'good.txt'));
    await vi.waitFor(() => expect(root.readFile).toHaveBeenCalledTimes(2));
    let disposed = false;
    const disposing = registry.dispose().then(() => {
      disposed = true;
    });
    const failure = new Error('Native read rejected');
    try {
      failed.reject(failure);
      expect(await bad).toBe(failure);
      await flush();
      expect(disposed).toBe(false);
      expect(root.close).not.toHaveBeenCalled();
      held.resolve({ content: Buffer.from('kept bytes'), status: 'ok' });
      await expect(good).resolves.toBe('kept bytes');
      await disposing;
      expect(root.close).toHaveBeenCalledOnce();
    } finally {
      failed.reject(failure);
      held.resolve({ content: Buffer.from('kept bytes'), status: 'ok' });
      await Promise.allSettled([bad, good, disposing]);
    }
  });

  it('joins a late path-resolution continuation through its eventual native completion', async () => {
    const resolving = Promise.withResolvers<void>();
    const pathReady = Promise.withResolvers<void>();
    const nativeStarted = Promise.withResolvers<void>();
    const native = Promise.withResolvers<void>();
    const root = {
      ...secureRoot(ROOT),
      readFile: vi.fn(async () => {
        nativeStarted.resolve();
        await native.promise;
        return { content: Buffer.from('late bytes'), status: 'ok' as const };
      }),
    };
    const { registry } = await mounted(root, {
      resolveReadPath: async (requested) => {
        resolving.resolve();
        await pathReady.promise;
        return requested;
      },
    });
    const reading = registry.readFile(path.join(ROOT, 'inside.txt'));
    await resolving.promise;
    const disposing = registry.dispose();
    try {
      await flush();
      expect(root.close).not.toHaveBeenCalled();
      pathReady.resolve();
      await nativeStarted.promise;
      expect(root.close).not.toHaveBeenCalled();
      native.resolve();
      await expect(reading).resolves.toBe('late bytes');
      await disposing;
      expect(root.close).toHaveBeenCalledOnce();
    } finally {
      pathReady.resolve();
      native.resolve();
      await Promise.allSettled([reading, disposing]);
    }
  });

  it('joins direct reads, mutation completion and source-lease retirement without a cycle', async () => {
    const direct = Promise.withResolvers<void>();
    const source = Promise.withResolvers<void>();
    const mutation = Promise.withResolvers<void>();
    const mutationEntered = Promise.withResolvers<void>();
    const root = {
      ...secureRoot(ROOT),
      readFile: vi.fn(async (relative: string) => {
        await (relative === 'direct.txt' ? direct.promise : source.promise);
        return { content: Buffer.from(relative), status: 'ok' as const };
      }),
    };
    const storage = createStorage();
    const { registry, rootId } = await mounted(root, { storage });
    const lease = await registry.borrowSourceRoot(rootId, async () => ({
      close: async () => undefined,
    }));
    const reading = registry.readFile(path.join(ROOT, 'direct.txt'));
    const borrowed = lease
      .readFile('source.txt', 100, {
        requestId: 'source-disposal',
        signal: new AbortController().signal,
      })
      .catch((error: unknown) => error);
    await vi.waitFor(() => expect(root.readFile).toHaveBeenCalledTimes(2));
    vi.mocked(storage.setItem).mockImplementationOnce(async () => {
      mutationEntered.resolve();
      await mutation.promise;
    });
    const writing = registry.setLastFolder(ROOT);
    await mutationEntered.promise;
    const disposing = registry.dispose();
    try {
      mutation.resolve();
      await writing;
      direct.resolve();
      await expect(reading).resolves.toBe('direct.txt');
      expect(root.close).not.toHaveBeenCalled();
      source.resolve();
      expect(await borrowed).toBeInstanceOf(Error);
      await disposing;
      expect(root.close).toHaveBeenCalledOnce();
    } finally {
      mutation.resolve();
      direct.resolve();
      source.resolve();
      await Promise.allSettled([writing, reading, borrowed, disposing]);
    }
  });

  it('joins direct work before reporting a failed source retirement, retaining the mount for retry', async () => {
    const native = Promise.withResolvers<void>();
    const root = {
      ...secureRoot(ROOT),
      readFile: vi.fn(async () => {
        await native.promise;
        return { content: Buffer.from('inside'), status: 'ok' as const };
      }),
    };
    const failure = new Error('Source watcher unsubscribe failed');
    const stop = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(failure)
      .mockResolvedValue(undefined);
    const { registry, rootId } = await mounted(root);
    const lease = await registry.borrowSourceRoot(rootId, async () => ({ close: stop }));
    await lease.subscribe(vi.fn(), vi.fn(), vi.fn(), {
      requestId: 'failed-source-retirement',
      signal: new AbortController().signal,
    });
    const reading = registry.readFile(path.join(ROOT, 'inside.txt'));
    await vi.waitFor(() => expect(root.readFile).toHaveBeenCalledOnce());
    let settled = false;
    const disposing = registry.dispose().catch((error: unknown) => {
      settled = true;
      return error;
    });
    try {
      await vi.waitFor(() => expect(stop).toHaveBeenCalledOnce());
      await flush();
      expect(settled).toBe(false);
      expect(root.close).not.toHaveBeenCalled();
      native.resolve();
      await expect(reading).resolves.toBe('inside');
      const retirement = await disposing;
      expect(retirement).toBeInstanceOf(AggregateError);
      if (!(retirement instanceof AggregateError)) {
        throw new Error('Expected source retirement to reject with an AggregateError.');
      }
      expect(retirement.errors[0]).toBeInstanceOf(AggregateError);
      expect(retirement.errors[0].errors[0]).toBe(failure);
      expect(root.close).not.toHaveBeenCalled();
      await registry.dispose();
      expect(stop).toHaveBeenCalledTimes(2);
      expect(root.close).toHaveBeenCalledOnce();
    } finally {
      native.resolve();
      await Promise.allSettled([reading, disposing]);
      await registry.dispose();
    }
  });
});
