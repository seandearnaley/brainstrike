import {
  __resetAssistantPreferencesStoreForTests,
  useAssistantPreferencesStore,
} from '@brainstrike/app-state/stores/assistant-preferences-store';
import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  LocalRuntimeModelCatalogMap,
  LocalRuntimeStatusMap,
} from '../assistant-ui-panel-wrapper-runtime';
import { useAssistantLocalRuntimeCatalog } from '../hooks/use-assistant-local-runtime-catalog';

const availableOllamaStatus: LocalRuntimeStatusMap = {
  lmstudio: {
    checkedAt: 10,
    message: 'not detected',
    state: 'unavailable',
  },
  ollama: {
    checkedAt: 10,
    endpoint: 'http://127.0.0.1:11434/v1/models',
    latencyMs: 5,
    state: 'available',
  },
};

const ollamaModelCatalog: LocalRuntimeModelCatalogMap = {
  ollama: {
    availability: availableOllamaStatus.ollama,
    checkedAt: 20,
    endpoint: 'http://127.0.0.1:11434/v1/models',
    freshness: 'live',
    models: [
      {
        capabilities: { embeddings: 'unsupported', llm: true, vision: 'unknown' },
        capabilitySource: 'inferred',
        dimensionsKnown: { state: 'not_applicable' },
        displayName: 'Llama 3.2',
        endpoint: 'http://127.0.0.1:11434/v1/models',
        freshness: 'live',
        modelId: 'llama3.2',
        modelKey: 'ollama::llama3.2',
        providerId: 'ollama',
        runtime: 'ollama',
        source: 'openai_v1_models',
      },
    ],
    runtime: 'ollama',
    source: 'openai_v1_models',
    state: 'loaded_non_empty',
  },
};

function deferred<T>() {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

describe('useAssistantLocalRuntimeCatalog', () => {
  beforeEach(() => {
    __resetAssistantPreferencesStoreForTests();
  });

  it('loads model catalogs for reachable local runtimes and returns a model-count hint', async () => {
    const getLocalRuntimeStatuses = vi.fn().mockResolvedValue(availableOllamaStatus);
    const getLocalRuntimeModels = vi.fn().mockResolvedValue(ollamaModelCatalog);

    const { result } = renderHook(() =>
      useAssistantLocalRuntimeCatalog({
        getLocalRuntimeModels,
        getLocalRuntimeStatuses,
      })
    );

    await waitFor(() => {
      expect(result.current.localRuntimeModels).toBe(ollamaModelCatalog);
    });

    expect(getLocalRuntimeStatuses).toHaveBeenCalledTimes(1);
    expect(getLocalRuntimeStatuses).toHaveBeenCalledWith({ diagnosticLogLevel: 'debug' });
    expect(getLocalRuntimeModels).toHaveBeenCalledTimes(1);
    expect(getLocalRuntimeModels).toHaveBeenCalledWith({ diagnosticLogLevel: 'debug' });
    expect(result.current.localRuntimeHint).toBe(
      'Detected local runtime: Ollama (1 models) on localhost.'
    );
  });

  it('does not load models when every runtime is unreachable and surfaces blocked-web hints', async () => {
    const getLocalRuntimeStatuses = vi.fn().mockResolvedValue({
      lmstudio: {
        checkedAt: 10,
        message: 'not detected',
        state: 'unavailable',
      },
      ollama: {
        checkedAt: 10,
        message: 'fetch was blocked',
        state: 'blocked_web',
      },
    } satisfies LocalRuntimeStatusMap);
    const getLocalRuntimeModels = vi.fn();

    const { result } = renderHook(() =>
      useAssistantLocalRuntimeCatalog({
        getLocalRuntimeModels,
        getLocalRuntimeStatuses,
      })
    );

    await waitFor(() => {
      expect(result.current.localRuntimeHint).toBe(
        'Ollama probe was blocked by browser networking policy.'
      );
    });

    expect(getLocalRuntimeModels).not.toHaveBeenCalled();
    expect(getLocalRuntimeStatuses).toHaveBeenCalledWith({ diagnosticLogLevel: 'debug' });
    expect(result.current.localRuntimeModels).toBeNull();
  });

  it('surfaces a reachable runtime model-catalog failure instead of hiding the reason', async () => {
    const getLocalRuntimeStatuses = vi.fn().mockResolvedValue(availableOllamaStatus);
    const failedCatalog: LocalRuntimeModelCatalogMap = {
      ollama: {
        availability: availableOllamaStatus.ollama,
        checkedAt: 20,
        message:
          'Ollama capability lookup failed for "qwen3:30b": Update Ollama and retry discovery.',
        runtime: 'ollama',
        state: 'failed',
      },
    };
    const getLocalRuntimeModels = vi.fn().mockResolvedValue(failedCatalog);

    const { result } = renderHook(() =>
      useAssistantLocalRuntimeCatalog({
        getLocalRuntimeModels,
        getLocalRuntimeStatuses,
      })
    );

    await waitFor(() => {
      expect(result.current.localRuntimeModels).toBe(failedCatalog);
    });

    expect(result.current.localRuntimeHint).toBe(
      'Detected local runtime: Ollama (model discovery failed: Ollama capability lookup failed for "qwen3:30b": Update Ollama and retry discovery.) on localhost.'
    );
  });

  it('refreshes after settings change and ignores a superseded catalog response', async () => {
    const firstCatalog = deferred<LocalRuntimeModelCatalogMap>();
    const secondCatalog = deferred<LocalRuntimeModelCatalogMap>();
    const staleCatalog: LocalRuntimeModelCatalogMap = {
      ollama: {
        availability: availableOllamaStatus.ollama,
        checkedAt: 15,
        endpoint: 'http://old-host:11434/v1/models',
        freshness: 'live',
        models: [],
        runtime: 'ollama',
        source: 'openai_v1_models',
        state: 'loaded_empty',
      },
    };
    const getLocalRuntimeStatuses = vi.fn().mockResolvedValue(availableOllamaStatus);
    const getLocalRuntimeModels = vi
      .fn()
      .mockImplementationOnce(() => firstCatalog.promise)
      .mockImplementationOnce(() => secondCatalog.promise);
    const { result } = renderHook(() =>
      useAssistantLocalRuntimeCatalog({
        getLocalRuntimeModels,
        getLocalRuntimeStatuses,
      })
    );
    await waitFor(() => expect(getLocalRuntimeModels).toHaveBeenCalledTimes(1));

    act(() => {
      useAssistantPreferencesStore.getState().setProviderSettings('ollama', {
        localRuntimeBaseUrl: 'http://new-host:11434',
      });
    });
    await waitFor(() => expect(getLocalRuntimeModels).toHaveBeenCalledTimes(2));
    secondCatalog.resolve(ollamaModelCatalog);
    await waitFor(() => expect(result.current.localRuntimeModels).toBe(ollamaModelCatalog));

    firstCatalog.resolve(staleCatalog);
    await waitFor(() => expect(result.current.localRuntimeModels).toBe(ollamaModelCatalog));
    expect(getLocalRuntimeStatuses).toHaveBeenCalledTimes(2);
  });
});
