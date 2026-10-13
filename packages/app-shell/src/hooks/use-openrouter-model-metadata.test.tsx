import { renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type AssistantHostProviders,
  type AssistantThreadHostCapability,
  AssistantThreadHostContext,
} from '../assistant-thread-host-context';
import { useOpenRouterModelMetadata } from './use-openrouter-model-metadata';

const readOpenRouterModel = vi.fn<AssistantHostProviders['readOpenRouterModel']>();
const host: AssistantThreadHostCapability = {
  createThread: vi.fn(),
  deleteThread: vi.fn(),
  listThreads: vi.fn(async () => []),
  ownsThread: vi.fn(async () => true),
  providers: { readOpenRouterModel, readStatus: vi.fn(), verifyProvider: vi.fn() },
  renameThread: vi.fn(),
  renderThread: vi.fn(),
  updateThreadBinding: vi.fn(),
  workspaceRepository: () => {
    throw new Error('Unexpected workspace snapshot access in this fixture');
  },
};
const wrapper = ({ children }: { readonly children: ReactNode }) => (
  <AssistantThreadHostContext.Provider value={host}>{children}</AssistantThreadHostContext.Provider>
);

describe('useOpenRouterModelMetadata', () => {
  beforeEach(() => {
    readOpenRouterModel.mockReset();
  });

  it('uses the live output ceiling without inventing a final-answer reserve', async () => {
    // Live vendor facts still rule the window: reasoning is active, but the
    // route's published completion limit (8,192) caps the catalog's recorded
    // vendor window (131,072) — nothing is invented past what the route
    // advertises (BST-1170).
    readOpenRouterModel.mockResolvedValue({
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

    const { result } = renderHook(
      () =>
        useOpenRouterModelMetadata({
          modelId: 'moonshotai/kimi-k3',
          modelSettings: undefined,
          providerId: 'openrouter',
          selectedModelDef: {
            contextWindow: 1_048_576,
            id: 'moonshotai/kimi-k3',
          },
          settings: undefined,
        }),
      { wrapper }
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
    readOpenRouterModel.mockResolvedValue({
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

    const { result } = renderHook(
      () =>
        useOpenRouterModelMetadata({
          modelId: 'moonshotai/kimi-k3',
          modelSettings: undefined,
          providerId: 'openrouter',
          selectedModelDef: {
            contextWindow: 1_048_576,
            id: 'moonshotai/kimi-k3',
          },
          settings: undefined,
        }),
      { wrapper }
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
