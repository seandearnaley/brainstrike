import type { ElectronFileSystemAdapter } from '@brainstrike/file-system/electron';
import type { ElectronStorageAdapter } from '@brainstrike/storage/electron';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const watcherComposition = vi.hoisted(() => ({
  startWatch: null as
    | ((directoryPath: string, onChanges: () => void, onHealth: () => void) => () => void)
    | null,
}));

vi.mock('../../ipc-domains/file-system-watch-ipc', () => ({
  registerFileSystemWatchIpcHandlers: vi.fn(
    (options: {
      startWatch: (
        directoryPath: string,
        onChanges: () => void,
        onHealth: () => void
      ) => () => void;
    }) => {
      watcherComposition.startWatch = options.startWatch;
      return () => undefined;
    }
  ),
}));

vi.mock('../../ipc-domains/file-system-ipc', () => ({
  registerFileSystemIpcHandlers: vi.fn(() => () => undefined),
}));

vi.mock('../../ipc-domains/storage-preferences-ipc', () => ({
  registerStoragePreferencesIpcHandlers: vi.fn(() => () => undefined),
}));

vi.mock('../../ipc-domains/db-ipc', () => ({
  cleanupDesktopLiveSubscriptionsForShutdown: vi.fn(),
  flushPendingLiveUpdates: vi.fn(),
  isDesktopDatabaseBackgrounded: vi.fn(() => false),
  registerDatabaseIpcHandlers: vi.fn(() => () => undefined),
  setBackgrounded: vi.fn(),
}));

vi.mock('../../ipc-domains/embedding-backfill-ipc', () => ({
  registerEmbeddingBackfillIpcHandlers: vi.fn(() => () => undefined),
}));

import { registerIpcHandlers } from '../../ipc-handlers';

describe('Explorer watcher composition', () => {
  beforeEach(() => {
    watcherComposition.startWatch = null;
    vi.clearAllMocks();
  });

  it('enables bounded default-filter reporting only in the main fs:watch owner', () => {
    const stop = vi.fn();
    const watchDirectory = vi.fn(() => stop);
    const fileSystem = { watchDirectory } as unknown as ElectronFileSystemAdapter;
    const storage = {} as ElectronStorageAdapter;
    const unregister = registerIpcHandlers(fileSystem, storage, () => null);

    expect(watcherComposition.startWatch).not.toBeNull();
    watcherComposition.startWatch?.('/workspace', vi.fn(), vi.fn());

    expect(watchDirectory).toHaveBeenCalledWith(
      expect.objectContaining({ path: '/workspace', platform: 'electron' }),
      expect.any(Function),
      undefined,
      expect.objectContaining({ reportDefaultFilteredChanges: true })
    );
    unregister();
  });
});
