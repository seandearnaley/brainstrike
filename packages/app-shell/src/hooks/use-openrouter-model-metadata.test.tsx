import { renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fetchOpenRouterModelMetadata } from '../openrouter-model-metadata-client';
import { useOpenRouterModelMetadata } from './use-openrouter-model-metadata';

vi.mock('../openrouter-model-metadata-client', () => ({
  fetchOpenRouterModelMetadata: vi.fn(),
}));

vi.mock('../use-steer-active-run', () => ({
  hasDesktopAssistantBridge: () => true,
}));

vi.mock('./use-assistant-availability', () => ({
  resolveAssistantAuthHeaders: async () => ({}),
  resolveAssistantBaseUrl: async () => 'http://127.0.0.1:51234',
}));

describe('useOpenRouterModelMetadata', () => {
  beforeEach(() => {
    vi.mocked(fetchOpenRouterModelMetadata).mockReset();
  });

  it('uses the live output ceiling without inventing a final-answer reserve', async () => {
    // Live vendor facts still rule the window: reasoning is active, but the
    // route's published completion limit (8,192) caps the catalog's recorded
    // vendor window (131,072) — nothing is invented past what the route
    // advertises (BST-1170).
    vi.mocked(fetchOpenRouterModelMetadata).mockResolvedValue({
      freshness: 'live',
      metadata: {
        checkedAt: 42,
        contextWindow: 32_768,
        id: 'moonshotai/kimi-k3',
        maxOutputTokens: 8192,
        reasoning: {
          defaultEffort: 'max',
          defaultEnabled: true,
          mandatory: false,
          supportedEfforts: ['max', 'high', 'low'],
          supportsMaxTokens: false,
        },
        source: 'openrouter-models-api',
        supportedParameters: ['reasoning', 'max_tokens'],
      },
    });

    const { result } = renderHook(() =>
      useOpenRouterModelMetadata({
        modelId: 'moonshotai/kimi-k3',
        modelSettings: undefined,
        providerId: 'openrouter',
        selectedModelDef: {
          contextWindow: 1_048_576,
          id: 'moonshotai/kimi-k3',
        },
        settings: undefined,
      })
    );

    await waitFor(() => {
      expect(result.current.lookup?.state).toBe('resolved');
    });
    expect(result.current.reason).toBeUndefined();
    expect(result.current.agentLoopSettings).toEqual({ inputTokenLimit: 22_937 });
    expect(result.current.modelSettings).toEqual({ maxOutputTokens: 8192 });
  });

  it('surfaces catalog/live drift instead of composing an unsendable Auto request', async () => {
    // If a live snapshot stops advertising the catalog's recorded autoEffort,
    // the send path (which merges the same two sources) would throw composing
    // the request. The panel must say so up front — not validate raw live
    // metadata, claim all is well, and let send explode (BST-1170; the
    // same-snapshot rule in docs/agents/assistant-providers.md).
    vi.mocked(fetchOpenRouterModelMetadata).mockResolvedValue({
      freshness: 'live',
      metadata: {
        checkedAt: 42,
        contextWindow: 32_768,
        id: 'moonshotai/kimi-k3',
        maxOutputTokens: 8192,
        reasoning: {
          defaultEffort: 'minimal',
          defaultEnabled: true,
          mandatory: false,
          supportedEfforts: ['minimal'],
          supportsMaxTokens: false,
        },
        source: 'openrouter-models-api',
        supportedParameters: ['reasoning', 'max_tokens'],
      },
    });

    const { result } = renderHook(() =>
      useOpenRouterModelMetadata({
        modelId: 'moonshotai/kimi-k3',
        modelSettings: undefined,
        providerId: 'openrouter',
        selectedModelDef: {
          contextWindow: 1_048_576,
          id: 'moonshotai/kimi-k3',
        },
        settings: undefined,
      })
    );

    await waitFor(() => {
      expect(result.current.lookup?.state).toBe('resolved');
    });
    expect(result.current.reason).toBe(
      "moonshotai/kimi-k3: autoEffort 'low' is not in supportedEfforts [minimal]."
    );
    expect(result.current.agentLoopSettings).toBeUndefined();
    expect(result.current.modelSettings).toBeUndefined();
  });
});
