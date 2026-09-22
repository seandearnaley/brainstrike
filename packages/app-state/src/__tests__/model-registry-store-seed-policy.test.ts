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

describe('initializeProviderModelDefaults — seed drift vs. the curated-provider gate (BST-1794 follow-up)', () => {
  beforeEach(() => {
    __resetModelRegistryStoreForTests();
    __resetSettingsTestOverridesForTests();
  });

  it('rejects a seed id missing from the catalog even when the provider is already curated', async () => {
    useModelRegistryStore.setState({
      models: [createMockModel({ id: 'model-a', isEnabled: true, providerId: 'openrouter' })],
    });
    const mockDb = {
      // The provider has an enabled row (`model-a`), so
      // `hasExplicitProviderModelChoice` would return true — but a seed id
      // absent from the catalog (`model-missing`) must still throw rather
      // than being hidden behind the curated-provider 'preserved' return.
      query: vi.fn().mockResolvedValueOnce({
        rows: [
          {
            capabilities: { streaming: true, type: 'llm' },
            created_at: '2026-07-22T12:00:00.000Z',
            id: 'model-a',
            is_enabled: true,
            updated_at: '2026-09-01T12:00:00.000Z',
          },
        ],
      }),
      syncToFs: vi.fn(async () => undefined),
    };

    await expect(
      useModelRegistryStore
        .getState()
        .initializeProviderModelDefaults(mockDb as never, 'openrouter', {
          kind: 'seed',
          modelIds: ['model-a', 'model-missing'],
        })
    ).rejects.toThrow(/missing from the catalog.*model-missing/);

    expect(mockDb.query).toHaveBeenCalledTimes(1);
    expect(mockDb.syncToFs).not.toHaveBeenCalled();
  });

  it('still preserves a curated provider when every seed id exists in the catalog', async () => {
    useModelRegistryStore.setState({
      models: [createMockModel({ id: 'model-a', isEnabled: true, providerId: 'openrouter' })],
    });
    const mockDb = {
      query: vi.fn().mockResolvedValueOnce({
        rows: [
          {
            capabilities: { streaming: true, type: 'llm' },
            created_at: '2026-07-22T12:00:00.000Z',
            id: 'model-a',
            is_enabled: true,
            updated_at: '2026-09-01T12:00:00.000Z',
          },
        ],
      }),
      syncToFs: vi.fn(async () => undefined),
    };

    const result = await useModelRegistryStore
      .getState()
      .initializeProviderModelDefaults(mockDb as never, 'openrouter', {
        kind: 'seed',
        modelIds: ['model-a'],
      });

    expect(result).toBe('preserved');
    expect(mockDb.query).toHaveBeenCalledTimes(1);
    expect(mockDb.syncToFs).not.toHaveBeenCalled();
  });
});
