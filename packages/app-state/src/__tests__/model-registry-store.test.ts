import { INTERNAL_FAULT } from '@brainstrike/assistant-contract/boundary-failure';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  __resetModelRegistryStoreForTests,
  type DbModel,
  type DbProvider,
  useModelRegistryStore,
} from '../stores/model-registry-store';
import {
  __resetSettingsTestOverridesForTests,
  __setSettingsTestOverridesForTests,
} from './settings-test-overrides-test-helper';

// Mock @brainstrike/logging logger
vi.mock('@brainstrike/logging', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@brainstrike/logging')>();
  return {
    ...actual,
    createLogger: () => ({
      debug: vi.fn(),
      error: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
    }),
  };
});

const createMockProvider = (overrides: Partial<DbProvider> = {}): DbProvider => ({
  icon: null,
  id: 'test-provider',
  isEnabled: true,
  name: 'Test Provider',
  sortOrder: 0,
  ...overrides,
});

const createMockModel = (overrides: Partial<DbModel> = {}): DbModel => ({
  bestFor: ['testing'],
  capabilities: {
    defaultDimension: 768,
    streaming: false,
    type: 'embedding',
  },
  description: 'A test model',
  icon: null,
  id: 'test-model',
  isEnabled: true,
  name: 'Test Model',
  parameters: null,
  providerId: 'test-provider',
  sortOrder: 0,
  tagline: 'Test tagline',
  ...overrides,
});

function createRowsDeferred(): {
  promise: Promise<{ models: []; providers: [] }>;
  resolve: () => void;
} {
  let resolvePromise: (value: { models: []; providers: [] }) => void = () => {};
  const promise = new Promise<{ models: []; providers: [] }>((resolve) => {
    resolvePromise = resolve;
  });
  return {
    promise,
    resolve: () => resolvePromise({ models: [], providers: [] }),
  };
}

describe('model-registry-store', () => {
  beforeEach(() => {
    __resetModelRegistryStoreForTests();
    __resetSettingsTestOverridesForTests();
  });

  describe('initial state', () => {
    it('has empty providers array', () => {
      expect(useModelRegistryStore.getState().providers).toEqual([]);
    });

    it('has empty models array', () => {
      expect(useModelRegistryStore.getState().models).toEqual([]);
    });

    it('has isLoading set to false', () => {
      expect(useModelRegistryStore.getState().isLoading).toBe(false);
    });

    it('has error set to null', () => {
      expect(useModelRegistryStore.getState().error).toBe(null);
    });

    it('has hasLoaded set to false', () => {
      expect(useModelRegistryStore.getState().hasLoaded).toBe(false);
    });

    it('has empty downloadProgress', () => {
      expect(useModelRegistryStore.getState().downloadProgress).toEqual({});
    });

    it('has empty isDownloading', () => {
      expect(useModelRegistryStore.getState().isDownloading).toEqual({});
    });

    it('has empty downloadedModels', () => {
      expect(useModelRegistryStore.getState().downloadedModels).toEqual({});
    });
  });

  // BST-2241: only the embedding realm's model cache says what is downloaded.
  describe('applyDownloadedModelsRead', () => {
    it("replaces every earlier answer with the realm's", () => {
      useModelRegistryStore.getState().applyDownloadedModelsRead(['a', 'b'], 0);
      useModelRegistryStore.getState().applyDownloadedModelsRead(['b'], 0);
      expect(useModelRegistryStore.getState().downloadedModels).toEqual({ b: true });
    });

    it('keeps a download that completed while the read ran', () => {
      const readStartedAt = useModelRegistryStore.getState().downloadSequence;
      useModelRegistryStore.getState().setDownloadProgress('x', 100);

      useModelRegistryStore.getState().applyDownloadedModelsRead(['y'], readStartedAt);

      expect(useModelRegistryStore.getState().downloadedModels).toEqual({ x: true, y: true });
    });

    it('lets a read that began after a download decide it', () => {
      useModelRegistryStore.getState().setDownloadProgress('x', 100);
      const readStartedAt = useModelRegistryStore.getState().downloadSequence;

      useModelRegistryStore.getState().applyDownloadedModelsRead(['y'], readStartedAt);

      expect(useModelRegistryStore.getState().downloadedModels).toEqual({ y: true });
    });

    it('is never persisted, so a cleared cache is never claimed from storage', () => {
      useModelRegistryStore.getState().applyDownloadedModelsRead(['a'], 0);
      expect(window.localStorage.getItem('model-registry-storage')).toBeNull();
    });

    it('survives a registry fetch, which reads no disk path or flag', async () => {
      useModelRegistryStore.getState().applyDownloadedModelsRead(['local-model'], 0);
      await useModelRegistryStore.getState().fetchRegistry({
        read: async () => ({ models: [createMockModel({ id: 'local-model' })], providers: [] }),
      } as never);
      expect(useModelRegistryStore.getState().downloadedModels).toEqual({ 'local-model': true });
    });
  });

  describe('setDownloadProgress', () => {
    it('sets download progress for a model', () => {
      useModelRegistryStore.getState().setDownloadProgress('model-1', 50);
      expect(useModelRegistryStore.getState().downloadProgress['model-1']).toBe(50);
    });

    it('sets multiple model progress independently', () => {
      useModelRegistryStore.getState().setDownloadProgress('model-1', 25);
      useModelRegistryStore.getState().setDownloadProgress('model-2', 75);
      expect(useModelRegistryStore.getState().downloadProgress['model-1']).toBe(25);
      expect(useModelRegistryStore.getState().downloadProgress['model-2']).toBe(75);
    });

    it('marks model as downloaded when progress reaches 100', () => {
      useModelRegistryStore.getState().setDownloadProgress('model-1', 100);
      expect(useModelRegistryStore.getState().downloadedModels['model-1']).toBe(true);
    });

    it('does not mark model as downloaded for progress less than 100', () => {
      useModelRegistryStore.getState().setDownloadProgress('model-1', 99);
      expect(useModelRegistryStore.getState().downloadedModels['model-1']).toBeUndefined();
    });

    it('does not notify for progress ticks within the same rounded integer percent', () => {
      useModelRegistryStore.getState().setDownloadProgress('model-1', 42.2);
      const listener = vi.fn();
      const unsubscribe = useModelRegistryStore.subscribe(listener);

      useModelRegistryStore.getState().setDownloadProgress('model-1', 42.4);
      unsubscribe();

      expect(useModelRegistryStore.getState().downloadProgress['model-1']).toBe(42);
      expect(listener).not.toHaveBeenCalled();
    });

    it('keeps downloadedModels identity across progress ticks below completion', () => {
      const before = useModelRegistryStore.getState().downloadedModels;

      useModelRegistryStore.getState().setDownloadProgress('model-1', 42.2);
      const afterFirstTick = useModelRegistryStore.getState().downloadedModels;
      useModelRegistryStore.getState().setDownloadProgress('model-1', 43);

      expect(afterFirstTick).toBe(before);
      expect(useModelRegistryStore.getState().downloadedModels).toBe(before);
    });

    it('creates downloadedModels identity and notifies on completion', () => {
      useModelRegistryStore.getState().setDownloadProgress('model-1', 99);
      const before = useModelRegistryStore.getState().downloadedModels;
      const listener = vi.fn();
      const unsubscribe = useModelRegistryStore.subscribe(listener);

      useModelRegistryStore.getState().setDownloadProgress('model-1', 100);
      unsubscribe();

      expect(useModelRegistryStore.getState().downloadedModels).not.toBe(before);
      expect(useModelRegistryStore.getState().downloadedModels['model-1']).toBe(true);
      expect(listener).toHaveBeenCalledTimes(1);
    });

    it('notifies when progress crosses a rounded integer boundary', () => {
      useModelRegistryStore.getState().setDownloadProgress('model-1', 42.4);
      const listener = vi.fn();
      const unsubscribe = useModelRegistryStore.subscribe(listener);

      useModelRegistryStore.getState().setDownloadProgress('model-1', 43);
      unsubscribe();

      expect(useModelRegistryStore.getState().downloadProgress['model-1']).toBe(43);
      expect(listener).toHaveBeenCalledTimes(1);
    });
  });

  describe('setDownloading', () => {
    it('sets downloading state for a model', () => {
      useModelRegistryStore.getState().setDownloading('model-1', true);
      expect(useModelRegistryStore.getState().isDownloading['model-1']).toBe(true);
    });

    it('can set downloading to false', () => {
      useModelRegistryStore.getState().setDownloading('model-1', true);
      useModelRegistryStore.getState().setDownloading('model-1', false);
      expect(useModelRegistryStore.getState().isDownloading['model-1']).toBe(false);
    });

    it('sets multiple model downloading states independently', () => {
      useModelRegistryStore.getState().setDownloading('model-1', true);
      useModelRegistryStore.getState().setDownloading('model-2', false);
      expect(useModelRegistryStore.getState().isDownloading['model-1']).toBe(true);
      expect(useModelRegistryStore.getState().isDownloading['model-2']).toBe(false);
    });
  });

  describe('fetchRegistry', () => {
    it('sets isLoading to true while fetching', async () => {
      const mockDb = {
        read: vi.fn().mockImplementation(() => new Promise(() => {})), // Never resolves
      };

      void useModelRegistryStore.getState().fetchRegistry(mockDb as never);
      expect(useModelRegistryStore.getState().isLoading).toBe(true);
    });

    it('surfaces a test override fetch error without reading the catalog', async () => {
      __setSettingsTestOverridesForTests({
        modelRegistry: { fetchErrorMessage: 'model registry failed in test' },
      });

      const mockDb = {
        read: vi.fn(),
      };

      await useModelRegistryStore.getState().fetchRegistry(mockDb as never);

      expect(mockDb.read).not.toHaveBeenCalled();
      expect(useModelRegistryStore.getState().error).toBe('model registry failed in test');
      expect(useModelRegistryStore.getState().hasLoaded).toBe(false);
    });

    it('handles fetch error and sets error state', async () => {
      const mockDb = {
        read: vi.fn().mockRejectedValue(new Error('Database connection failed')),
      };

      await useModelRegistryStore.getState().fetchRegistry(mockDb as never);

      expect(useModelRegistryStore.getState().isLoading).toBe(false);
      expect(useModelRegistryStore.getState().error).toBe(INTERNAL_FAULT.message);
    });

    it('keeps downloaded models when cache directory is unavailable', async () => {
      useModelRegistryStore.setState({
        downloadedModels: { 'local-model': true },
      });

      const mockDb = {
        read: vi.fn().mockResolvedValue({
          models: [createMockModel({ id: 'local-model', providerId: 'local' })],
          providers: [createMockProvider({ id: 'local' })],
        }),
      };

      await useModelRegistryStore.getState().fetchRegistry(mockDb as never);

      expect(useModelRegistryStore.getState().downloadedModels['local-model']).toBe(true);
    });
  });

  describe('ensureRegistry', () => {
    it('dedupes concurrent fetches while loading', async () => {
      const snapshot = createRowsDeferred();
      const mockDb = {
        read: vi.fn().mockReturnValueOnce(snapshot.promise),
      };

      const first = useModelRegistryStore.getState().ensureRegistry(mockDb as never);
      const second = useModelRegistryStore.getState().ensureRegistry(mockDb as never);

      expect(mockDb.read).toHaveBeenCalledTimes(1);
      expect(second).toBe(first);

      snapshot.resolve();
      await first;
    });
  });

  describe('__resetModelRegistryStoreForTests', () => {
    it('resets all state to initial values', () => {
      // Set some state
      useModelRegistryStore.setState({
        downloadedModels: { 'model-1': true },
        downloadProgress: { 'model-1': 50 },
        error: 'Some error',
        hasLoaded: true,
        isDownloading: { 'model-1': true },
        isLoading: true,
        models: [createMockModel()],
        providers: [createMockProvider()],
      });

      // Reset
      __resetModelRegistryStoreForTests();

      // Verify reset
      const state = useModelRegistryStore.getState();
      expect(state.providers).toEqual([]);
      expect(state.models).toEqual([]);
      expect(state.isLoading).toBe(false);
      expect(state.error).toBe(null);
      expect(state.hasLoaded).toBe(false);
      expect(state.downloadProgress).toEqual({});
      expect(state.isDownloading).toEqual({});
      expect(state.downloadedModels).toEqual({});
    });
  });
});
