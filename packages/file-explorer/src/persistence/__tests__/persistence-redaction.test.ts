import type { StorageAdapter } from '@brainstrike/storage';
import { DEFAULT_STATE, type FileExplorerState, type SerializedState } from '@brainstrike/types';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockLogger = vi.hoisted(() => ({
  debug: vi.fn(),
  error: vi.fn(),
  warn: vi.fn(),
}));

vi.mock('@brainstrike/logging', () => ({
  createLogger: vi.fn(() => mockLogger),
}));

vi.mock('../worker-init', () => ({
  initWorker: vi.fn(() => ({ useWorker: false, workerStorage: null })),
}));

vi.mock('../test-environment', () => ({
  detectTestEnvironment: vi.fn(() => false),
}));

const storageAdapter: StorageAdapter = {
  clear: vi.fn(async () => {}),
  getAllKeys: vi.fn(async () => []),
  getItem: vi.fn(async () => null),
  removeItem: vi.fn(async () => {}),
  setItem: vi.fn(async () => {}),
};

describe('file explorer persistence log redaction', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  it('never logs a persisted folder identifier or path during migration, merge, or hydration', async () => {
    const sensitivePath = '/Users/alice/secret-client-project';
    const serializedState = {
      activeRootIds: [sensitivePath],
      currentFolderId: sensitivePath,
      expandedDirectoryPaths: [],
      folderAccessOrder: [sensitivePath],
      folderStates: {},
      rootDescriptors: {
        [sensitivePath]: null,
      },
      selectedFilePaths: [],
    } as unknown as SerializedState;
    const currentState = {
      ...DEFAULT_STATE,
      currentFolderId: null,
      folderStates: {},
    } as unknown as FileExplorerState;

    const { migrateState } = await import('../state-migration');
    const { mergeState } = await import('../state-serialization');
    const { createPersistOptions } = await import('../file-explorer-persistence');

    migrateState(serializedState, 5, true);
    const mergedState = mergeState(serializedState, currentState, true);
    const persistOptions = createPersistOptions(storageAdapter);
    persistOptions.onRehydrateStorage?.(currentState)?.(mergedState, undefined);

    expect(JSON.stringify(mockLogger.debug.mock.calls)).not.toContain(sensitivePath);
  });

  it('does not expose invalid JSON through parser diagnostics', async () => {
    const sensitiveMarker = 'secret-client-payload';
    const sensitivePayload = `${sensitiveMarker} /Users/alice/source.ts`;
    const invalidJsonStorage: StorageAdapter = {
      ...storageAdapter,
      getItem: vi.fn(async () => sensitivePayload),
    };
    const { createStorageWrapper } = await import('../storage-wrapper');

    await createStorageWrapper(invalidJsonStorage, false, null, true).getItem(
      'file-explorer-storage-v5'
    );

    expect(JSON.stringify(mockLogger.error.mock.calls)).not.toContain(sensitiveMarker);
    expect(mockLogger.error).toHaveBeenCalledWith(
      'Invalid JSON from storage adapter; clearing value',
      { name: 'file-explorer-storage-v5' }
    );
  });
});
