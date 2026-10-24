import type { FileSystemAdapter, RootDescriptor } from '@brainstrike/types';
import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const loggerMock = vi.hoisted(() => ({
  debug: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
}));
vi.mock('@brainstrike/logging', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@brainstrike/logging')>()),
  createLogger: () => loggerMock,
}));

import { resetRootRegistrationEventsForTests } from '../roots/root-registration-events';
import { useRootsReconciliation } from '../roots/use-roots-reconciliation';

function grantedRootWithPath(rootId: string, name: string, path: string): RootDescriptor {
  return {
    displayName: name,
    handle: { kind: 'directory', name, path, platform: 'electron' },
    kind: 'path',
    permissionState: 'granted',
    persisted: true,
    rootId,
  };
}
function makeAdapter(overrides: Partial<FileSystemAdapter>): FileSystemAdapter {
  return overrides as FileSystemAdapter;
}
beforeEach(() => {
  vi.clearAllMocks();
  resetRootRegistrationEventsForTests();
  window.worktrees = {
    adopt: vi.fn(),
    archive: vi.fn(),
    checkoutStatus: vi.fn(),
    create: vi.fn(),
    createBranchHere: vi.fn(),
    createContext: vi.fn(),
    getSettings: vi.fn(),
    inspectArchive: vi.fn(),
    list: vi.fn(),
    listManagedPaths: vi.fn(async () => ({ ok: true as const, value: [] })),
    restore: vi.fn(),
    setSettings: vi.fn(),
  };
});
afterEach(() => {
  Reflect.deleteProperty(window, 'worktrees');
});

describe('native root registration notification', () => {
  it('does not reconfigure a normal boot that only maps host-recorded roots', async () => {
    const root = grantedRootWithPath('native-root', 'native', '/workspace/native');
    const rootsRegistered = vi.fn(async () => {});
    const adapter = makeAdapter({
      ownsRootRecords: true,
      platform: 'electron',
      restoreRoots: async () => [root],
    });
    const { result } = renderHook(() =>
      useRootsReconciliation({ adapter, registration: { rootsRegistered } })
    );
    await act(async () => {
      await expect(result.current.resolveDbRootId(root.handle.path)).resolves.toBe(root.rootId);
    });
    expect(rootsRegistered).not.toHaveBeenCalled();
  });

  it('reports rejected activation while preserving the committed root', async () => {
    const root = grantedRootWithPath('native-root', 'native', '/workspace/native');
    const failure = new Error('Native writer unavailable');
    const registration = {
      rootsRegistered: vi.fn(async () => {
        throw failure;
      }),
    };
    const adapter = makeAdapter({
      ownsRootRecords: true,
      platform: 'electron',
      restoreRoots: async () => [],
    });
    const { result } = renderHook(() => useRootsReconciliation({ adapter, registration }));
    await waitFor(() => expect(result.current.rootsReconciliationSettled).toBe(true));
    await act(async () => {
      await result.current.registerRoot(root);
    });
    await waitFor(() =>
      expect(loggerMock.error).toHaveBeenCalledWith(
        'Native index refresh after root registration failed',
        { error: failure }
      )
    );
    await expect(result.current.resolveDbRootId(root.handle.path, root.rootId)).resolves.toBe(
      root.rootId
    );
  });

  it('notifies Main after a mid-session registration without waiting for native ingestion', async () => {
    const root = grantedRootWithPath('native-root', 'native', '/workspace/native');
    const ingestion = Promise.withResolvers<void>();
    const rootsRegistered = vi.fn(() => ingestion.promise);
    const adapter = makeAdapter({
      ownsRootRecords: true,
      platform: 'electron',
      restoreRoots: async () => [],
    });
    try {
      const { result } = renderHook(() =>
        useRootsReconciliation({ adapter, registration: { rootsRegistered } })
      );
      await waitFor(() => expect(result.current.rootsReconciliationSettled).toBe(true));
      expect(rootsRegistered).not.toHaveBeenCalled();
      await act(async () => {
        await result.current.registerRoot(root);
      });
      await waitFor(() => expect(rootsRegistered).toHaveBeenCalledExactlyOnceWith());
      await expect(result.current.resolveDbRootId(root.handle.path, root.rootId)).resolves.toBe(
        root.rootId
      );
      expect(result.current.rootsReconciliationSettled).toBe(true);
    } finally {
      ingestion.resolve();
    }
  });
});
