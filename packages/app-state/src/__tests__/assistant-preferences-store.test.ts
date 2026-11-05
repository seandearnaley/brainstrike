import {
  PROVIDER_DEFAULT_MODELS,
  PROVIDER_MODELS,
  type SupportedProvider,
} from '@brainstrike/assistant-contract/provider-metadata';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { StorageValue } from 'zustand/middleware';
import { MODEL_ID_MIGRATIONS } from '../stores/assistant-model-id-migrations.ts';
import {
  ASSISTANT_PREFERENCES_STORE_VERSION,
  useAssistantPreferencesStore,
} from '../stores/assistant-preferences-store.ts';
import { __resetSettingsTestOverridesForTests } from './settings-test-overrides-test-helper.ts';

type PersistApi<T> = T & {
  persist?: {
    getOptions?: () => {
      name: string;
      storage: {
        getItem: (name: string) => string | null;
        setItem: (name: string, value: string) => void;
        removeItem: (name: string) => void;
      };
    };
    clearStorage?: () => void;
    rehydrate?: () => Promise<void>;
  };
};

const storeWithPersist = useAssistantPreferencesStore as PersistApi<
  typeof useAssistantPreferencesStore
>;

describe('assistant-preferences-store', () => {
  beforeEach(() => {
    __resetSettingsTestOverridesForTests();
    storeWithPersist.persist?.clearStorage?.();
    vi.restoreAllMocks();
    const secretTarget = window as Window & { secrets?: unknown };
    Reflect.deleteProperty(secretTarget, 'secrets');
  });

  it('defaults planModeEnabled to false and toggles/sets it', () => {
    expect(useAssistantPreferencesStore.getState().planModeEnabled).toBe(false);

    useAssistantPreferencesStore.getState().togglePlanMode();
    expect(useAssistantPreferencesStore.getState().planModeEnabled).toBe(true);

    useAssistantPreferencesStore.getState().setPlanModeEnabled(false);
    expect(useAssistantPreferencesStore.getState().planModeEnabled).toBe(false);
  });

  it('returns composite model when set', () => {
    const store = useAssistantPreferencesStore.getState();
    expect(store.selectedModel).toBeNull();
    expect(store.getSelectedModel()).toBeNull();

    const compositeKey = `openai::${PROVIDER_DEFAULT_MODELS.openai}`;
    store.setModel(compositeKey);
    expect(store.getSelectedModel()).toBe(compositeKey);
    expect(store.getSelectedProvider()).toBe('openai');
  });

  it('allows overriding models per provider', () => {
    const snapshot = useAssistantPreferencesStore.getState();

    // Use a model that is enabled by default (has default: true in registry)
    const defaultModel = PROVIDER_DEFAULT_MODELS.anthropic!;
    const compositeKey = `anthropic::${defaultModel}`;
    snapshot.setModel(compositeKey);

    const updated = useAssistantPreferencesStore.getState();
    expect(updated.getSelectedModel()).toBe(compositeKey);
    expect(updated.getSelectedProvider()).toBe('anthropic');
    expect(updated.modelsByProvider['anthropic']).toBe(defaultModel);
  });

  it('removes provider settings when updates set a field to undefined', () => {
    const store = useAssistantPreferencesStore.getState();

    store.setProviderSettings('openai', {
      agentMaxSteps: 8,
      maxOutputTokens: 1024,
      reasoningEffort: 'high',
    });
    store.setProviderSettings('openai', {
      agentMaxSteps: undefined,
      maxOutputTokens: undefined,
      reasoningEffort: undefined,
    });

    expect(useAssistantPreferencesStore.getState().providerSettings.openai).toEqual({});
  });

  it('clears selection when the current model is disabled', () => {
    const store = useAssistantPreferencesStore.getState();
    const initialModel = PROVIDER_DEFAULT_MODELS.openai!;
    const compositeKey = `openai::${initialModel}`;

    store.setModel(compositeKey);
    expect(store.getSelectedModel()).toBe(compositeKey);

    store.setModelEnabled('openai', initialModel, false);

    const after = useAssistantPreferencesStore.getState();
    expect(after.getSelectedModel()).toBeNull();
    expect(after.enabledModelsByProvider['openai']).not.toContain(initialModel);
  });

  it('clears selection when all models are disabled', () => {
    const store = useAssistantPreferencesStore.getState();
    const compositeKey = `openai::${PROVIDER_DEFAULT_MODELS.openai}`;
    store.setModel(compositeKey);

    const enabledModels = store.getEnabledModels('openai');
    expect(enabledModels.length).toBeGreaterThan(0);

    for (const model of enabledModels) {
      store.setModelEnabled('openai', model, false);
    }

    const after = useAssistantPreferencesStore.getState();
    expect(after.selectedModel).toBeNull();
    expect(after.getSelectedModel()).toBeNull();
    expect(after.getEnabledModels('openai')).toEqual([]);
  });

  it('batch-enables models and uses the first requested model when provider memory is empty', () => {
    const store = useAssistantPreferencesStore.getState();
    const allGoogleModels = PROVIDER_MODELS.google as string[];
    const [firstModel, secondModel] = allGoogleModels;
    if (!(firstModel && secondModel)) {
      throw new Error('Expected at least two Google models for batch enable test');
    }

    for (const model of store.getEnabledModels('google')) {
      store.setModelEnabled('google', model, false);
    }

    const withoutGoogleModels = useAssistantPreferencesStore.getState();
    expect(withoutGoogleModels.getEnabledModels('google')).toEqual([]);
    expect(withoutGoogleModels.modelsByProvider.google).toBeUndefined();

    withoutGoogleModels.setProviderModelsEnabled('google', [secondModel, firstModel], true);

    const updated = useAssistantPreferencesStore.getState();
    expect(updated.getEnabledModels('google')).toEqual([firstModel, secondModel]);
    expect(updated.modelsByProvider.google).toBe(secondModel);
  });

  it('batch-disables the current model once and ignores empty batches', () => {
    const store = useAssistantPreferencesStore.getState();
    const [firstModel, secondModel] = store.getEnabledModels('openai');
    if (!(firstModel && secondModel)) {
      throw new Error('Expected at least two OpenAI models for batch disable test');
    }

    const compositeKey = `openai::${firstModel}`;
    store.setModel(compositeKey);

    const beforeEmptyBatch = useAssistantPreferencesStore.getState();
    beforeEmptyBatch.setProviderModelsEnabled('openai', [], false);
    expect(useAssistantPreferencesStore.getState().selectedModel).toBe(compositeKey);

    beforeEmptyBatch.setProviderModelsEnabled('openai', [firstModel, 'not-enabled-model'], false);

    const updated = useAssistantPreferencesStore.getState();
    expect(updated.selectedModel).toBeNull();
    expect(updated.getEnabledModels('openai')).not.toContain(firstModel);
    expect(updated.getEnabledModels('openai')).toContain(secondModel);
  });

  it('setModel accepts any model since validation happens at UI layer against DB', () => {
    const store = useAssistantPreferencesStore.getState();

    // Get first enabled model
    const [firstModel] = store.getEnabledModels('google');
    expect(firstModel).toBeDefined();

    // Enable a second model for testing (from the full provider models list)
    const allGoogleModels = PROVIDER_MODELS.google as string[];
    const secondModel = allGoogleModels.find((m) => m !== firstModel) ?? 'gemini-legacy';
    expect(secondModel).toBeDefined();
    store.setModelEnabled('google', secondModel!, true);

    // Set second model first
    const validComposite = `google::${secondModel}`;
    store.setModel(validComposite);
    expect(store.getSelectedModel()).toBe(validComposite);

    // Disable first model in localStorage (but setModel doesn't check this anymore)
    store.setModelEnabled('google', firstModel!, false);

    // setModel now accepts any model - validation happens at UI layer against DB
    const anotherComposite = `google::${firstModel}`;
    store.setModel(anotherComposite);

    // Model is set because setModel no longer validates against localStorage
    // The UI layer (assistant-ui-panel-wrapper) validates against the database
    const updated = useAssistantPreferencesStore.getState();
    expect(updated.getSelectedModel()).toBe(anotherComposite);
  });

  it('ignores setModel calls for unknown providers', () => {
    const store = useAssistantPreferencesStore.getState();
    const previous = store.getSelectedModel();

    store.setModel('unknown-provider::model-x');

    const next = useAssistantPreferencesStore.getState();
    expect(next.getSelectedModel()).toBe(previous);
    expect(next.getSelectedProvider()).toBeNull();
  });

  it('resolves available providers from secrets API', async () => {
    const secretTarget = window as Window & { secrets?: unknown };
    secretTarget.secrets = {
      deleteKey: vi.fn(),
      getKey: vi.fn(),
      list: vi.fn().mockResolvedValue([
        { envVar: 'OPENAI_API_KEY', provider: 'openai', source: 'env' },
        { provider: 'google', source: 'stored' },
      ]),
      listStored: vi.fn(),
      saveKey: vi.fn(),
    };

    const providers = await useAssistantPreferencesStore.getState().getAvailableProviders();
    const expected: SupportedProvider[] = ['openai', 'google'];
    expect(providers).toEqual(expected);
  });

  it('surfaces secrets API failures instead of silently degrading to no providers', async () => {
    const secretTarget = window as Window & { secrets?: unknown };
    secretTarget.secrets = {
      deleteKey: vi.fn(),
      getKey: vi.fn(),
      list: vi.fn().mockRejectedValue(new Error('not allowed')),
      listStored: vi.fn(),
      saveKey: vi.fn(),
    };

    await expect(useAssistantPreferencesStore.getState().getAvailableProviders()).rejects.toThrow(
      'not allowed'
    );
  });

  it('accepts stored entries carrying the save-time fingerprint metadata (BST-1362)', async () => {
    const secretTarget = window as Window & { secrets?: unknown };
    secretTarget.secrets = {
      deleteKey: vi.fn(),
      getKey: vi.fn(),
      list: vi.fn().mockResolvedValue([
        {
          metadata: { last4: '-123', savedAt: '2026-08-18T10:00:00.000Z' },
          provider: 'google',
          source: 'stored',
        },
      ]),
      listStored: vi.fn(),
      saveKey: vi.fn(),
    };

    const providers = await useAssistantPreferencesStore.getState().getAvailableProviders();
    expect(providers).toContain('google');
  });

  it('rejects a stored entry whose fingerprint metadata is malformed', async () => {
    const secretTarget = window as Window & { secrets?: unknown };
    secretTarget.secrets = {
      deleteKey: vi.fn(),
      getKey: vi.fn(),
      list: vi.fn().mockResolvedValue([
        {
          metadata: { last4: '-123', savedAt: 'not-a-date' },
          provider: 'google',
          source: 'stored',
        },
      ]),
      listStored: vi.fn(),
      saveKey: vi.fn(),
    };

    await expect(useAssistantPreferencesStore.getState().getAvailableProviders()).rejects.toThrow(
      'invalid provider key metadata'
    );
  });

  it('rejects malformed provider key metadata', async () => {
    const secretTarget = window as Window & { secrets?: unknown };
    secretTarget.secrets = {
      deleteKey: vi.fn(),
      getKey: vi.fn(),
      list: vi
        .fn()
        .mockResolvedValue([{ envVar: 'OPENAI_API_KEY', provider: 'openai', source: 'stored' }]),
      listStored: vi.fn(),
      saveKey: vi.fn(),
    };

    await expect(useAssistantPreferencesStore.getState().getAvailableProviders()).rejects.toThrow(
      'invalid provider key metadata'
    );
  });

  it('updates model with composite key', () => {
    const store = useAssistantPreferencesStore.getState();

    // Initially no model selected
    expect(store.selectedModel).toBeNull();
    expect(store.getSelectedModel()).toBeNull();

    // Select anthropic with the default model using composite key
    const defaultModel = PROVIDER_DEFAULT_MODELS.anthropic!;
    const compositeKey = `anthropic::${defaultModel}`;
    store.setModel(compositeKey);

    const updated = useAssistantPreferencesStore.getState();

    // Model should be selected with composite key
    expect(updated.selectedModel).toBe(compositeKey);
    expect(updated.getSelectedProvider()).toBe('anthropic');
    expect(updated.modelsByProvider['anthropic']).toBe(defaultModel);
    expect(updated.getSelectedModel()).toBe(compositeKey);
  });

  it('migrates legacy model IDs to the new catalog', async () => {
    const persistApi = storeWithPersist.persist;
    const options = persistApi?.getOptions?.();
    if (!(persistApi && options?.storage && options.name)) {
      throw new Error('persist storage unavailable for test');
    }

    const legacyState: StorageValue<unknown> = {
      state: {
        enabledModelsByProvider: {
          anthropic: ['claude-3-5-sonnet-latest'],
          cohere: [],
          google: ['gemini-2.0-pro'],
          openai: ['gpt-4o', 'gpt-4o-mini'],
          openrouter: ['openai/gpt-4o'],
          voyage: [],
        },
        modelsByProvider: {
          anthropic: 'claude-3-5-sonnet-latest',
          cohere: 'cohere',
          google: 'gemini-2.0-pro',
          openai: 'gpt-4o',
          openrouter: 'openai/gpt-4o',
          voyage: 'voyage',
        },
        providerSettings: {},
        selectedModel: 'openai::gpt-4o',
      },
      version: 3,
    };

    localStorage.setItem(options.name, JSON.stringify(legacyState));
    await persistApi.rehydrate?.();

    const store = useAssistantPreferencesStore.getState();
    expect(store.modelsByProvider['openai']).toBe('gpt-5.4');
    expect(store.modelsByProvider['anthropic']).toBe('claude-sonnet-4-6');
    expect(store.modelsByProvider['google']).toBe('gemini-2.5-pro');
    expect(store.modelsByProvider['openrouter']).toBe('openai/gpt-5.4');
    expect(store.selectedModel).toBe('openai::gpt-5.4');
    expect(store.enabledModelsByProvider['openai']).toContain('gpt-5.4');
    expect(store.enabledModelsByProvider['openai']).toContain('gpt-5.4-mini');
    expect(store.enabledModelsByProvider['openai']).not.toContain('gpt-4o');
  });

  describe('model migration notices (BST-565)', () => {
    // Seeds come from the live catalog so the tests cannot silently depend on
    // one specific id staying retired.
    const [retiredOpenRouterId, openRouterTarget] = Object.entries(
      MODEL_ID_MIGRATIONS.openrouter
    ).find(([from]) => from === 'google/gemini-2.5-pro') ?? ['', ''];
    const [retiredAnthropicId, anthropicTarget] = Object.entries(
      MODEL_ID_MIGRATIONS.anthropic
    )[0] ?? ['', ''];

    function seedSnapshot(
      state: Record<string, unknown>,
      version: number
    ): {
      rehydrate: () => Promise<void>;
      readPersisted: () => Promise<Record<string, unknown>>;
    } {
      const persistApi = storeWithPersist.persist;
      const options = persistApi?.getOptions?.();
      if (!(persistApi && options?.storage && options.name)) {
        throw new Error('persist storage unavailable for test');
      }
      const { name, storage } = options;
      const snapshot: StorageValue<unknown> = { state, version };
      localStorage.setItem(name, JSON.stringify(snapshot));
      return {
        readPersisted: async () => {
          const raw: unknown = await storage.getItem(name);
          if (!(raw && typeof raw === 'object' && 'state' in raw)) {
            throw new Error('expected a persisted snapshot');
          }
          return raw.state as Record<string, unknown>;
        },
        rehydrate: async () => {
          await persistApi.rehydrate?.();
        },
      };
    }

    it('records a notice when the selected model was a retired id', async () => {
      expect(retiredOpenRouterId).toBe('google/gemini-2.5-pro');
      const { rehydrate, readPersisted } = seedSnapshot(
        {
          enabledModelsByProvider: {
            openrouter: [retiredOpenRouterId, 'anthropic/claude-sonnet-4.6'],
          },
          modelsByProvider: { openrouter: retiredOpenRouterId },
          providerSettings: {},
          selectedModel: `openrouter::${retiredOpenRouterId}`,
        },
        5
      );

      await rehydrate();

      const store = useAssistantPreferencesStore.getState();
      // The silent Pro → Flash downgrade this ticket exists for is now visible.
      expect(store.modelMigrationNotices).toEqual([
        { from: retiredOpenRouterId, provider: 'openrouter', to: openRouterTarget },
      ]);
      expect(store.selectedModel).toBe(`openrouter::${openRouterTarget}`);
      // Session-only: the notice never lands in storage, so it cannot replay.
      expect(await readPersisted()).not.toHaveProperty('modelMigrationNotices');
    });

    it('reports the model the user actually lands on when the remap target is not enabled', async () => {
      const { rehydrate } = seedSnapshot(
        {
          // The Flash target is NOT enabled, so the selection falls back.
          enabledModelsByProvider: { openrouter: ['anthropic/claude-sonnet-4.6'] },
          modelsByProvider: { openrouter: retiredOpenRouterId },
          providerSettings: {},
          selectedModel: `openrouter::${retiredOpenRouterId}`,
        },
        5
      );

      await rehydrate();

      const store = useAssistantPreferencesStore.getState();
      expect(store.selectedModel).toBe('openrouter::anthropic/claude-sonnet-4.6');
      expect(store.modelMigrationNotices).toEqual([
        { from: retiredOpenRouterId, provider: 'openrouter', to: 'anthropic/claude-sonnet-4.6' },
      ]);
    });

    it('ignores retired ids under providers the user is not running on', async () => {
      // modelsByProvider is seeded with a default for EVERY provider, so a
      // retired default under an untouched provider is not a user choice.
      const { rehydrate } = seedSnapshot(
        {
          enabledModelsByProvider: {
            anthropic: ['claude-sonnet-4-6'],
            openrouter: [retiredOpenRouterId, 'anthropic/claude-sonnet-4.6'],
          },
          modelsByProvider: { anthropic: 'claude-sonnet-4-6', openrouter: retiredOpenRouterId },
          providerSettings: {},
          selectedModel: 'anthropic::claude-sonnet-4-6',
        },
        5
      );

      await rehydrate();

      const store = useAssistantPreferencesStore.getState();
      expect(store.modelsByProvider['openrouter']).toBe(openRouterTarget);
      expect(store.modelMigrationNotices).toEqual([]);
    });

    it('records nothing when the saved selection is current', async () => {
      const { rehydrate } = seedSnapshot(
        {
          enabledModelsByProvider: { openrouter: ['anthropic/claude-sonnet-4.6'] },
          modelsByProvider: { openrouter: 'anthropic/claude-sonnet-4.6' },
          providerSettings: {},
          selectedModel: 'openrouter::anthropic/claude-sonnet-4.6',
        },
        5
      );

      await rehydrate();

      expect(useAssistantPreferencesStore.getState().modelMigrationNotices).toEqual([]);
    });

    // BST-1697. The four September 2026 delistings all remap to a MORE
    // EXPENSIVE row (two of them from free), so a user whose SELECTED model is
    // one of them must be told.
    it('remaps the delisted OpenRouter routes and surfaces the selected one', async () => {
      const { rehydrate } = seedSnapshot(
        {
          enabledModelsByProvider: {
            openrouter: [
              'stealth/ox-alpha',
              'qwen/qwen3.8-max',
              'inclusionai/ling-3.0-flash:free',
              'kwaipilot/kat-coder-air-v2.5',
            ],
          },
          modelsByProvider: { openrouter: 'stealth/ox-alpha' },
          providerSettings: {},
          recentModels: ['openrouter::stealth/ox-alpha', 'openrouter::qwen/qwen3.8-max'],
          selectedModel: 'openrouter::stealth/ox-alpha',
        },
        9
      );

      await rehydrate();

      const store = useAssistantPreferencesStore.getState();
      const enabled = store.enabledModelsByProvider['openrouter'];
      expect(enabled).toEqual(
        expect.arrayContaining([
          'qwen/qwen3.8-flash',
          'qwen/qwen3.8-max-0902',
          'inclusionai/ling-3.0-flash',
          'kwaipilot/kat-coder-pro-v2.5',
        ])
      );
      for (const retired of [
        'stealth/ox-alpha',
        'qwen/qwen3.8-max',
        'inclusionai/ling-3.0-flash:free',
        'kwaipilot/kat-coder-air-v2.5',
      ]) {
        expect(enabled).not.toContain(retired);
      }
      // Free + vision-capable -> the cheapest replacement that KEEPS vision.
      expect(store.selectedModel).toBe('openrouter::qwen/qwen3.8-flash');
      expect(store.modelMigrationNotices).toEqual([
        { from: 'stealth/ox-alpha', provider: 'openrouter', to: 'qwen/qwen3.8-flash' },
      ]);
      expect(store.recentModels).toEqual([
        'openrouter::qwen/qwen3.8-flash',
        'openrouter::qwen/qwen3.8-max-0902',
      ]);
    });

    it('stays quiet when a delisted route was only in the enabled list', async () => {
      const { rehydrate } = seedSnapshot(
        {
          enabledModelsByProvider: {
            anthropic: ['claude-sonnet-4-6'],
            openrouter: ['kwaipilot/kat-coder-air-v2.5', 'anthropic/claude-sonnet-4.6'],
          },
          modelsByProvider: {
            anthropic: 'claude-sonnet-4-6',
            openrouter: 'kwaipilot/kat-coder-air-v2.5',
          },
          providerSettings: {},
          selectedModel: 'anthropic::claude-sonnet-4-6',
        },
        9
      );

      await rehydrate();

      const store = useAssistantPreferencesStore.getState();
      expect(store.enabledModelsByProvider['openrouter']).toContain('kwaipilot/kat-coder-pro-v2.5');
      // modelsByProvider is seeded for every provider, so a retired per-provider
      // default under a provider the user is not running on is not intent.
      expect(store.modelMigrationNotices).toEqual([]);
    });

    // A model retired with no store version bump must still move on reopen:
    // the snapshot below is what the previous release wrote, at the current
    // version, with a Gemini Flash Google has since retired.
    it('remaps a retired selection saved at the current store version', async () => {
      const { rehydrate } = seedSnapshot(
        {
          enabledModelsByProvider: { google: ['gemini-3.5-flash', 'gemini-3.8-flash'] },
          modelsByProvider: { google: 'gemini-3.5-flash' },
          providerSettings: {},
          recentModels: ['google::gemini-3.5-flash'],
          selectedModel: 'google::gemini-3.5-flash',
        },
        ASSISTANT_PREFERENCES_STORE_VERSION
      );

      await rehydrate();

      const store = useAssistantPreferencesStore.getState();
      expect(store.selectedModel).toBe('google::gemini-3.8-flash');
      expect(store.modelsByProvider['google']).toBe('gemini-3.8-flash');
      expect(store.enabledModelsByProvider['google']).toEqual(['gemini-3.8-flash']);
      expect(store.recentModels).toEqual(['google::gemini-3.8-flash']);
      expect(store.modelMigrationNotices).toEqual([
        { from: 'gemini-3.5-flash', provider: 'google', to: 'gemini-3.8-flash' },
      ]);
    });

    it('takeModelMigrationNotices returns the list and clears it atomically', async () => {
      const { rehydrate } = seedSnapshot(
        {
          enabledModelsByProvider: { anthropic: [retiredAnthropicId, anthropicTarget] },
          modelsByProvider: { anthropic: retiredAnthropicId },
          providerSettings: {},
          selectedModel: `anthropic::${retiredAnthropicId}`,
        },
        5
      );
      await rehydrate();

      const taken = useAssistantPreferencesStore.getState().takeModelMigrationNotices();
      expect(taken).toEqual([
        { from: retiredAnthropicId, provider: 'anthropic', to: anthropicTarget },
      ]);
      const cleared = useAssistantPreferencesStore.getState().modelMigrationNotices;
      expect(cleared).toEqual([]);

      // A second take (StrictMode re-run, sibling mount) gets nothing and
      // publishes no new state.
      expect(useAssistantPreferencesStore.getState().takeModelMigrationNotices()).toEqual([]);
      expect(useAssistantPreferencesStore.getState().modelMigrationNotices).toBe(cleared);
    });
  });

  it('migrates superseded frontier IDs and leaves first-class models untouched', async () => {
    const persistApi = storeWithPersist.persist;
    const options = persistApi?.getOptions?.();
    if (!(persistApi && options?.storage && options.name)) {
      throw new Error('persist storage unavailable for test');
    }

    const priorState: StorageValue<unknown> = {
      state: {
        enabledModelsByProvider: {
          anthropic: ['claude-sonnet-4-5', 'claude-opus-4-5'],
          google: ['gemini-3-flash-preview', 'gemini-2.5-flash'],
          openai: ['gpt-5.2-chat-latest'],
          openrouter: [
            'anthropic/claude-sonnet-4.5',
            'anthropic/claude-opus-4.5',
            'google/gemini-3-pro-preview',
            'google/gemini-2.5-pro',
          ],
        },
        modelsByProvider: {
          anthropic: 'claude-sonnet-4-5',
          google: 'gemini-3-flash-preview',
          openai: 'gpt-5.2-chat-latest',
          openrouter: 'anthropic/claude-sonnet-4.5',
        },
        providerSettings: {},
        selectedModel: 'anthropic::claude-sonnet-4-5',
      },
      version: 5,
    };

    localStorage.setItem(options.name, JSON.stringify(priorState));
    await persistApi.rehydrate?.();

    const store = useAssistantPreferencesStore.getState();
    // OpenRouter legacy slugs remap for symmetry with the direct-provider map.
    expect(store.enabledModelsByProvider['openrouter']).toContain('anthropic/claude-opus-4.8');
    expect(store.enabledModelsByProvider['openrouter']).not.toContain('anthropic/claude-opus-4.5');
    expect(store.enabledModelsByProvider['openrouter']).toContain('google/gemini-3.1-pro-preview');
    expect(store.enabledModelsByProvider['openrouter']).not.toContain(
      'google/gemini-3-pro-preview'
    );
    // google/gemini-2.5-pro is not in the OpenRouter catalog, so it remaps to Flash.
    expect(store.enabledModelsByProvider['openrouter']).toContain('google/gemini-2.5-flash');
    expect(store.enabledModelsByProvider['openrouter']).not.toContain('google/gemini-2.5-pro');
    expect(store.modelsByProvider['openai']).toBe('gpt-5.4');
    expect(store.modelsByProvider['anthropic']).toBe('claude-sonnet-4-6');
    expect(store.modelsByProvider['google']).toBe('gemini-3.8-flash');
    expect(store.modelsByProvider['openrouter']).toBe('anthropic/claude-sonnet-4.6');
    expect(store.selectedModel).toBe('anthropic::claude-sonnet-4-6');

    // Removed 4-5 generation IDs are remapped...
    expect(store.enabledModelsByProvider['anthropic']).toContain('claude-sonnet-4-6');
    expect(store.enabledModelsByProvider['anthropic']).toContain('claude-opus-4-8');
    expect(store.enabledModelsByProvider['anthropic']).not.toContain('claude-sonnet-4-5');
    expect(store.enabledModelsByProvider['anthropic']).not.toContain('claude-opus-4-5');
    // ...but gemini-2.5-flash is now a first-class model and must NOT be rewritten.
    expect(store.enabledModelsByProvider['google']).toContain('gemini-2.5-flash');
    expect(store.enabledModelsByProvider['google']).toContain('gemini-3.8-flash');
    expect(store.enabledModelsByProvider['google']).not.toContain('gemini-3-flash-preview');
  });

  it('keeps every model migration target live and terminal', () => {
    for (const provider of Object.keys(MODEL_ID_MIGRATIONS) as SupportedProvider[]) {
      const migrations = MODEL_ID_MIGRATIONS[provider];
      for (const [source, target] of Object.entries(migrations)) {
        expect(
          PROVIDER_MODELS[provider],
          `${provider}:${source} target must remain live`
        ).toContain(target);
        expect(migrations, `${provider}:${source} target must be terminal`).not.toHaveProperty(
          target
        );
      }
    }
  });

  it('remaps the retired OpenRouter Claude 3.5 Sonnet route', async () => {
    const persistApi = storeWithPersist.persist;
    const options = persistApi?.getOptions?.();
    if (!(persistApi && options?.storage && options.name)) {
      throw new Error('persist storage unavailable for test');
    }

    const staleSnapshot: StorageValue<unknown> = {
      state: {
        enabledModelsByProvider: {
          openrouter: ['openrouter/claude-3-5-sonnet'],
        },
        modelsByProvider: {
          openrouter: 'openrouter/claude-3-5-sonnet',
        },
        providerSettings: {},
        recentModels: ['openrouter::openrouter/claude-3-5-sonnet'],
        selectedModel: 'openrouter::openrouter/claude-3-5-sonnet',
      },
      version: 7,
    };

    localStorage.setItem(options.name, JSON.stringify(staleSnapshot));
    await persistApi.rehydrate?.();

    const store = useAssistantPreferencesStore.getState();
    expect(store.enabledModelsByProvider['openrouter']).toContain('anthropic/claude-sonnet-4.6');
    expect(store.enabledModelsByProvider['openrouter']).not.toContain(
      'openrouter/claude-3-5-sonnet'
    );
    expect(store.modelsByProvider['openrouter']).toBe('anthropic/claude-sonnet-4.6');
    expect(store.selectedModel).toBe('openrouter::anthropic/claude-sonnet-4.6');
    expect(store.recentModels).toEqual(['openrouter::anthropic/claude-sonnet-4.6']);
  });

  it('remaps retired OpenRouter GPT-4o family routes', async () => {
    const persistApi = storeWithPersist.persist;
    const options = persistApi?.getOptions?.();
    if (!(persistApi && options?.storage && options.name)) {
      throw new Error('persist storage unavailable for test');
    }

    const staleSnapshot: StorageValue<unknown> = {
      state: {
        enabledModelsByProvider: {
          openrouter: ['openrouter/gpt-4o', 'openai/gpt-4o', 'openrouter/gpt-4o-mini'],
        },
        modelsByProvider: {
          openrouter: 'openrouter/gpt-4o',
        },
        providerSettings: {},
        recentModels: [
          'openrouter::openrouter/gpt-4o-mini',
          'openrouter::openrouter/gpt-4o',
          'openrouter::openai/gpt-4o',
        ],
        selectedModel: 'openrouter::openrouter/gpt-4o-mini',
      },
      version: 8,
    };

    localStorage.setItem(options.name, JSON.stringify(staleSnapshot));
    await persistApi.rehydrate?.();

    const store = useAssistantPreferencesStore.getState();
    const enabledOpenRouter = store.enabledModelsByProvider['openrouter'];
    expect(enabledOpenRouter).toContain('openai/gpt-5.4');
    expect(enabledOpenRouter).toContain('openai/gpt-5.4-mini');
    expect(enabledOpenRouter.filter((id) => id === 'openai/gpt-5.4')).toHaveLength(1);
    expect(enabledOpenRouter).not.toContain('openrouter/gpt-4o');
    expect(enabledOpenRouter).not.toContain('openrouter/gpt-4o-mini');
    expect(store.modelsByProvider['openrouter']).toBe('openai/gpt-5.4');
    expect(store.selectedModel).toBe('openrouter::openai/gpt-5.4-mini');
    expect(store.recentModels).toEqual([
      'openrouter::openai/gpt-5.4-mini',
      'openrouter::openai/gpt-5.4',
    ]);
  });

  it('migrates legacy selectedProvider snapshots to composite selectedModel', async () => {
    const persistApi = storeWithPersist.persist;
    const options = persistApi?.getOptions?.();
    if (!(persistApi && options?.storage && options.name)) {
      throw new Error('persist storage unavailable for test');
    }

    const legacyProviderState: StorageValue<unknown> = {
      state: {
        enabledModelsByProvider: {
          google: ['gemini-3-flash-preview'],
        },
        modelsByProvider: {
          google: 'gemini-3-flash-preview',
        },
        providerSettings: {},
        selectedProvider: 'google',
      },
      version: 1,
    };

    localStorage.setItem(options.name, JSON.stringify(legacyProviderState));
    await persistApi.rehydrate?.();

    const store = useAssistantPreferencesStore.getState();
    expect(store.modelsByProvider.google).toBe('gemini-3.8-flash');
    expect(store.selectedModel).toBe('google::gemini-3.8-flash');
    expect(store.enabledModelsByProvider.google).toContain('gemini-3.8-flash');
    expect(store.enabledModelsByProvider.google).not.toContain('gemini-3-flash-preview');
  });

  it('switches between providers using composite keys', () => {
    const initialStore = useAssistantPreferencesStore.getState();

    // Start with openai
    const openaiKey = `openai::${PROVIDER_DEFAULT_MODELS.openai}`;
    initialStore.setModel(openaiKey);

    const withOpenAI = useAssistantPreferencesStore.getState();
    expect(withOpenAI.selectedModel).toBe(openaiKey);
    expect(withOpenAI.getSelectedProvider()).toBe('openai');

    // Get an enabled model for Google
    const [firstGoogleModel, secondGoogleModel] = initialStore.getEnabledModels('google');
    const googleModel = secondGoogleModel ?? firstGoogleModel!;
    expect(googleModel).toBeDefined();

    // Switch to google with a specific model using composite key
    const googleKey = `google::${googleModel}`;
    withOpenAI.setModel(googleKey);

    // Get fresh state
    const updated = useAssistantPreferencesStore.getState();

    // Both should switch
    expect(updated.selectedModel).toBe(googleKey);
    expect(updated.getSelectedProvider()).toBe('google');
    expect(updated.modelsByProvider['google']).toBe(googleModel);
    expect(updated.getSelectedModel()).toBe(googleKey);

    // Old provider's model should still be preserved
    expect(updated.modelsByProvider['openai']).toBe(PROVIDER_DEFAULT_MODELS.openai);
  });

  it('persists to in-memory storage when localStorage is unavailable', () => {
    const persistApi = storeWithPersist.persist;
    expect(persistApi).toBeDefined();
    const options = persistApi?.getOptions?.();
    expect(options?.storage).toBeDefined();
    if (!(persistApi && options?.storage && options.name)) {
      throw new Error('persist storage unavailable for test');
    }

    const storage = options.storage;

    vi.spyOn(window.localStorage, 'setItem').mockImplementation(() => {
      throw new Error('storage blocked');
    });
    vi.spyOn(window.localStorage, 'getItem').mockImplementation(() => {
      throw new Error('storage blocked');
    });
    vi.spyOn(window.localStorage, 'removeItem').mockImplementation(() => {
      throw new Error('storage blocked');
    });

    const store = useAssistantPreferencesStore.getState();
    const compositeKey = 'openrouter::openai/gpt-5.2';
    store.setModel(compositeKey);

    const persistedValue = storage.getItem(options.name)!;
    expect(persistedValue).not.toBeNull();

    if (
      !persistedValue ||
      typeof (persistedValue as { state?: unknown }) !== 'object' ||
      Array.isArray(persistedValue)
    ) {
      throw new Error('unexpected persisted snapshot');
    }

    const snapshot = persistedValue as {
      state?: {
        selectedModel: string | null;
        modelsByProvider: Partial<Record<SupportedProvider, string>>;
        enabledModelsByProvider: Record<SupportedProvider, string[]>;
      };
    };

    expect(snapshot.state?.selectedModel).toBe(compositeKey);
    expect(snapshot.state?.modelsByProvider['openrouter']).toBe('openai/gpt-5.2');
    // Only models with default: true are enabled by default, not all PROVIDER_MODELS
    expect(snapshot.state?.enabledModelsByProvider['openrouter']).toContain('openai/gpt-5.2');

    persistApi.clearStorage?.();
    const afterClear = storage.getItem(options.name)!;
    expect(afterClear).toBeNull();
  });

  describe('recent models', () => {
    it('defaults to an empty recents list', () => {
      expect(useAssistantPreferencesStore.getState().recentModels).toEqual([]);
    });

    it('records selections newest-first, deduped, capped at five', () => {
      const store = useAssistantPreferencesStore.getState();
      const keys = [
        `openai::${PROVIDER_DEFAULT_MODELS.openai}`,
        `anthropic::${PROVIDER_DEFAULT_MODELS.anthropic}`,
        `google::${PROVIDER_DEFAULT_MODELS.google}`,
        'openai::gpt-5.6-sol',
        'anthropic::claude-haiku-4-5',
        'google::gemini-2.5-flash',
      ];
      for (const key of keys) {
        store.setModel(key);
      }

      // Re-selecting an existing entry moves it to the front without duplication.
      store.setModel(`anthropic::${PROVIDER_DEFAULT_MODELS.anthropic}`);

      expect(useAssistantPreferencesStore.getState().recentModels).toEqual([
        `anthropic::${PROVIDER_DEFAULT_MODELS.anthropic}`,
        'google::gemini-2.5-flash',
        'anthropic::claude-haiku-4-5',
        'openai::gpt-5.6-sol',
        `google::${PROVIDER_DEFAULT_MODELS.google}`,
      ]);
    });

    it('ignores invalid composite keys', () => {
      const store = useAssistantPreferencesStore.getState();
      store.setModel('not-a-composite');
      store.setModel('unknown-provider::model-x');
      expect(useAssistantPreferencesStore.getState().recentModels).toEqual([]);
    });

    it('defaults recentModels to empty when migrating pre-v7 snapshots', async () => {
      const persistApi = storeWithPersist.persist;
      const options = persistApi?.getOptions?.();
      if (!(persistApi && options?.storage && options.name)) {
        throw new Error('persist storage unavailable for test');
      }

      const priorState: StorageValue<unknown> = {
        state: {
          enabledModelsByProvider: {},
          modelsByProvider: {},
          providerSettings: {},
          selectedModel: `openai::${PROVIDER_DEFAULT_MODELS.openai}`,
        },
        version: 6,
      };

      localStorage.setItem(options.name, JSON.stringify(priorState));
      await persistApi.rehydrate?.();

      expect(useAssistantPreferencesStore.getState().recentModels).toEqual([]);
    });

    it('persists recents in the partialized snapshot', () => {
      const persistApi = storeWithPersist.persist;
      const options = persistApi?.getOptions?.();
      if (!(persistApi && options?.storage && options.name)) {
        throw new Error('persist storage unavailable for test');
      }

      const compositeKey = `openai::${PROVIDER_DEFAULT_MODELS.openai}`;
      useAssistantPreferencesStore.getState().setModel(compositeKey);

      const snapshot = options.storage.getItem(options.name) as unknown as {
        state?: { recentModels?: string[] };
      } | null;
      expect(snapshot?.state?.recentModels).toEqual([compositeKey]);
    });
  });

  describe('plan mode migration', () => {
    it('preserves planModeEnabled: true from a pre-v7 snapshot across migration', async () => {
      const persistApi = storeWithPersist.persist;
      const options = persistApi?.getOptions?.();
      if (!(persistApi && options?.storage && options.name)) {
        throw new Error('persist storage unavailable for test');
      }

      const priorState: StorageValue<unknown> = {
        state: {
          enabledModelsByProvider: {},
          modelsByProvider: {},
          planModeEnabled: true,
          providerSettings: {},
          selectedModel: `openai::${PROVIDER_DEFAULT_MODELS.openai}`,
        },
        version: 6,
      };

      localStorage.setItem(options.name, JSON.stringify(priorState));
      await persistApi.rehydrate?.();

      expect(useAssistantPreferencesStore.getState().planModeEnabled).toBe(true);
    });

    it('defaults planModeEnabled to false when absent from a pre-v7 snapshot', async () => {
      const persistApi = storeWithPersist.persist;
      const options = persistApi?.getOptions?.();
      if (!(persistApi && options?.storage && options.name)) {
        throw new Error('persist storage unavailable for test');
      }

      const priorState: StorageValue<unknown> = {
        state: {
          enabledModelsByProvider: {},
          modelsByProvider: {},
          providerSettings: {},
          selectedModel: `openai::${PROVIDER_DEFAULT_MODELS.openai}`,
        },
        version: 6,
      };

      localStorage.setItem(options.name, JSON.stringify(priorState));
      await persistApi.rehydrate?.();

      expect(useAssistantPreferencesStore.getState().planModeEnabled).toBe(false);
    });
  });
});
