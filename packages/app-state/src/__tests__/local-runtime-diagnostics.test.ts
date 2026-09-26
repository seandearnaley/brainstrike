import {
  LocalRuntimeDiscoveryService,
  LocalRuntimeModelCatalogService,
} from '@brainstrike/local-runtime';
import {
  addLogListener,
  configureLogger,
  LogLevel,
  type LogRecord,
  resetLogger,
} from '@brainstrike/logging';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  __resetAssistantPreferencesStoreForTests,
  useAssistantPreferencesStore,
} from '../stores/assistant-preferences-store';

let records: LogRecord[];
let unsubscribe: () => void;
const privateText = 'private-model-at-http://private-host:1234?token=private-token';
function events(): unknown[] {
  return records
    .filter((record) => record.scope === 'LocalRuntimeDiagnostics')
    .map((record) => record.args.find((arg) => typeof arg === 'object' && arg !== null));
}
beforeEach(() => {
  __resetAssistantPreferencesStoreForTests();
  configureLogger({ console: false, level: LogLevel.DEBUG });
  records = [];
  unsubscribe = addLogListener((record) => records.push(record));
  useAssistantPreferencesStore
    .getState()
    .setProviderSettings('lmstudio', { localRuntimeEnabled: 'off' });
});
afterEach(() => {
  unsubscribe();
  Reflect.deleteProperty(window, 'runtime');
  vi.restoreAllMocks();
  resetLogger();
});
function installBridge(probe: unknown, listModels: unknown = vi.fn()) {
  Object.defineProperty(window, 'runtime', { configurable: true, value: { listModels, probe } });
}
describe('local runtime diagnostics wiring', () => {
  it.each([
    'available',
    'unavailable',
    'blocked_web',
    'auth_required',
    'incompatible',
    'stale',
  ] as const)('reports native probe %s without payloads', async (state) => {
    installBridge(
      vi.fn().mockResolvedValue({ endpoint: privateText, message: privateText, state })
    );
    await useAssistantPreferencesStore.getState().getLocalRuntimeStatus('ollama');
    expect(events()).toEqual([
      {
        code: 'local_provider_probe_started',
        route: 'native-bridge',
        runtime: 'ollama',
        schemaVersion: 1,
      },
      {
        code: 'local_provider_probe_result',
        route: 'native-bridge',
        runtime: 'ollama',
        schemaVersion: 1,
        state,
      },
    ]);
    expect(JSON.stringify(events())).not.toContain(privateText);
  });
  it('reports browser-service probes through the same contract', async () => {
    vi.spyOn(LocalRuntimeDiscoveryService.prototype, 'probeRuntime').mockResolvedValue({
      checkedAt: 0,
      message: privateText,
      state: 'blocked_web',
    });
    await useAssistantPreferencesStore.getState().getLocalRuntimeStatus('ollama');
    expect(events()).toHaveLength(2);
    expect(events()[1]).toMatchObject({
      code: 'local_provider_probe_result',
      route: 'browser-service',
      state: 'blocked_web',
    });
  });
  it('pairs rejected probes and preserves the original error', async () => {
    const error = new Error(privateText);
    installBridge(vi.fn().mockRejectedValue(error));
    await expect(
      useAssistantPreferencesStore.getState().getLocalRuntimeStatus('ollama')
    ).rejects.toBe(error);
    expect(events()).toHaveLength(2);
    expect(events()[1]).toMatchObject({ code: 'local_provider_probe_result', state: 'error' });
    expect(JSON.stringify(events())).not.toContain(privateText);
  });
  it.each(['loaded_non_empty', 'loaded_empty', 'failed', 'stale_cached'] as const)(
    'reports native catalog %s without model ids',
    async (state) => {
      installBridge(
        vi.fn(),
        vi.fn().mockResolvedValue({
          message: privateText,
          models: [{ id: privateText }],
          runtime: 'ollama',
          state,
        })
      );
      await useAssistantPreferencesStore.getState().getLocalRuntimeModels();
      expect(events()).toEqual([
        {
          code: 'local_models_list_started',
          route: 'native-bridge',
          runtime: 'ollama',
          schemaVersion: 1,
        },
        {
          code: 'local_models_list_result',
          route: 'native-bridge',
          runtime: 'ollama',
          schemaVersion: 1,
          state,
        },
      ]);
    }
  );
  it('does not claim a probe or catalog request for disabled runtimes', async () => {
    useAssistantPreferencesStore
      .getState()
      .setProviderSettings('ollama', { localRuntimeEnabled: 'off' });
    await useAssistantPreferencesStore.getState().getLocalRuntimeStatuses();
    await useAssistantPreferencesStore.getState().getLocalRuntimeModels();
    expect(events()).toEqual([]);
  });
  it('records changed selections once without recording a custom model name', () => {
    const { setModel } = useAssistantPreferencesStore.getState();
    setModel(`ollama::${privateText}`);
    setModel(`ollama::${privateText}`);
    setModel('invalid');
    expect(events()).toEqual([
      { code: 'assistant_model_selected', provider: 'ollama', schemaVersion: 1 },
    ]);
  });
});

it('pairs catalog rejection without logging its error', async () => {
  const error = new Error(privateText);
  installBridge(vi.fn(), vi.fn().mockRejectedValue(error));
  await expect(useAssistantPreferencesStore.getState().getLocalRuntimeModels()).rejects.toBe(error);
  expect(events()).toHaveLength(2);
  expect(events()[1]).toMatchObject({ code: 'local_models_list_result', state: 'error' });
  expect(JSON.stringify(events())).not.toContain(privateText);
});
it('reports browser catalog outcomes without copying the catalog payload', async () => {
  vi.spyOn(LocalRuntimeModelCatalogService.prototype, 'listRuntimeModels').mockResolvedValue({
    availability: { checkedAt: 0, endpoint: privateText, latencyMs: 1, state: 'available' },
    checkedAt: 0,
    endpoint: privateText,
    freshness: 'live',
    models: [],
    runtime: 'ollama',
    source: 'ollama_api_tags',
    state: 'loaded_empty',
  });
  await useAssistantPreferencesStore.getState().getLocalRuntimeModels();
  expect(events()).toHaveLength(2);
  expect(events()[1]).toMatchObject({
    code: 'local_models_list_result',
    route: 'browser-service',
    state: 'loaded_empty',
  });
});
it('reports malformed native results as errors rather than accepting unknown diagnostic state', async () => {
  installBridge(vi.fn().mockResolvedValue({ state: privateText }));
  await expect(
    useAssistantPreferencesStore.getState().getLocalRuntimeStatus('ollama')
  ).rejects.toThrow('Unexpected probe result shape');
  expect(events()[1]).toMatchObject({ code: 'local_provider_probe_result', state: 'error' });
  expect(JSON.stringify(events())).not.toContain(privateText);
});
