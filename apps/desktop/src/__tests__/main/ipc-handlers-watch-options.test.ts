import type { ElectronFileSystemAdapter } from '@brainstrike/file-system/electron';
import { startJoinedParcelWatch } from '@brainstrike/file-system/native-watch';
import type { ElectronStorageAdapter } from '@brainstrike/storage/electron';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { FileSystemIpcDomain } from '../../ipc-domains/file-system-ipc';
import type { StartFileSystemWatch } from '../../ipc-domains/file-system-watch-ipc';
import { registerStoragePreferencesIpcHandlers } from '../../ipc-domains/storage-preferences-ipc';
import {
  createRegistry,
  rootHandle,
  secureRoot,
} from '../ipc-domains/workspace-root-registry-test-helpers';

const watcherComposition = vi.hoisted(() => ({
  domain: null as FileSystemIpcDomain | null,
  startWatch: null as StartFileSystemWatch | null,
}));

vi.mock('@brainstrike/file-system/native-watch', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@brainstrike/file-system/native-watch')>()),
  startJoinedParcelWatch: vi.fn(),
}));

vi.mock('../../ipc-domains/file-system-watch-ipc', () => ({
  registerFileSystemWatchIpcHandlers: vi.fn((options: { startWatch: StartFileSystemWatch }) => {
    watcherComposition.startWatch = options.startWatch;
    return async () => undefined;
  }),
}));

vi.mock('../../ipc-domains/file-system-ipc', () => ({
  createFileSystemIpcDomain: vi.fn(() => {
    if (!watcherComposition.domain) {
      throw new Error('Missing test filesystem domain.');
    }
    return watcherComposition.domain;
  }),
}));

vi.mock('../../ipc-domains/storage-preferences-ipc', () => ({
  registerStoragePreferencesIpcHandlers: vi.fn(() => () => undefined),
}));

import { createApplicationIpcDomain } from '../../ipc-handlers';

async function fixture() {
  const root = secureRoot('/workspace');
  const createSecureRoot = vi.fn(async () => root);
  const roots = createRegistry({
    createSecureRoot,
    resolveReadPath: async (requested) => requested,
  });
  const descriptor = await roots.addRoot(rootHandle('/workspace'));
  watcherComposition.domain = { close: () => roots.dispose(), roots, unregister: vi.fn() };
  const stop = vi.fn<() => Promise<void>>(async () => undefined);
  vi.mocked(startJoinedParcelWatch).mockResolvedValue(stop);
  const domain = createApplicationIpcDomain(
    {} as ElectronFileSystemAdapter,
    {} as ElectronStorageAdapter,
    () => null,
    {
      getRootsCatalog: async () => {
        throw new Error('Unexpected catalog read in injected domain fixture');
      },
    }
  );
  const start = watcherComposition.startWatch;
  if (!start) {
    throw new Error('Missing test visible watch factory.');
  }
  return { createSecureRoot, domain, root, rootId: descriptor.rootId, start, stop };
}

describe('Explorer watcher composition', () => {
  beforeEach(() => {
    watcherComposition.startWatch = null;
    watcherComposition.domain = null;
    vi.clearAllMocks();
  });

  it('uses the existing pinned mount and enables bounded default-filter reporting', async () => {
    const f = await fixture();
    const watch = await f.start('/workspace', vi.fn(), vi.fn());
    expect(startJoinedParcelWatch).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ path: '/workspace', platform: 'electron' }),
      expect.any(Function),
      expect.objectContaining({ reportDefaultFilteredChanges: true })
    );
    expect(f.createSecureRoot).toHaveBeenCalledTimes(1);
    await watch.close();
    expect(f.root.close).not.toHaveBeenCalled();
    await f.domain.close();
  });

  it('retains the utility borrow when the visible subscription closes', async () => {
    const f = await fixture();
    const lease = await f.domain.roots.borrowSourceRoot(f.rootId, (mounted, ...callbacks) =>
      f.domain.watches.subscribe(mounted, ...callbacks)
    );
    await lease.subscribe(vi.fn(), vi.fn(), vi.fn(), {
      requestId: 'utility-source-test',
      signal: new AbortController().signal,
    });
    const visible = await f.start('/workspace', vi.fn(), vi.fn());
    expect(startJoinedParcelWatch).toHaveBeenCalledTimes(1);
    await visible.close();
    expect(f.stop).not.toHaveBeenCalled();
    await lease.retire();
    expect(f.stop).toHaveBeenCalledTimes(1);
    await f.domain.close();
  });

  it('joins the actual native watch before application close releases the pinned mount', async () => {
    const f = await fixture();
    await f.start('/workspace', vi.fn(), vi.fn());
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
    const failure = new Error('Storage IPC unregister failed.');
    vi.mocked(registerStoragePreferencesIpcHandlers).mockReturnValueOnce(() => {
      throw failure;
    });
    const f = await fixture();
    await f.start('/workspace', vi.fn(), vi.fn());

    await expect(Promise.resolve().then(() => f.domain.close())).rejects.toMatchObject({
      errors: expect.arrayContaining([failure]),
      name: 'AggregateError',
    });
    expect(f.stop).toHaveBeenCalledTimes(1);
    expect(f.root.close).toHaveBeenCalledTimes(1);
  });
});
