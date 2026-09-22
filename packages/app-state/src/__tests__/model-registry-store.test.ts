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
} from '../testing/e2e-settings-test-overrides';

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
  promise: Promise<{ rows: [] }>;
  resolve: () => void;
} {
  let resolvePromise: (value: { rows: [] }) => void = () => {};
  const promise = new Promise<{ rows: [] }>((resolve) => {
    resolvePromise = resolve;
  });
  return {
    promise,
    resolve: () => resolvePromise({ rows: [] }),
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

    it('has modelCacheDir set to null', () => {
      expect(useModelRegistryStore.getState().modelCacheDir).toBe(null);
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

  describe('setModelCacheDir', () => {
    it('sets the model cache directory', () => {
      useModelRegistryStore.getState().setModelCacheDir('/custom/path');
      expect(useModelRegistryStore.getState().modelCacheDir).toBe('/custom/path');
    });

    it('overwrites previous value', () => {
      useModelRegistryStore.getState().setModelCacheDir('/first/path');
      useModelRegistryStore.getState().setModelCacheDir('/second/path');
      expect(useModelRegistryStore.getState().modelCacheDir).toBe('/second/path');
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
        query: vi.fn().mockImplementation(() => new Promise(() => {})), // Never resolves
      };

      void useModelRegistryStore.getState().fetchRegistry(mockDb as never);
      expect(useModelRegistryStore.getState().isLoading).toBe(true);
    });

    it('fetches providers and models from database', async () => {
      const mockProviderRows = [
        { icon: null, id: 'openai', is_enabled: 1, name: 'OpenAI', sort_order: 0 },
      ];
      const mockModelRows = [
        {
          best_for: JSON.stringify(['chat', 'code']),
          capabilities: JSON.stringify({ streaming: true, type: 'llm' }),
          description: 'Advanced LLM',
          icon: null,
          id: 'gpt-5.2',
          is_enabled: 1,
          name: 'GPT-5.2',
          parameters: null,
          provider_id: 'openai',
          sort_order: 0,
          tagline: 'Most capable',
        },
      ];

      const mockDb = {
        query: vi
          .fn()
          .mockResolvedValueOnce({ rows: mockProviderRows })
          .mockResolvedValueOnce({ rows: mockModelRows }),
      };

      await useModelRegistryStore.getState().fetchRegistry(mockDb as never);

      expect(useModelRegistryStore.getState().isLoading).toBe(false);
      expect(useModelRegistryStore.getState().hasLoaded).toBe(true);
      expect(useModelRegistryStore.getState().providers).toHaveLength(1);
      expect(useModelRegistryStore.getState().providers[0]?.name).toBe('OpenAI');
      expect(useModelRegistryStore.getState().models).toHaveLength(1);
      expect(useModelRegistryStore.getState().models[0]?.name).toBe('GPT-5.2');
    });

    it('surfaces a test override fetch error without querying the database', async () => {
      __setSettingsTestOverridesForTests({
        modelRegistry: { fetchErrorMessage: 'model registry failed in test' },
      });

      const mockDb = {
        query: vi.fn(),
      };

      await useModelRegistryStore.getState().fetchRegistry(mockDb as never);

      expect(mockDb.query).not.toHaveBeenCalled();
      expect(useModelRegistryStore.getState().error).toBe('model registry failed in test');
      expect(useModelRegistryStore.getState().hasLoaded).toBe(false);
    });

    it('parses JSON fields correctly', async () => {
      const mockProviderRows = [
        { icon: null, id: 'test', is_enabled: true, name: 'Test', sort_order: 0 },
      ];
      const mockModelRows = [
        {
          best_for: ['tag1', 'tag2'], // Already parsed object
          capabilities: { defaultDimension: 384, type: 'embedding' }, // Already parsed
          description: 'Test',
          icon: null,
          id: 'model-1',
          is_enabled: true,
          name: 'Test Model',
          parameters: { size: '100MB' }, // Already parsed
          provider_id: 'test',
          sort_order: 0,
          tagline: null,
        },
      ];

      const mockDb = {
        query: vi
          .fn()
          .mockResolvedValueOnce({ rows: mockProviderRows })
          .mockResolvedValueOnce({ rows: mockModelRows }),
      };

      await useModelRegistryStore.getState().fetchRegistry(mockDb as never);

      const model = useModelRegistryStore.getState().models[0];
      expect(model?.bestFor).toEqual(['tag1', 'tag2']);
      expect(model?.capabilities.type).toBe('embedding');
      expect(model?.parameters).toEqual({ size: '100MB' });
    });

    it('handles fetch error and sets error state', async () => {
      const mockDb = {
        query: vi.fn().mockRejectedValue(new Error('Database connection failed')),
      };

      await useModelRegistryStore.getState().fetchRegistry(mockDb as never);

      expect(useModelRegistryStore.getState().isLoading).toBe(false);
      expect(useModelRegistryStore.getState().error).toBe('Database connection failed');
    });

    it('keeps downloaded models when cache directory is unavailable', async () => {
      useModelRegistryStore.setState({
        downloadedModels: { 'local-model': true },
      });

      const mockProviderRows = [
        { icon: null, id: 'local', is_enabled: true, name: 'Local', sort_order: 0 },
      ];
      const mockModelRows = [
        {
          best_for: null,
          capabilities: JSON.stringify({ type: 'embedding' }),
          description: 'Local model',
          icon: null,
          id: 'local-model',
          is_enabled: true,
          name: 'Local Model',
          parameters: null,
          provider_id: 'local',
          sort_order: 0,
          tagline: null,
        },
      ];

      const mockDb = {
        query: vi
          .fn()
          .mockResolvedValueOnce({ rows: mockProviderRows })
          .mockResolvedValueOnce({ rows: mockModelRows }),
      };

      await useModelRegistryStore.getState().fetchRegistry(mockDb as never);

      expect(useModelRegistryStore.getState().downloadedModels['local-model']).toBe(true);
    });

    it('preserves downloaded state when filesystem checks fail', async () => {
      const originalElectronAPI = (window as unknown as { electronAPI?: unknown }).electronAPI;
      try {
        (window as unknown as { electronAPI?: unknown }).electronAPI = {
          fileSystem: {
            exists: vi.fn().mockRejectedValue(new Error('fs unavailable')),
          },
        };

        useModelRegistryStore.setState({
          downloadedModels: { 'local-model': true },
          modelCacheDir: '/cache',
        });

        const mockProviderRows = [
          { icon: null, id: 'local', is_enabled: true, name: 'Local', sort_order: 0 },
        ];
        const mockModelRows = [
          {
            best_for: null,
            capabilities: JSON.stringify({ type: 'embedding' }),
            description: 'Local model',
            icon: null,
            id: 'local-model',
            is_enabled: true,
            name: 'Local Model',
            parameters: null,
            provider_id: 'local',
            sort_order: 0,
            tagline: null,
          },
        ];

        const mockDb = {
          query: vi
            .fn()
            .mockResolvedValueOnce({ rows: mockProviderRows })
            .mockResolvedValueOnce({ rows: mockModelRows }),
        };

        await useModelRegistryStore.getState().fetchRegistry(mockDb as never);

        expect(useModelRegistryStore.getState().downloadedModels['local-model']).toBe(true);
      } finally {
        (window as unknown as { electronAPI?: unknown }).electronAPI = originalElectronAPI;
      }
    });
  });

  describe('ensureRegistry', () => {
    it('dedupes concurrent fetches while loading', async () => {
      let resolveProviders!: (value: { rows: [] }) => void;
      const providersPromise = new Promise<{ rows: [] }>((resolve) => {
        resolveProviders = resolve;
      });

      const mockDb = {
        query: vi.fn().mockReturnValueOnce(providersPromise).mockResolvedValueOnce({ rows: [] }),
      };

      const first = useModelRegistryStore.getState().ensureRegistry(mockDb as never);
      const second = useModelRegistryStore.getState().ensureRegistry(mockDb as never);

      expect(mockDb.query).toHaveBeenCalledTimes(1);
      expect(second).toBe(first);

      resolveProviders({ rows: [] });
      await first;
    });
  });

  describe('toggleModel', () => {
    it('optimistically updates model enabled state', async () => {
      const model = createMockModel({ id: 'model-1', isEnabled: false });
      useModelRegistryStore.setState({ models: [model] });

      const mockDb = {
        query: vi.fn().mockResolvedValue({ rows: [] }),
      };

      await useModelRegistryStore.getState().toggleModel(mockDb as never, 'model-1', true);

      expect(useModelRegistryStore.getState().models[0]?.isEnabled).toBe(true);
    });

    it('calls database update with correct parameters', async () => {
      const model = createMockModel({ id: 'model-1', isEnabled: false });
      useModelRegistryStore.setState({ models: [model] });

      const mockDb = {
        query: vi.fn().mockResolvedValue({ rows: [] }),
      };

      await useModelRegistryStore.getState().toggleModel(mockDb as never, 'model-1', true);

      expect(mockDb.query).toHaveBeenCalledWith(
        'UPDATE models SET is_enabled = $1, updated_at = NOW() WHERE id = $2',
        [true, 'model-1']
      );
    });

    it('waits for durable filesystem sync when the database exposes it', async () => {
      const model = createMockModel({ id: 'model-1', isEnabled: false });
      const events: string[] = [];
      useModelRegistryStore.setState({ models: [model] });

      const mockDb = {
        query: vi.fn(async () => {
          events.push('query');
          return { rows: [] };
        }),
        syncToFs: vi.fn(async () => {
          events.push('sync');
        }),
      };

      await useModelRegistryStore.getState().toggleModel(mockDb as never, 'model-1', true);

      expect(events).toEqual(['query', 'sync']);
      expect(mockDb.syncToFs).toHaveBeenCalledTimes(1);
    });

    it('does not bypass the database handle boundary to sync a raw handle', async () => {
      const model = createMockModel({ id: 'model-1', isEnabled: false });
      useModelRegistryStore.setState({ models: [model] });

      const events: string[] = [];
      const raw = {
        marker: 'raw-sync-receiver',
        syncToFs: vi.fn(async function (this: { readonly marker: string }) {
          events.push(this.marker);
        }),
      };
      const mockDb = {
        query: vi.fn(async () => {
          events.push('query');
          return { rows: [] };
        }),
        raw,
      };

      await useModelRegistryStore.getState().toggleModel(mockDb as never, 'model-1', true);

      expect(events).toEqual(['query']);
      expect(raw.syncToFs).not.toHaveBeenCalled();
    });

    it('keeps the committed toggle state if a registry refresh races the update', async () => {
      const model = createMockModel({ id: 'model-1', isEnabled: false });
      useModelRegistryStore.setState({ models: [model] });

      const updateFinished = createRowsDeferred();
      const mockDb = {
        query: vi.fn().mockReturnValue(updateFinished.promise),
      };

      const toggleFinished = useModelRegistryStore
        .getState()
        .toggleModel(mockDb as never, 'model-1', true);
      expect(useModelRegistryStore.getState().models[0]?.isEnabled).toBe(true);

      useModelRegistryStore.setState({ models: [{ ...model, isEnabled: false }] });
      updateFinished.resolve();
      await toggleFinished;

      expect(useModelRegistryStore.getState().models[0]?.isEnabled).toBe(true);
    });
  });

  describe('initializeProviderModelDefaults', () => {
    const llmCapabilities = { streaming: true, type: 'llm' } as const;
    const untouchedRows = [
      {
        capabilities: llmCapabilities,
        created_at: '2026-07-22T12:00:00.000Z',
        id: 'model-a',
        is_enabled: false,
        updated_at: '2026-07-22T12:00:00.000Z',
      },
      {
        capabilities: llmCapabilities,
        created_at: '2026-07-22T12:00:00.000Z',
        id: 'model-b',
        is_enabled: false,
        updated_at: '2026-07-22T12:00:00.000Z',
      },
    ];

    it('durably enables the recommended set for an untouched provider catalog', async () => {
      useModelRegistryStore.setState({
        models: [
          createMockModel({ id: 'model-a', isEnabled: false, providerId: 'openrouter' }),
          createMockModel({ id: 'model-b', isEnabled: false, providerId: 'openrouter' }),
        ],
      });
      const events: string[] = [];
      const mockDb = {
        query: vi
          .fn()
          .mockResolvedValueOnce({ rows: untouchedRows })
          .mockImplementationOnce(async () => {
            events.push('update');
            return { rows: [{ id: 'model-a' }, { id: 'model-b' }] };
          }),
        syncToFs: vi.fn(async () => {
          events.push('sync');
        }),
      };

      const result = await useModelRegistryStore
        .getState()
        .initializeProviderModelDefaults(mockDb as never, 'openrouter', {
          kind: 'seed',
          modelIds: ['model-a', 'model-b'],
        });

      expect(result).toBe('initialized');
      expect(events).toEqual(['update', 'sync']);
      expect(mockDb.query).toHaveBeenNthCalledWith(
        1,
        expect.stringContaining('FROM models WHERE provider_id = $1'),
        ['openrouter']
      );
      expect(mockDb.query).toHaveBeenNthCalledWith(
        2,
        expect.stringContaining('UPDATE models SET is_enabled = true, updated_at = NOW()'),
        ['openrouter', 'model-a', 'model-b']
      );
      expect(useModelRegistryStore.getState().models.map((model) => model.isEnabled)).toEqual([
        true,
        true,
      ]);
    });

    it('preserves an existing enabled-model choice exactly', async () => {
      const mockDb = {
        query: vi.fn().mockResolvedValue({
          rows: [{ ...untouchedRows[0], is_enabled: 1 }, untouchedRows[1]],
        }),
        syncToFs: vi.fn(),
      };

      const result = await useModelRegistryStore
        .getState()
        .initializeProviderModelDefaults(mockDb as never, 'openrouter', {
          kind: 'seed',
          modelIds: ['model-a', 'model-b'],
        });

      expect(result).toBe('preserved');
      expect(mockDb.query).toHaveBeenCalledTimes(1);
      expect(mockDb.syncToFs).not.toHaveBeenCalled();
    });

    it('preserves an explicit choice before requiring every recommended catalog row', async () => {
      const mockDb = {
        query: vi.fn().mockResolvedValue({
          rows: [{ ...untouchedRows[0], is_enabled: 1 }],
        }),
        syncToFs: vi.fn(),
      };

      const result = await useModelRegistryStore
        .getState()
        .initializeProviderModelDefaults(mockDb as never, 'openrouter', {
          kind: 'seed',
          modelIds: ['model-a', 'model-b'],
        });

      expect(result).toBe('preserved');
      expect(mockDb.query).toHaveBeenCalledTimes(1);
      expect(mockDb.syncToFs).not.toHaveBeenCalled();
    });

    it('fails closed on malformed catalog timestamps even when an enabled choice exists', async () => {
      const mockDb = {
        query: vi.fn().mockResolvedValue({
          rows: [
            { ...untouchedRows[0], is_enabled: true },
            { ...untouchedRows[1], updated_at: 'not-a-timestamp' },
          ],
        }),
      };

      await expect(
        useModelRegistryStore
          .getState()
          .initializeProviderModelDefaults(mockDb as never, 'openrouter', {
            kind: 'seed',
            modelIds: ['model-a', 'model-b'],
          })
      ).rejects.toThrow('invalid updated_at timestamp');
    });

    it('preserves an explicit all-disabled choice using the durable update timestamp', async () => {
      const mockDb = {
        query: vi.fn().mockResolvedValue({
          rows: [
            {
              ...untouchedRows[0],
              updated_at: '2026-07-22T12:01:00.000Z',
            },
            untouchedRows[1],
          ],
        }),
        syncToFs: vi.fn(),
      };

      const result = await useModelRegistryStore
        .getState()
        .initializeProviderModelDefaults(mockDb as never, 'openrouter', {
          kind: 'seed',
          modelIds: ['model-a', 'model-b'],
        });

      expect(result).toBe('preserved');
      expect(mockDb.query).toHaveBeenCalledTimes(1);
      expect(mockDb.syncToFs).not.toHaveBeenCalled();
    });

    it('fails closed when a recommended model is missing from the provider catalog', async () => {
      const mockDb = {
        query: vi.fn().mockResolvedValue({ rows: [untouchedRows[0]] }),
      };

      await expect(
        useModelRegistryStore
          .getState()
          .initializeProviderModelDefaults(mockDb as never, 'openrouter', {
            kind: 'seed',
            modelIds: ['model-a', 'model-b'],
          })
      ).rejects.toThrow('model-b');
      expect(mockDb.query).toHaveBeenCalledTimes(1);
    });

    it('rejects a failed write without changing the in-memory registry', async () => {
      useModelRegistryStore.setState({
        models: [createMockModel({ id: 'model-a', isEnabled: false, providerId: 'openrouter' })],
      });
      const mockDb = {
        query: vi
          .fn()
          .mockResolvedValueOnce({ rows: [untouchedRows[0]] })
          .mockRejectedValueOnce(new Error('disk write failed')),
      };

      await expect(
        useModelRegistryStore
          .getState()
          .initializeProviderModelDefaults(mockDb as never, 'openrouter', {
            kind: 'seed',
            modelIds: ['model-a'],
          })
      ).rejects.toThrow('disk write failed');
      expect(useModelRegistryStore.getState().models[0]?.isEnabled).toBe(false);
    });

    it('enables an untouched row the catalog shipped disabled (BST-1794)', async () => {
      // The bug, stated: an anthropic profile holding its migration-057 rows
      // enabled and `claude-opus-5` shipped false. The provider-wide predicate
      // saw one enabled row and preserved everything, so the new model was
      // unreachable forever.
      useModelRegistryStore.setState({
        models: [
          createMockModel({ id: 'claude-sonnet-5', isEnabled: true, providerId: 'anthropic' }),
          createMockModel({ id: 'claude-opus-5', isEnabled: false, providerId: 'anthropic' }),
        ],
      });
      const mockDb = {
        query: vi
          .fn()
          .mockResolvedValueOnce({
            rows: [
              {
                capabilities: llmCapabilities,
                created_at: '2026-07-22T12:00:00.000Z',
                id: 'claude-sonnet-5',
                is_enabled: true,
                updated_at: '2026-07-22T12:00:00.000Z',
              },
              {
                capabilities: llmCapabilities,
                created_at: '2026-09-04T12:00:00.000Z',
                id: 'claude-opus-5',
                is_enabled: false,
                updated_at: '2026-09-04T12:00:00.000Z',
              },
            ],
          })
          .mockResolvedValueOnce({ rows: [{ id: 'claude-opus-5' }] }),
        syncToFs: vi.fn(async () => undefined),
      };

      const result = await useModelRegistryStore
        .getState()
        .initializeProviderModelDefaults(mockDb as never, 'anthropic', { kind: 'all' });

      expect(result).toBe('initialized');
      expect(mockDb.query).toHaveBeenNthCalledWith(
        2,
        expect.stringContaining('UPDATE models SET is_enabled = true, updated_at = NOW()'),
        ['anthropic', 'claude-opus-5']
      );
      expect(
        useModelRegistryStore.getState().models.find((model) => model.id === 'claude-opus-5')
          ?.isEnabled
      ).toBe(true);
    });

    it('leaves a row the user deliberately disabled switched off', async () => {
      useModelRegistryStore.setState({
        models: [createMockModel({ id: 'gpt-5.4', isEnabled: false, providerId: 'openai' })],
      });
      const mockDb = {
        query: vi.fn().mockResolvedValueOnce({
          rows: [
            {
              capabilities: llmCapabilities,
              created_at: '2026-07-22T12:00:00.000Z',
              id: 'gpt-5.4',
              is_enabled: false,
              // A later updated_at is the durable record of a user toggle;
              // catalog upserts never write this column.
              updated_at: '2026-08-01T09:30:00.000Z',
            },
          ],
        }),
        syncToFs: vi.fn(async () => undefined),
      };

      const result = await useModelRegistryStore
        .getState()
        .initializeProviderModelDefaults(mockDb as never, 'openai', { kind: 'all' });

      expect(result).toBe('preserved');
      expect(mockDb.query).toHaveBeenCalledTimes(1);
      expect(mockDb.syncToFs).not.toHaveBeenCalled();
    });

    it('never touches embedding rows under an availability policy', async () => {
      useModelRegistryStore.setState({
        models: [
          createMockModel({ id: 'text-embedding-3-large', isEnabled: false, providerId: 'openai' }),
        ],
      });
      const mockDb = {
        query: vi.fn().mockResolvedValueOnce({
          rows: [
            {
              capabilities: { defaultDimension: 3072, type: 'embedding' },
              created_at: '2026-07-22T12:00:00.000Z',
              id: 'text-embedding-3-large',
              is_enabled: false,
              updated_at: '2026-07-22T12:00:00.000Z',
            },
          ],
        }),
        syncToFs: vi.fn(async () => undefined),
      };

      const result = await useModelRegistryStore
        .getState()
        .initializeProviderModelDefaults(mockDb as never, 'openai', { kind: 'all' });

      expect(result).toBe('preserved');
      expect(mockDb.query).toHaveBeenCalledTimes(1);
    });

    it('preserves a curated profile under a seed policy', async () => {
      // The other half of the split: a user who picked 3 of 58 OpenRouter
      // routes must not silently acquire the recommended set.
      useModelRegistryStore.setState({
        models: [createMockModel({ id: 'model-a', isEnabled: true, providerId: 'openrouter' })],
      });
      const mockDb = {
        query: vi.fn().mockResolvedValueOnce({
          rows: [
            {
              capabilities: llmCapabilities,
              created_at: '2026-07-22T12:00:00.000Z',
              id: 'model-a',
              is_enabled: true,
              updated_at: '2026-07-22T12:00:00.000Z',
            },
          ],
        }),
        syncToFs: vi.fn(async () => undefined),
      };

      const result = await useModelRegistryStore
        .getState()
        .initializeProviderModelDefaults(mockDb as never, 'openrouter', {
          kind: 'seed',
          modelIds: ['model-a', 'model-b'],
        });

      expect(result).toBe('preserved');
      expect(mockDb.query).toHaveBeenCalledTimes(1);
    });
  });

  describe('toggleProvider', () => {
    it('optimistically updates provider enabled state', async () => {
      const provider = createMockProvider({ id: 'provider-1', isEnabled: false });
      useModelRegistryStore.setState({ providers: [provider] });

      const mockDb = {
        query: vi.fn().mockResolvedValue({ rows: [] }),
      };

      await useModelRegistryStore.getState().toggleProvider(mockDb as never, 'provider-1', true);

      expect(useModelRegistryStore.getState().providers[0]?.isEnabled).toBe(true);
    });

    it('calls database update with correct parameters', async () => {
      const provider = createMockProvider({ id: 'provider-1', isEnabled: false });
      useModelRegistryStore.setState({ providers: [provider] });

      const mockDb = {
        query: vi.fn().mockResolvedValue({ rows: [] }),
      };

      await useModelRegistryStore.getState().toggleProvider(mockDb as never, 'provider-1', true);

      expect(mockDb.query).toHaveBeenCalledWith(
        'UPDATE providers SET is_enabled = $1, updated_at = NOW() WHERE id = $2',
        [true, 'provider-1']
      );
    });

    it('waits for durable filesystem sync when a provider is toggled', async () => {
      const provider = createMockProvider({ id: 'provider-1', isEnabled: false });
      useModelRegistryStore.setState({ providers: [provider] });

      const syncToFs = vi.fn().mockResolvedValue(undefined);
      const mockDb = {
        query: vi.fn().mockResolvedValue({ rows: [] }),
        syncToFs,
      };

      await useModelRegistryStore.getState().toggleProvider(mockDb as never, 'provider-1', true);

      expect(syncToFs).toHaveBeenCalledTimes(1);
    });

    it('keeps the committed toggle state if a registry refresh races the update', async () => {
      const provider = createMockProvider({ id: 'provider-1', isEnabled: false });
      useModelRegistryStore.setState({ providers: [provider] });

      const updateFinished = createRowsDeferred();
      const mockDb = {
        query: vi.fn().mockReturnValue(updateFinished.promise),
      };

      const toggleFinished = useModelRegistryStore
        .getState()
        .toggleProvider(mockDb as never, 'provider-1', true);
      expect(useModelRegistryStore.getState().providers[0]?.isEnabled).toBe(true);

      useModelRegistryStore.setState({ providers: [{ ...provider, isEnabled: false }] });
      updateFinished.resolve();
      await toggleFinished;

      expect(useModelRegistryStore.getState().providers[0]?.isEnabled).toBe(true);
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
        modelCacheDir: '/custom/path',
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
      expect(state.modelCacheDir).toBe(null);
      expect(state.downloadProgress).toEqual({});
      expect(state.isDownloading).toEqual({});
      expect(state.downloadedModels).toEqual({});
    });
  });
});
