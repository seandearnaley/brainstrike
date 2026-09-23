import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  __resetModelRegistryStoreForTests,
  type DbModel,
  useModelRegistryStore,
} from '../stores/model-registry-store';
import { __resetSettingsTestOverridesForTests } from '../testing/e2e-settings-test-overrides';

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

// This file covers the boundary between the store's toggleModel and its
// callers (see BST-1795 final review): a rejected write must surface as a
// rejected promise, not be swallowed after the revert is scheduled.
describe('model-registry-store toggleModel failure surfacing', () => {
  beforeEach(() => {
    __resetModelRegistryStoreForTests();
    __resetSettingsTestOverridesForTests();
  });

  it('rejects with the original error and schedules a registry refresh that reverts the optimistic update', async () => {
    const model = createMockModel({ id: 'model-1', isEnabled: false });
    useModelRegistryStore.setState({ models: [model] });

    const writeError = new Error('disk full');
    const refreshedProviderRows = [
      { icon: null, id: 'test-provider', is_enabled: 1, name: 'Test Provider', sort_order: 0 },
    ];
    // The refresh reloads from the database, which still has the model
    // disabled since the write never committed.
    const refreshedModelRows = [
      {
        best_for: JSON.stringify(['testing']),
        capabilities: JSON.stringify({
          defaultDimension: 768,
          streaming: false,
          type: 'embedding',
        }),
        description: 'A test model',
        icon: null,
        id: 'model-1',
        is_enabled: 0,
        name: 'Test Model',
        parameters: null,
        provider_id: 'test-provider',
        sort_order: 0,
        tagline: 'Test tagline',
      },
    ];

    const mockDb = {
      query: vi
        .fn()
        .mockRejectedValueOnce(writeError)
        .mockResolvedValueOnce({ rows: refreshedProviderRows })
        .mockResolvedValueOnce({ rows: refreshedModelRows }),
    };

    await expect(
      useModelRegistryStore.getState().toggleModel(mockDb as never, 'model-1', true)
    ).rejects.toThrow('disk full');

    await vi.waitFor(() => {
      expect(useModelRegistryStore.getState().hasLoaded).toBe(true);
    });

    expect(mockDb.query).toHaveBeenCalledTimes(3);
    expect(useModelRegistryStore.getState().models[0]?.isEnabled).toBe(false);
  });

  it('resolves and leaves the model enabled on a successful write', async () => {
    const model = createMockModel({ id: 'model-1', isEnabled: false });
    useModelRegistryStore.setState({ models: [model] });

    const mockDb = {
      query: vi.fn().mockResolvedValue({ rows: [] }),
    };

    await expect(
      useModelRegistryStore.getState().toggleModel(mockDb as never, 'model-1', true)
    ).resolves.toBeUndefined();

    expect(useModelRegistryStore.getState().models[0]?.isEnabled).toBe(true);
  });

  it('restores the previous isEnabled synchronously on a failed write, before the refresh lands', async () => {
    const model = createMockModel({ id: 'model-1', isEnabled: false });
    useModelRegistryStore.setState({ models: [model] });

    const writeError = new Error('disk full');
    // The refresh promise never resolves within this test, so if the
    // revert depended on it, the assertion below would still see `true`.
    const refreshQuery = new Promise<never>(() => {
      // intentionally never settles
    });

    const mockDb = {
      query: vi.fn().mockRejectedValueOnce(writeError).mockReturnValueOnce(refreshQuery),
    };

    await expect(
      useModelRegistryStore.getState().toggleModel(mockDb as never, 'model-1', true)
    ).rejects.toThrow('disk full');

    // Assert immediately after the rejection settles, without waiting for
    // the scheduled fetchRegistry refresh to resolve.
    expect(useModelRegistryStore.getState().models[0]?.isEnabled).toBe(false);
  });

  it('leaves the model at its previous value when both the write and the refresh fail', async () => {
    const model = createMockModel({ id: 'model-1', isEnabled: false });
    useModelRegistryStore.setState({ models: [model] });

    const writeError = new Error('disk full');
    const refreshError = new Error('refresh also failed');

    const mockDb = {
      query: vi.fn().mockRejectedValueOnce(writeError).mockRejectedValueOnce(refreshError),
    };

    await expect(
      useModelRegistryStore.getState().toggleModel(mockDb as never, 'model-1', true)
    ).rejects.toThrow('disk full');

    expect(useModelRegistryStore.getState().models[0]?.isEnabled).toBe(false);

    // Let the scheduled (failing) fetchRegistry refresh settle too, and
    // confirm the restored value survives that failure.
    await vi.waitFor(() => {
      expect(mockDb.query).toHaveBeenCalledTimes(2);
    });
    expect(useModelRegistryStore.getState().models[0]?.isEnabled).toBe(false);
  });
});
