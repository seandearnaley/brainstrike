import {
  BoundaryFailureError,
  INTERNAL_FAULT,
  refusalError,
} from '@brainstrike/assistant-contract';
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
  renderNewThread: (resourceId) => <div data-testid="new-thread-composer">{resourceId}</div>,
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

  it("shows a host refusal's remedy beside its reason, so a missing key says where to add one", async () => {
    readOpenRouterModel.mockRejectedValue(
      refusalError(
        'configuration',
        'provider.credential-missing',
        'No API key configured for provider "openrouter".',
        'Add an OpenRouter API key in Providers.'
      )
    );

    const { result } = renderHook(
      () =>
        useOpenRouterModelMetadata({
          modelId: 'anthropic/claude-sonnet-4.6',
          modelSettings: undefined,
          providerId: 'openrouter',
          selectedModelDef: { contextWindow: 1_000_000, id: 'anthropic/claude-sonnet-4.6' },
          settings: undefined,
        }),
      { wrapper }
    );

    await waitFor(() => {
      expect(result.current.lookup).toEqual({
        message:
          'No API key configured for provider "openrouter". Add an OpenRouter API key in Providers.',
        state: 'error',
      });
    });
  });

  it('names the reference a host fault was logged under, so the user can find it in the log', async () => {
    const reference = '3f2b8c1e-5d4a-4b7e-9c2d-1a2b3c4d5e6f';
    readOpenRouterModel.mockRejectedValue(
      new BoundaryFailureError({ ...INTERNAL_FAULT, correlationId: reference })
    );

    const { result } = renderHook(
      () =>
        useOpenRouterModelMetadata({
          modelId: 'anthropic/claude-sonnet-4.6',
          modelSettings: undefined,
          providerId: 'openrouter',
          selectedModelDef: { contextWindow: 1_000_000, id: 'anthropic/claude-sonnet-4.6' },
          settings: undefined,
        }),
      { wrapper }
    );

    await waitFor(() => {
      expect(result.current.lookup).toEqual({
        message: `${INTERNAL_FAULT.message} Reference: ${reference}`,
        state: 'error',
      });
    });
  });

  it('names a persisted output limit the catalog window cannot fit when the details fail to load (BST-1810)', async () => {
    // MiniMax M3: window 524,288, margin 26,215. A persisted 512,000 output
    // leaves no input budget; with live details unavailable, the run budgets
    // on the catalog row, so the composer must say why instead of throwing.
    readOpenRouterModel.mockRejectedValue(new Error('unavailable'));

    const { result } = renderHook(
      () =>
        useOpenRouterModelMetadata({
          modelId: 'minimax/minimax-m3',
          // The thread draft carries the persisted provider setting as the request sends it.
          modelSettings: { maxOutputTokens: 512_000 },
          providerId: 'openrouter',
          selectedModelDef: {
            contextWindow: 524_288,
            id: 'minimax/minimax-m3',
            maxOutputTokens: 512_000,
          },
          settings: { maxOutputTokens: 512_000 },
        }),
      { wrapper }
    );

    await waitFor(() => {
      expect(result.current.lookup?.state).toBe('error');
    });
    expect(result.current.reason).toBe(
      'Configured output limit 512,000 cannot fit within the OpenRouter built-in catalog context window 524,288 plus its safety margin.'
    );
    expect(result.current.agentLoopSettings).toBeUndefined();
  });
});
