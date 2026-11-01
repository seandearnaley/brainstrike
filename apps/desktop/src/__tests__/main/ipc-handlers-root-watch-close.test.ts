import path from 'node:path';
import type { ElectronFileSystemAdapter } from '@brainstrike/file-system/electron';
import { startJoinedRootWatch } from '@brainstrike/file-system/native-watch';
import type { ElectronStorageAdapter } from '@brainstrike/storage/electron';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { FileSystemIpcDomain } from '../../ipc-domains/file-system-ipc';
import { registerWorkspaceLedgersE2eHandlers } from '../../ipc-domains/workspace-ledgers-e2e-ipc';
import { createApplicationIpcDomain } from '../../ipc-handlers';
import {
  createRegistry,
  rootHandle,
  secureRoot,
} from '../ipc-domains/workspace-root-registry-test-helpers';

const WORKSPACE = path.resolve('/workspace');

const watcherComposition = vi.hoisted(() => ({
  domain: null as FileSystemIpcDomain | null,
}));

vi.mock('@brainstrike/file-system/native-watch', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@brainstrike/file-system/native-watch')>()),
  startJoinedRootWatch: vi.fn(),
}));

vi.mock('../../ipc-domains/file-system-ipc', () => ({
  createFileSystemIpcDomain: vi.fn(() => {
    if (!watcherComposition.domain) {
      throw new Error('Missing test filesystem domain.');
    }
    return watcherComposition.domain;
  }),
}));

vi.mock('../../ipc-domains/workspace-ledgers-e2e-ipc', () => ({
  registerWorkspaceLedgersE2eHandlers: vi.fn(() => () => undefined),
}));

async function fixture() {
  const root = secureRoot(WORKSPACE);
  const createSecureRoot = vi.fn(async () => root);
  const roots = createRegistry({
    createSecureRoot,
    resolveReadPath: async (requested) => requested,
  });
  const descriptor = await roots.addRoot(rootHandle(WORKSPACE));
  watcherComposition.domain = { close: () => roots.dispose(), roots, unregister: vi.fn() };
  const stop = vi.fn<() => Promise<void>>(async () => undefined);
  vi.mocked(startJoinedRootWatch).mockResolvedValue(stop);
  const domain = createApplicationIpcDomain(
    {} as ElectronFileSystemAdapter,
    {} as ElectronStorageAdapter,
    {
      getRootsCatalog: async () => {
        throw new Error('Unexpected catalog read in injected domain fixture');
      },
    }
  );
  /** The native index's borrow of the folder and its watch. */
  const start = async () => {
    const lease = await domain.roots.borrowSourceRoot(descriptor.rootId, (mounted, ...callbacks) =>
      domain.watches.subscribe(mounted, ...callbacks)
    );
    await lease.subscribe(vi.fn(), vi.fn(), vi.fn(), {
      requestId: 'utility-source-test',
      signal: new AbortController().signal,
    });
    return lease;
  };
  return { createSecureRoot, domain, root, start, stop };
}

describe('mounted root watch composition', () => {
  beforeEach(() => {
    watcherComposition.domain = null;
    vi.clearAllMocks();
  });

  it('joins the actual native watch before application close releases the pinned mount', async () => {
    const f = await fixture();
    await f.start();
    const exit = Promise.withResolvers<void>();
    f.stop.mockReturnValueOnce(exit.promise);
    let closed = false;
    const closing = f.domain.close().then(() => {
      closed = true;
    });
    await vi.waitFor(() => expect(f.stop).toHaveBeenCalledTimes(1));
    expect(closed).toBe(false);
    expect(f.root.close).not.toHaveBeenCalled();
    exit.resolve();
    await closing;
    expect(f.root.close).toHaveBeenCalledTimes(1);
  });

  it('retires native owners even when an independent IPC unregister throws', async () => {
    const failure = new Error('Ledger IPC unregister failed.');
    vi.mocked(registerWorkspaceLedgersE2eHandlers).mockReturnValueOnce(() => {
      throw failure;
    });
    const f = await fixture();
    await f.start();

    await expect(Promise.resolve().then(() => f.domain.close())).rejects.toMatchObject({
      errors: expect.arrayContaining([failure]),
      name: 'AggregateError',
    });
    expect(f.stop).toHaveBeenCalledTimes(1);
    expect(f.root.close).toHaveBeenCalledTimes(1);
  });
});
