import {
  PROVIDER_DEFAULT_MODELS,
  PROVIDER_MODELS,
  type SupportedProvider,
} from '@brainstrike/assistant-contract/provider-metadata';
import { LocalRuntimeDiscoveryService } from '@brainstrike/local-runtime';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { StorageValue } from 'zustand/middleware';
import { MODEL_ID_MIGRATIONS } from '../stores/assistant-model-id-migrations';
import {
  __resetAssistantPreferencesStoreForTests,
  useAssistantPreferencesStore,
} from '../stores/assistant-preferences-store';
import {
  __resetSettingsTestOverridesForTests,
  __setSettingsTestOverridesForTests,
} from '../testing/e2e-settings-test-overrides';

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
    __resetAssistantPreferencesStoreForTests();
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
    vi.spyOn(LocalRuntimeDiscoveryService.prototype, 'probeRuntime').mockResolvedValue({
      checkedAt: 123,
      state: 'unavailable',
    });

    const secretTarget = window as Window & { secrets?: unknown };
    secretTarget.secrets = {
      clearAll: vi.fn(),
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
    // 'local' is always included because it doesn't require API keys
    const expected: SupportedProvider[] = ['openai', 'google', 'local'];
    expect(providers).toEqual(expected);
  });

  it('surfaces secrets API failures instead of silently degrading to no-key providers', async () => {
    vi.spyOn(LocalRuntimeDiscoveryService.prototype, 'probeRuntime').mockResolvedValue({
      checkedAt: 123,
      state: 'unavailable',
    });

    const secretTarget = window as Window & { secrets?: unknown };
    secretTarget.secrets = {
      clearAll: vi.fn(),
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
    vi.spyOn(LocalRuntimeDiscoveryService.prototype, 'probeRuntime').mockResolvedValue({
      checkedAt: 123,
      state: 'unavailable',
    });

    const secretTarget = window as Window & { secrets?: unknown };
    secretTarget.secrets = {
      clearAll: vi.fn(),
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
    vi.spyOn(LocalRuntimeDiscoveryService.prototype, 'probeRuntime').mockResolvedValue({
      checkedAt: 123,
      state: 'unavailable',
    });

    const secretTarget = window as Window & { secrets?: unknown };
    secretTarget.secrets = {
      clearAll: vi.fn(),
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
    vi.spyOn(LocalRuntimeDiscoveryService.prototype, 'probeRuntime').mockResolvedValue({
      checkedAt: 123,
      state: 'unavailable',
    });

    const secretTarget = window as Window & { secrets?: unknown };
    secretTarget.secrets = {
      clearAll: vi.fn(),
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

  it('includes detected local runtime providers only for available and stale states', async () => {
    vi.spyOn(LocalRuntimeDiscoveryService.prototype, 'probeRuntime').mockImplementation(
      async (runtimeId) => {
        if (runtimeId === 'ollama') {
          return {
            checkedAt: 123,
            endpoint: 'http://127.0.0.1:11434/api/tags',
            latencyMs: 5,
            state: 'available',
          };
        }
        return {
          checkedAt: 123,
          endpoint: 'http://127.0.0.1:1234/api/v1/models',
          lastSuccessfulAt: 122,
          reason: 'unavailable',
          state: 'stale',
        };
      }
    );

    const secretTarget = window as Window & { secrets?: unknown };
    secretTarget.secrets = {
      clearAll: vi.fn(),
      deleteKey: vi.fn(),
      getKey: vi.fn(),
      list: vi.fn().mockResolvedValue([]),
      listStored: vi.fn(),
      saveKey: vi.fn(),
    };

    const providers = await useAssistantPreferencesStore.getState().getAvailableProviders();

    expect(providers).toContain('local');
    expect(providers).toContain('ollama');
    expect(providers).toContain('lmstudio');
  });

  it('surfaces unexpected local runtime discovery failures', async () => {
    vi.spyOn(LocalRuntimeDiscoveryService.prototype, 'probeRuntime').mockRejectedValue(
      new Error('runtime probe crashed')
    );

    const secretTarget = window as Window & { secrets?: unknown };
    secretTarget.secrets = {
      clearAll: vi.fn(),
      deleteKey: vi.fn(),
      getKey: vi.fn(),
      list: vi.fn().mockResolvedValue([]),
      listStored: vi.fn(),
      saveKey: vi.fn(),
    };

    await expect(useAssistantPreferencesStore.getState().getAvailableProviders()).rejects.toThrow(
      'runtime probe crashed'
    );
  });

  it('retains successful runtime probes while surfacing a failed sibling probe', async () => {
    const bridgeProbe = vi.fn(async (runtimeId: string) => {
      if (runtimeId === 'lmstudio') {
        return { not_a_state: 'malformed' };
      }
      return {
        checkedAt: 123,
        endpoint: 'http://127.0.0.1:11434/api/tags',
        latencyMs: 5,
        state: 'available',
      };
    });
    (window as unknown as { runtime: { listModels: unknown; probe: unknown } }).runtime = {
      listModels: vi.fn(),
      probe: bridgeProbe,
    };

    const secretTarget = window as Window & { secrets?: unknown };
    secretTarget.secrets = {
      clearAll: vi.fn(),
      deleteKey: vi.fn(),
      getKey: vi.fn(),
      list: vi.fn().mockResolvedValue([]),
      listStored: vi.fn(),
      saveKey: vi.fn(),
    };

    try {
      let thrown: unknown;
      try {
        await useAssistantPreferencesStore.getState().getAvailableProviders();
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(AggregateError);
      expect(thrown).toMatchObject({
        providers: expect.arrayContaining(['local', 'ollama']),
      });
      expect((thrown as Error).message).toMatch(/lmstudio.*unexpected probe result shape/i);
    } finally {
      Reflect.deleteProperty(window as unknown as Record<string, unknown>, 'runtime');
    }
  });

  it('uses local runtime test overrides before probing services', async () => {
    const probeSpy = vi.spyOn(LocalRuntimeDiscoveryService.prototype, 'probeRuntime');
    __setSettingsTestOverridesForTests({
      localRuntime: {
        statuses: {
          ollama: {
            checkedAt: 111,
            message: 'blocked for test',
            state: 'blocked_web',
          },
        },
      },
    });

    const status = await useAssistantPreferencesStore.getState().getLocalRuntimeStatus('ollama', {
      force: true,
    });

    expect(status.state).toBe('blocked_web');
    expect(probeSpy).not.toHaveBeenCalled();
  });

  it('hides local runtime providers when localRuntimeEnabled is off, even if reachable', async () => {
    const probeSpy = vi
      .spyOn(LocalRuntimeDiscoveryService.prototype, 'probeRuntime')
      .mockResolvedValue({
        checkedAt: 100,
        endpoint: 'http://127.0.0.1:11434/api/tags',
        latencyMs: 1,
        state: 'available',
      });

    const secretTarget = window as Window & { secrets?: unknown };
    secretTarget.secrets = {
      clearAll: vi.fn(),
      deleteKey: vi.fn(),
      getKey: vi.fn(),
      list: vi.fn().mockResolvedValue([]),
      listStored: vi.fn(),
      saveKey: vi.fn(),
    };

    const store = useAssistantPreferencesStore.getState();
    store.setProviderSettings('ollama', { localRuntimeEnabled: 'off' });
    store.setProviderSettings('lmstudio', { localRuntimeEnabled: 'off' });

    const providers = await useAssistantPreferencesStore.getState().getAvailableProviders();
    expect(providers).not.toContain('ollama');
    expect(providers).not.toContain('lmstudio');
    // No probes should have fired for runtimes explicitly turned off.
    expect(probeSpy).not.toHaveBeenCalled();
  });

  it('force-includes local runtime providers when localRuntimeEnabled is on, skipping probes', async () => {
    const probeSpy = vi
      .spyOn(LocalRuntimeDiscoveryService.prototype, 'probeRuntime')
      .mockResolvedValue({ checkedAt: 100, message: 'oops', state: 'unavailable' });

    const secretTarget = window as Window & { secrets?: unknown };
    secretTarget.secrets = {
      clearAll: vi.fn(),
      deleteKey: vi.fn(),
      getKey: vi.fn(),
      list: vi.fn().mockResolvedValue([]),
      listStored: vi.fn(),
      saveKey: vi.fn(),
    };

    const store = useAssistantPreferencesStore.getState();
    store.setProviderSettings('ollama', { localRuntimeEnabled: 'on' });

    const providers = await useAssistantPreferencesStore.getState().getAvailableProviders();
    expect(providers).toContain('ollama');
    // `on` short-circuits detection — no ollama probe should have fired.
    expect(probeSpy.mock.calls.some((call) => call[0] === 'ollama')).toBe(false);
  });

  it("doesn't leak apiToken or sensitive fields into the boundary-violation error", async () => {
    // Reviewer feedback: if the main-process bridge ever echoes request
    // options back (e.g., a buggy wrapper that returns the request), the
    // shape guard's JSON.stringify would log the bearer token to console /
    // telemetry. Redact sensitive-looking fields before stringifying so a
    // malformed result can't carry a secret into logs.
    const bridgeProbe = vi.fn().mockResolvedValue({
      apiToken: 'sk-supersecret-12345',
      authorization: 'Bearer sk-also-secret',
      endpoint: { apiToken: 'nested-secret', baseUrl: 'http://host:11434' },
      not_a_state: 'oops',
    });
    (window as unknown as { runtime: { listModels: unknown; probe: unknown } }).runtime = {
      listModels: vi.fn(),
      probe: bridgeProbe,
    };

    try {
      const secretTarget = window as Window & { secrets?: unknown };
      secretTarget.secrets = {
        clearAll: vi.fn(),
        deleteKey: vi.fn(),
        getKey: vi.fn(),
        list: vi.fn().mockResolvedValue([]),
        listStored: vi.fn(),
        saveKey: vi.fn(),
      };

      await useAssistantPreferencesStore
        .getState()
        .getLocalRuntimeStatuses({ force: true })
        .catch((error: unknown) => {
          const message = error instanceof Error ? error.message : String(error);
          expect(message).not.toContain('sk-supersecret-12345');
          expect(message).not.toContain('sk-also-secret');
          expect(message).not.toContain('nested-secret');
        });
    } finally {
      Reflect.deleteProperty(window as unknown as Record<string, unknown>, 'runtime');
    }
  });

  it('caps the boundary-violation error message length to bound log/telemetry blast radius', async () => {
    // Reviewer feedback: a malformed bridge payload containing a very large
    // array or deeply nested object could otherwise produce a multi-MB error
    // string that flows into console logs and crash reports. Cap the
    // serialized summary so the diagnostic is useful but bounded.
    const huge = 'x'.repeat(10_000);
    const bridgeProbe = vi.fn().mockResolvedValue({
      filler: huge,
      not_a_state: 'oops',
    });
    (window as unknown as { runtime: { listModels: unknown; probe: unknown } }).runtime = {
      listModels: vi.fn(),
      probe: bridgeProbe,
    };

    try {
      const secretTarget = window as Window & { secrets?: unknown };
      secretTarget.secrets = {
        clearAll: vi.fn(),
        deleteKey: vi.fn(),
        getKey: vi.fn(),
        list: vi.fn().mockResolvedValue([]),
        listStored: vi.fn(),
        saveKey: vi.fn(),
      };

      let observedLength = 0;
      let observedMessage = '';
      await useAssistantPreferencesStore
        .getState()
        .getLocalRuntimeStatuses({ force: true })
        .catch((error: unknown) => {
          observedMessage = error instanceof Error ? error.message : String(error);
          observedLength = observedMessage.length;
        });
      // Generous upper bound — the cap is 4 KiB plus a small "Unexpected …
      // for ollama:" prefix and a "[truncated …]" suffix. Fail well before
      // the original ~10K filler would inflate the message.
      expect(observedLength).toBeGreaterThan(0);
      expect(observedLength).toBeLessThan(5000);
      expect(observedMessage).toMatch(/truncated/);
    } finally {
      Reflect.deleteProperty(window as unknown as Record<string, unknown>, 'runtime');
    }
  });

  it('rejects results whose state is not one of the known discriminant values', async () => {
    // Reviewer feedback (round 3): the previous shape guard accepted any
    // object with a string `state`. A runtime mismatch that produces
    // e.g. { state: 'busy' } — a value we never emit — should still fail
    // loudly at the boundary rather than let an unknown state propagate.
    const bridgeProbe = vi.fn().mockResolvedValue({ checkedAt: 1, state: 'busy' });
    (window as unknown as { runtime: { listModels: unknown; probe: unknown } }).runtime = {
      listModels: vi.fn(),
      probe: bridgeProbe,
    };

    try {
      const secretTarget = window as Window & { secrets?: unknown };
      secretTarget.secrets = {
        clearAll: vi.fn(),
        deleteKey: vi.fn(),
        getKey: vi.fn(),
        list: vi.fn().mockResolvedValue([]),
        listStored: vi.fn(),
        saveKey: vi.fn(),
      };

      await expect(
        useAssistantPreferencesStore.getState().getLocalRuntimeStatuses({ force: true })
      ).rejects.toThrow(/bridge|state|busy|unknown/i);
    } finally {
      Reflect.deleteProperty(window as unknown as Record<string, unknown>, 'runtime');
    }
  });

  it('rejects malformed probe results from the main-process bridge at the trust boundary', async () => {
    // Reviewer feedback: the store cast bridge results to
    // LocalRuntimeAvailabilityState without runtime validation. A compromised
    // main process or an Electron version mismatch could silently propagate
    // an invalid shape through the rest of the system. Fail loudly at the
    // boundary instead so root-cause shows up in logs with full context.
    const bridgeProbe = vi.fn().mockResolvedValue({ not_a_state: 'oops' });
    (window as unknown as { runtime: { listModels: unknown; probe: unknown } }).runtime = {
      listModels: vi.fn(),
      probe: bridgeProbe,
    };

    try {
      const secretTarget = window as Window & { secrets?: unknown };
      secretTarget.secrets = {
        clearAll: vi.fn(),
        deleteKey: vi.fn(),
        getKey: vi.fn(),
        list: vi.fn().mockResolvedValue([]),
        listStored: vi.fn(),
        saveKey: vi.fn(),
      };

      await expect(
        useAssistantPreferencesStore.getState().getLocalRuntimeStatuses({ force: true })
      ).rejects.toThrow(/bridge|malformed|shape|state/i);
    } finally {
      Reflect.deleteProperty(window as unknown as Record<string, unknown>, 'runtime');
    }
  });

  it('prefers window.runtime bridge over the in-renderer discovery service when available', async () => {
    // Simulates an Electron desktop renderer where the preload exposes
    // window.runtime. The renderer-side LocalRuntimeDiscoveryService would
    // hit CORS (Ollama rejects `file://` / `app://` origins), so the store
    // must delegate to the main-process bridge instead.
    const discoverySpy = vi
      .spyOn(LocalRuntimeDiscoveryService.prototype, 'probeRuntime')
      .mockResolvedValue({ checkedAt: 100, message: 'renderer CORS', state: 'unavailable' });
    const bridgeProbe = vi.fn().mockResolvedValue({
      checkedAt: 100,
      endpoint: 'http://127.0.0.1:11434/api/tags',
      latencyMs: 3,
      state: 'available',
    });
    (window as unknown as { runtime: { listModels: unknown; probe: unknown } }).runtime = {
      listModels: vi.fn(),
      probe: bridgeProbe,
    };

    try {
      const secretTarget = window as Window & { secrets?: unknown };
      secretTarget.secrets = {
        clearAll: vi.fn(),
        deleteKey: vi.fn(),
        getKey: vi.fn(),
        list: vi.fn().mockResolvedValue([]),
        listStored: vi.fn(),
        saveKey: vi.fn(),
      };

      const providers = await useAssistantPreferencesStore.getState().getAvailableProviders();
      expect(providers).toContain('ollama');
      // The in-renderer discovery MUST NOT be invoked when the bridge is live.
      expect(discoverySpy).not.toHaveBeenCalled();
      expect(bridgeProbe).toHaveBeenCalled();
    } finally {
      Reflect.deleteProperty(window as unknown as Record<string, unknown>, 'runtime');
    }
  });

  it('getLocalRuntimeStatus probes only the requested runtime, never its siblings', async () => {
    // Reviewer feedback (PR #873): the per-card "Probe now" button used to
    // call `getLocalRuntimeStatuses()` (plural) which fanned out to every
    // registered runtime as a side effect of clicking on one card. The new
    // singular `getLocalRuntimeStatus(runtimeId)` must only contact the
    // runtime the caller asked for so a click on the Ollama card cannot
    // touch LM Studio (and vice versa).
    const probeSpy = vi
      .spyOn(LocalRuntimeDiscoveryService.prototype, 'probeRuntime')
      .mockResolvedValue({
        checkedAt: 100,
        endpoint: 'http://127.0.0.1:11434/api/tags',
        latencyMs: 1,
        state: 'available',
      });

    const secretTarget = window as Window & { secrets?: unknown };
    secretTarget.secrets = {
      clearAll: vi.fn(),
      deleteKey: vi.fn(),
      getKey: vi.fn(),
      list: vi.fn().mockResolvedValue([]),
      listStored: vi.fn(),
      saveKey: vi.fn(),
    };

    const status = await useAssistantPreferencesStore
      .getState()
      .getLocalRuntimeStatus('ollama', { force: true });

    expect(status.state).toBe('available');
    const probedRuntimes = probeSpy.mock.calls.map((call) => call[0]);
    expect(probedRuntimes).toEqual(['ollama']);
    expect(probedRuntimes).not.toContain('lmstudio');
  });

  it('getLocalRuntimeStatus short-circuits to unavailable when activation is off', async () => {
    // Mirror the `off` short-circuit from `getLocalRuntimeStatuses` — a
    // disabled runtime must not be probed even when the singular API is
    // called directly (e.g., from the per-card "Probe now" button on a
    // card the user has explicitly toggled off).
    const probeSpy = vi
      .spyOn(LocalRuntimeDiscoveryService.prototype, 'probeRuntime')
      .mockResolvedValue({
        checkedAt: 100,
        endpoint: 'http://127.0.0.1:11434/api/tags',
        latencyMs: 1,
        state: 'available',
      });

    const secretTarget = window as Window & { secrets?: unknown };
    secretTarget.secrets = {
      clearAll: vi.fn(),
      deleteKey: vi.fn(),
      getKey: vi.fn(),
      list: vi.fn().mockResolvedValue([]),
      listStored: vi.fn(),
      saveKey: vi.fn(),
    };

    useAssistantPreferencesStore.getState().setProviderSettings('ollama', {
      localRuntimeEnabled: 'off',
    });

    const status = await useAssistantPreferencesStore
      .getState()
      .getLocalRuntimeStatus('ollama', { force: true });

    expect(status.state).toBe('unavailable');
    if (status.state === 'unavailable') {
      expect(status.message).toBe('Disabled by settings');
    }
    expect(probeSpy).not.toHaveBeenCalled();
  });

  it('passes a configured baseUrl into the runtime probe when set', async () => {
    const probeSpy = vi
      .spyOn(LocalRuntimeDiscoveryService.prototype, 'probeRuntime')
      .mockResolvedValue({ checkedAt: 100, message: 'down', state: 'unavailable' });

    const secretTarget = window as Window & { secrets?: unknown };
    secretTarget.secrets = {
      clearAll: vi.fn(),
      deleteKey: vi.fn(),
      getKey: vi.fn(),
      list: vi.fn().mockResolvedValue([]),
      listStored: vi.fn(),
      saveKey: vi.fn(),
    };

    const store = useAssistantPreferencesStore.getState();
    store.setProviderSettings('ollama', {
      localRuntimeBaseUrl: 'http://gpu.lan:11434',
      localRuntimeEnabled: 'auto',
    });

    await useAssistantPreferencesStore.getState().getAvailableProviders();
    const ollamaCall = probeSpy.mock.calls.find((call) => call[0] === 'ollama');
    const ollamaOptions = ollamaCall?.[1] as
      | { diagnosticLogLevel?: string; endpoint?: { baseUrl?: string } }
      | undefined;
    expect(ollamaOptions?.diagnosticLogLevel).toBe('debug');
    expect(ollamaOptions?.endpoint).toEqual({ baseUrl: 'http://gpu.lan:11434' });
  });

  it('excludes local runtime providers when runtime status is non-usable', async () => {
    vi.spyOn(LocalRuntimeDiscoveryService.prototype, 'probeRuntime').mockImplementation(
      async (runtimeId) => {
        if (runtimeId === 'ollama') {
          return { checkedAt: 200, message: 'blocked', state: 'blocked_web' };
        }
        return {
          checkedAt: 200,
          endpoint: 'http://127.0.0.1:1234/v1/models',
          state: 'auth_required',
          status: 401,
        };
      }
    );

    const secretTarget = window as Window & { secrets?: unknown };
    secretTarget.secrets = {
      clearAll: vi.fn(),
      deleteKey: vi.fn(),
      getKey: vi.fn(),
      list: vi.fn().mockResolvedValue([]),
      listStored: vi.fn(),
      saveKey: vi.fn(),
    };

    const providers = await useAssistantPreferencesStore.getState().getAvailableProviders();

    expect(providers).toContain('local');
    expect(providers).not.toContain('ollama');
    expect(providers).not.toContain('lmstudio');
  });

  it('getLocalRuntimeModels short-circuits to a synthetic failure state when activation is "off"', async () => {
    // The "off" tri-state must NOT contact the runtime — neither the
    // bridge nor the in-renderer service. A catalog refresh while the user
    // has explicitly disabled the runtime would otherwise keep the daemon
    // warm and surface confusing "unreachable" errors after the user
    // already opted out.
    const bridgeListModels = vi.fn();
    const bridgeProbe = vi.fn();
    (window as unknown as { runtime: { listModels: unknown; probe: unknown } }).runtime = {
      listModels: bridgeListModels,
      probe: bridgeProbe,
    };
    const inRendererSpy = vi.spyOn(LocalRuntimeDiscoveryService.prototype, 'probeRuntime');

    try {
      const store = useAssistantPreferencesStore.getState();
      store.setProviderSettings('ollama', { localRuntimeEnabled: 'off' });
      store.setProviderSettings('lmstudio', { localRuntimeEnabled: 'off' });

      const models = await useAssistantPreferencesStore.getState().getLocalRuntimeModels();

      // The synthetic catalog state has all the correct discriminants — the
      // UI must be able to read it without a separate "no entry" code path.
      expect(models.ollama).toMatchObject({
        availability: { message: 'Disabled by settings', state: 'unavailable' },
        message: 'Disabled by settings',
        runtime: 'ollama',
        state: 'failed',
      });
      expect(models.lmstudio).toMatchObject({
        runtime: 'lmstudio',
        state: 'failed',
      });

      // Critical: zero contact with either path while disabled.
      expect(bridgeListModels).not.toHaveBeenCalled();
      expect(bridgeProbe).not.toHaveBeenCalled();
      expect(inRendererSpy).not.toHaveBeenCalled();
    } finally {
      Reflect.deleteProperty(window as unknown as Record<string, unknown>, 'runtime');
    }
  });

  it('rejects malformed listModels results from the main-process bridge at the trust boundary', async () => {
    // Same trust-boundary contract as the probe handler: the catalog bridge
    // returns `unknown` from IPC, so a missing `runtime` discriminant or an
    // unrecognised `state` must throw with diagnostic context rather than
    // silently propagate. This locks in the listModels half of the
    // shape-guard pair (the probe half is covered above).
    // Both runtimes return malformed payloads so the assertion is robust
    // against the order Promise.all happens to settle them in.
    const bridgeListModels = vi
      .fn()
      .mockResolvedValue({ runtime: 'ollama', state: 'imaginary_state' });
    (window as unknown as { runtime: { listModels: unknown; probe: unknown } }).runtime = {
      listModels: bridgeListModels,
      probe: vi.fn(),
    };

    try {
      await expect(
        useAssistantPreferencesStore.getState().getLocalRuntimeModels({ force: true })
      ).rejects.toThrow(/catalog|bridge|state|imaginary_state/i);
    } finally {
      Reflect.deleteProperty(window as unknown as Record<string, unknown>, 'runtime');
    }
  });

  it('falls back to "[unserializable …]" when the malformed bridge payload contains a circular reference', async () => {
    // `summarizeBridgeResult` wraps `JSON.stringify` in a try/catch so a
    // malformed payload containing a circular reference cannot crash the
    // shape-guard error path — the user gets a typed-but-bounded fallback
    // string in the error message instead. Without this guard, throwing
    // inside the error builder would mask the original boundary violation.
    interface Cyclic {
      self?: Cyclic;
      state?: string;
    }
    const cyclic: Cyclic = { state: 'not_a_real_state' };
    cyclic.self = cyclic;

    const bridgeProbe = vi.fn().mockResolvedValue(cyclic);
    (window as unknown as { runtime: { listModels: unknown; probe: unknown } }).runtime = {
      listModels: vi.fn(),
      probe: bridgeProbe,
    };

    try {
      let captured = '';
      await useAssistantPreferencesStore
        .getState()
        .getLocalRuntimeStatuses({ force: true })
        .catch((error: unknown) => {
          captured = error instanceof Error ? error.message : String(error);
        });
      expect(captured).toMatch(/unserializable/);
      // The fallback must NOT contain `[object Object]` or any portion of
      // the circular structure — otherwise the error builder is leaking.
      expect(captured).not.toMatch(/\[object Object\]/);
    } finally {
      Reflect.deleteProperty(window as unknown as Record<string, unknown>, 'runtime');
    }
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
          local: ['LiquidAI/LFM2.5-1.2B-Instruct-ONNX'],
          openai: ['gpt-4o', 'gpt-4o-mini'],
          openrouter: ['openai/gpt-4o'],
          voyage: [],
        },
        modelsByProvider: {
          anthropic: 'claude-3-5-sonnet-latest',
          cohere: 'cohere',
          google: 'gemini-2.0-pro',
          local: 'local',
          openai: 'gpt-4o',
          openrouter: 'openai/gpt-4o',
          voyage: 'voyage',
        },
        providerSettings: {},
        selectedModel: 'openai::gpt-4o',
      },
      version: 3,
    };

    options.storage.setItem(options.name, legacyState);
    await persistApi.rehydrate?.();

    const store = useAssistantPreferencesStore.getState();
    expect(store.modelsByProvider['openai']).toBe('gpt-5.4');
    expect(store.modelsByProvider['anthropic']).toBe('claude-sonnet-4-6');
    expect(store.modelsByProvider['google']).toBe('gemini-2.5-pro');
    expect(store.modelsByProvider['openrouter']).toBe('openai/gpt-5.4');
    expect(store.modelsByProvider['local']).toBe('onnx-community/gemma-4-E2B-it-ONNX');
    expect(store.selectedModel).toBe('openai::gpt-5.4');
    expect(store.enabledModelsByProvider['openai']).toContain('gpt-5.4');
    expect(store.enabledModelsByProvider['openai']).toContain('gpt-5.4-mini');
    expect(store.enabledModelsByProvider['openai']).not.toContain('gpt-4o');
    expect(store.enabledModelsByProvider['local']).toContain('onnx-community/gemma-4-E2B-it-ONNX');
    expect(store.enabledModelsByProvider['local']).not.toContain(
      'LiquidAI/LFM2.5-1.2B-Instruct-ONNX'
    );
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
      storage.setItem(name, snapshot);
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

    options.storage.setItem(options.name, priorState);
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
    expect(store.modelsByProvider['google']).toBe('gemini-3.5-flash');
    expect(store.modelsByProvider['openrouter']).toBe('anthropic/claude-sonnet-4.6');
    expect(store.selectedModel).toBe('anthropic::claude-sonnet-4-6');

    // Removed 4-5 generation IDs are remapped...
    expect(store.enabledModelsByProvider['anthropic']).toContain('claude-sonnet-4-6');
    expect(store.enabledModelsByProvider['anthropic']).toContain('claude-opus-4-8');
    expect(store.enabledModelsByProvider['anthropic']).not.toContain('claude-sonnet-4-5');
    expect(store.enabledModelsByProvider['anthropic']).not.toContain('claude-opus-4-5');
    // ...but gemini-2.5-flash is now a first-class model and must NOT be rewritten.
    expect(store.enabledModelsByProvider['google']).toContain('gemini-2.5-flash');
    expect(store.enabledModelsByProvider['google']).toContain('gemini-3.5-flash');
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

    options.storage.setItem(options.name, staleSnapshot);
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

    options.storage.setItem(options.name, staleSnapshot);
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

    options.storage.setItem(options.name, legacyProviderState);
    await persistApi.rehydrate?.();

    const store = useAssistantPreferencesStore.getState();
    expect(store.modelsByProvider.google).toBe('gemini-3.5-flash');
    expect(store.selectedModel).toBe('google::gemini-3.5-flash');
    expect(store.enabledModelsByProvider.google).toContain('gemini-3.5-flash');
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

      options.storage.setItem(options.name, priorState);
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

      options.storage.setItem(options.name, priorState);
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

      options.storage.setItem(options.name, priorState);
      await persistApi.rehydrate?.();

      expect(useAssistantPreferencesStore.getState().planModeEnabled).toBe(false);
    });
  });
});
