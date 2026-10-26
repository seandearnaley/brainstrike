import { INTERNAL_FAULT } from '@brainstrike/assistant-contract/boundary-failure';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  __resetModelRegistryStoreForTests,
  type DbModel,
  type DbProvider,
  useModelRegistryStore,
} from '../stores/model-registry-store.ts';
import {
  __resetSettingsTestOverridesForTests,
  __setSettingsTestOverridesForTests,
} from './settings-test-overrides-test-helper.ts';

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
        error: 'Some error',
        hasLoaded: true,
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
    });
  });
});
