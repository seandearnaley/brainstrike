import type { FileExplorerState } from '@brainstrike/types';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockLogger = vi.hoisted(() => ({
  debug: vi.fn(),
  error: vi.fn(),
  warn: vi.fn(),
}));

vi.mock('@brainstrike/utils/logger', () => ({
  createLogger: vi.fn(() => mockLogger),
}));

vi.mock('../worker-init', () => ({
  initWorker: vi.fn(() => ({ useWorker: false, workerStorage: null })),
}));

function withClearedTestMarkers<T>(run: () => Promise<T>): Promise<T> {
  const globalRecord = globalThis as Record<string, unknown>;
  const originalVitest = globalRecord.vitest;
  const originalJest = globalRecord.jest;
  const originalWorker = globalRecord.__vitest_worker__;

  Reflect.deleteProperty(globalRecord, 'vitest');
  Reflect.deleteProperty(globalRecord, 'jest');
  Reflect.deleteProperty(globalRecord, '__vitest_worker__');

  return run().finally(() => {
    if (originalVitest !== undefined) {
      globalRecord.vitest = originalVitest;
    }
    if (originalJest !== undefined) {
      globalRecord.jest = originalJest;
    }
    if (originalWorker !== undefined) {
      globalRecord.__vitest_worker__ = originalWorker;
    }
  });
}

describe('file-explorer-persistence coverage', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllEnvs();
    mockLogger.debug.mockReset();
    mockLogger.warn.mockReset();
    mockLogger.error.mockReset();
  });

  it('migrates the legacy localStorage key and logs in dev browser mode', async () => {
    const values = new Map<string, string>([['fileExplorerSettings', '{"legacy":true}']]);
    (globalThis as Record<string, unknown>).localStorage = {
      clear: vi.fn(),
      getItem: vi.fn((key: string) => values.get(key) ?? null),
      key: vi.fn(),
      length: 0,
      removeItem: vi.fn((key: string) => values.delete(key)),
      setItem: vi.fn((key: string, value: string) => values.set(key, value)),
    };
    vi.stubEnv('NODE_ENV', 'development');

    await withClearedTestMarkers(async () => {
      const mod = await import('../file-explorer-persistence');
      mod.createPersistOptions({
        clear: async () => {},
        getAllKeys: async () => [],
        getItem: async () => null,
        removeItem: async () => {},
        setItem: async () => {},
      });
    });

    expect(values.get('file-explorer-storage-v5')).toBe('{"legacy":true}');
    expect(values.get('fileExplorerSettings')).toBeUndefined();
    expect(mockLogger.debug).toHaveBeenCalledWith(
      'Migrating settings from legacy key "fileExplorerSettings" to "file-explorer-storage-v5"'
    );
  });

  it('logs a warning when legacy key migration hits a localStorage error', async () => {
    (globalThis as Record<string, unknown>).localStorage = {
      clear: vi.fn(),
      getItem: vi.fn(() => {
        throw new Error('localStorage blocked');
      }),
      key: vi.fn(),
      length: 0,
      removeItem: vi.fn(),
      setItem: vi.fn(),
    };
    vi.stubEnv('NODE_ENV', 'development');

    await withClearedTestMarkers(async () => {
      const mod = await import('../file-explorer-persistence');
      mod.createPersistOptions({
        clear: async () => {},
        getAllKeys: async () => [],
        getItem: async () => null,
        removeItem: async () => {},
        setItem: async () => {},
      });
    });

    expect(mockLogger.warn).toHaveBeenCalledWith(
      'Could not perform legacy settings migration:',
      expect.any(Error)
    );
  });

  it('logs rehydrate success and failure in dev browser mode', async () => {
    vi.stubEnv('NODE_ENV', 'development');
    const hydratedState = {
      currentFolderId: 'folder-1',
      folderAccessOrder: [],
      folderStates: { a: {}, b: {} },
    } as unknown as FileExplorerState;

    await withClearedTestMarkers(async () => {
      const mod = await import('../file-explorer-persistence');
      const persistOptions = mod.createPersistOptions({
        clear: async () => {},
        getAllKeys: async () => [],
        getItem: async () => null,
        removeItem: async () => {},
        setItem: async () => {},
      });
      const callback = persistOptions.onRehydrateStorage?.();
      callback?.(hydratedState, undefined);
      callback?.(hydratedState, new Error('rehydration failed'));
    });

    expect(mockLogger.debug).toHaveBeenCalledWith(
      'onRehydrateStorage - Storage rehydrated. Folder count:',
      2,
      'Current folder:',
      'folder-1'
    );
    expect(mockLogger.warn).toHaveBeenCalledWith(
      'onRehydrateStorage - Storage rehydration failed:',
      expect.any(Error)
    );
  });

  it('warns when the rehydrated state shape is invalid', async () => {
    vi.stubEnv('NODE_ENV', 'development');

    await withClearedTestMarkers(async () => {
      const mod = await import('../file-explorer-persistence');
      const persistOptions = mod.createPersistOptions({
        clear: async () => {},
        getAllKeys: async () => [],
        getItem: async () => null,
        removeItem: async () => {},
        setItem: async () => {},
      });
      const callback = persistOptions.onRehydrateStorage?.();
      callback?.(
        { folderAccessOrder: null, folderStates: null } as unknown as FileExplorerState,
        undefined
      );
    });

    expect(mockLogger.warn).toHaveBeenCalledWith(
      'onRehydrateStorage - Rehydrated state shape was invalid'
    );
  });

  it('does not warn for a minimally valid rehydrated state shape', async () => {
    vi.stubEnv('NODE_ENV', 'development');

    await withClearedTestMarkers(async () => {
      const mod = await import('../file-explorer-persistence');
      const persistOptions = mod.createPersistOptions({
        clear: async () => {},
        getAllKeys: async () => [],
        getItem: async () => null,
        removeItem: async () => {},
        setItem: async () => {},
      });
      const callback = persistOptions.onRehydrateStorage?.();
      callback?.(
        {
          currentFolderId: null,
          folderAccessOrder: [],
          folderStates: {},
        } as unknown as FileExplorerState,
        undefined
      );
    });

    expect(mockLogger.warn).not.toHaveBeenCalledWith(
      'onRehydrateStorage - Rehydrated state shape was invalid'
    );
  });
});
