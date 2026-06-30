import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTursoOwnerClient, type TursoOwnerClient } from '@brainstrike/db/turso/owner-client';
import { applyTursoSchemaBaseline } from '@brainstrike/db/turso/schema-baseline';
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

// Mock @brainstrike/utils logger
vi.mock('@brainstrike/utils', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@brainstrike/utils')>();
  return {
    ...actual,
    createLogger: () => ({
      info: vi.fn(),
      error: vi.fn(),
      warn: vi.fn(),
      debug: vi.fn(),
    }),
  };
});

const createMockProvider = (overrides: Partial<DbProvider> = {}): DbProvider => ({
  id: 'test-provider',
  name: 'Test Provider',
  icon: null,
  isEnabled: true,
  sortOrder: 0,
  ...overrides,
});

const createMockModel = (overrides: Partial<DbModel> = {}): DbModel => ({
  id: 'test-model',
  providerId: 'test-provider',
  name: 'Test Model',
  description: 'A test model',
  tagline: 'Test tagline',
  bestFor: ['testing'],
  icon: null,
  isEnabled: true,
  capabilities: {
    type: 'embedding',
    streaming: false,
    defaultDimension: 768,
  },
  parameters: null,
  sortOrder: 0,
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

const ISO_UTC_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

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
        { id: 'openai', name: 'OpenAI', icon: null, is_enabled: 1, sort_order: 0 },
      ];
      const mockModelRows = [
        {
          id: 'gpt-5.2',
          provider_id: 'openai',
          name: 'GPT-5.2',
          description: 'Advanced LLM',
          tagline: 'Most capable',
          best_for: JSON.stringify(['chat', 'code']),
          icon: null,
          is_enabled: 1,
          capabilities: JSON.stringify({ type: 'llm', streaming: true }),
          parameters: null,
          sort_order: 0,
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
        { id: 'test', name: 'Test', icon: null, is_enabled: true, sort_order: 0 },
      ];
      const mockModelRows = [
        {
          id: 'model-1',
          provider_id: 'test',
          name: 'Test Model',
          description: 'Test',
          tagline: null,
          best_for: ['tag1', 'tag2'], // Already parsed object
          icon: null,
          is_enabled: true,
          capabilities: { type: 'embedding', defaultDimension: 384 }, // Already parsed
          parameters: { size: '100MB' }, // Already parsed
          sort_order: 0,
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
        { id: 'local', name: 'Local', icon: null, is_enabled: true, sort_order: 0 },
      ];
      const mockModelRows = [
        {
          id: 'local-model',
          provider_id: 'local',
          name: 'Local Model',
          description: 'Local model',
          tagline: null,
          best_for: null,
          icon: null,
          is_enabled: true,
          capabilities: JSON.stringify({ type: 'embedding' }),
          parameters: null,
          sort_order: 0,
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
          modelCacheDir: '/cache',
          downloadedModels: { 'local-model': true },
        });

        const mockProviderRows = [
          { id: 'local', name: 'Local', icon: null, is_enabled: true, sort_order: 0 },
        ];
        const mockModelRows = [
          {
            id: 'local-model',
            provider_id: 'local',
            name: 'Local Model',
            description: 'Local model',
            tagline: null,
            best_for: null,
            icon: null,
            is_enabled: true,
            capabilities: JSON.stringify({ type: 'embedding' }),
            parameters: null,
            sort_order: 0,
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
    it('persists model toggles through a Turso owner client', async () => {
      const { client, cleanup } = await createTursoRegistryClient();
      try {
        await useModelRegistryStore.getState().toggleModel(client as never, 'gpt-5.5', false);

        const result = await client.query<{ is_enabled: number; updated_at: string }>(
          'SELECT is_enabled, updated_at FROM models WHERE id = ?',
          ['gpt-5.5']
        );
        expect(result.rows[0]?.is_enabled).toBe(0);
        expect(result.rows[0]?.updated_at).toMatch(ISO_UTC_TIMESTAMP_PATTERN);
      } finally {
        await cleanup();
      }
    });

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
        'UPDATE models SET is_enabled = $1, updated_at = $2 WHERE id = $3',
        [true, expect.stringMatching(ISO_UTC_TIMESTAMP_PATTERN), 'model-1']
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

  describe('toggleProvider', () => {
    it('persists provider toggles through a Turso owner client', async () => {
      const { client, cleanup } = await createTursoRegistryClient();
      try {
        await useModelRegistryStore.getState().toggleProvider(client as never, 'openrouter', true);

        const result = await client.query<{ is_enabled: number; updated_at: string }>(
          'SELECT is_enabled, updated_at FROM providers WHERE id = ?',
          ['openrouter']
        );
        expect(result.rows[0]?.is_enabled).toBe(1);
        expect(result.rows[0]?.updated_at).toMatch(ISO_UTC_TIMESTAMP_PATTERN);
      } finally {
        await cleanup();
      }
    });

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
        'UPDATE providers SET is_enabled = $1, updated_at = $2 WHERE id = $3',
        [true, expect.stringMatching(ISO_UTC_TIMESTAMP_PATTERN), 'provider-1']
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
        providers: [createMockProvider()],
        models: [createMockModel()],
        isLoading: true,
        error: 'Some error',
        hasLoaded: true,
        modelCacheDir: '/custom/path',
        downloadProgress: { 'model-1': 50 },
        isDownloading: { 'model-1': true },
        downloadedModels: { 'model-1': true },
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

async function createTursoRegistryClient(): Promise<{
  readonly cleanup: () => Promise<void>;
  readonly client: TursoOwnerClient;
}> {
  const tempDir = await mkdtemp(join(tmpdir(), 'brainstrike-model-registry-turso-'));
  const client = await createTursoOwnerClient({
    dbPath: join(tempDir, 'profile.db'),
  });
  await applyTursoSchemaBaseline(client);

  return {
    cleanup: async () => {
      await client.close();
      await rm(tempDir, { force: true, recursive: true });
    },
    client,
  };
}
