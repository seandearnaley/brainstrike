import { renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type {
  LocalRuntimeModelCatalogMap,
  LocalRuntimeStatusMap,
} from '../assistant-ui-panel-wrapper-runtime';
import { useAssistantLocalRuntimeCatalog } from '../hooks/use-assistant-local-runtime-catalog';

const availableOllamaStatus: LocalRuntimeStatusMap = {
  ollama: {
    state: 'available',
    checkedAt: 10,
    endpoint: 'http://127.0.0.1:11434/v1/models',
    latencyMs: 5,
  },
  lmstudio: {
    state: 'unavailable',
    checkedAt: 10,
    message: 'not detected',
  },
};

const ollamaModelCatalog: LocalRuntimeModelCatalogMap = {
  ollama: {
    state: 'loaded_non_empty',
    runtime: 'ollama',
    checkedAt: 20,
    availability: availableOllamaStatus.ollama,
    endpoint: 'http://127.0.0.1:11434/v1/models',
    source: 'openai_v1_models',
    freshness: 'live',
    models: [
      {
        runtime: 'ollama',
        providerId: 'ollama',
        modelId: 'llama3.2',
        modelKey: 'ollama::llama3.2',
        displayName: 'Llama 3.2',
        endpoint: 'http://127.0.0.1:11434/v1/models',
        source: 'openai_v1_models',
        freshness: 'live',
        capabilities: { llm: true, embeddings: 'unsupported' },
        capabilitySource: 'inferred',
        dimensionsKnown: { state: 'not_applicable' },
      },
    ],
  },
};

describe('useAssistantLocalRuntimeCatalog', () => {
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
      ollama: {
        state: 'blocked_web',
        checkedAt: 10,
        message: 'fetch was blocked',
      },
      lmstudio: {
        state: 'unavailable',
        checkedAt: 10,
        message: 'not detected',
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
});
