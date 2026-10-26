// @vitest-environment node

import { BoundaryFailureError } from '@brainstrike/assistant-contract';
import { DEFAULT_RUNTIME_ASSISTANT_MEMORY_SETTINGS } from '@brainstrike/assistant-contract/memory-settings';
import { afterEach, expect, test, vi } from 'vitest';
import { resolveDesktopMemoryEmbedderProbe } from '../agent-host-platform/memory-vector-configuration';

/**
 * BST-2227: Settings' Test embedder resolves its embedder as a run's admission
 * does: Main's profile for the selected target, this host's API key, the run's
 * hosted embedder and the hosted classification indexing uses (BST-2202).
 */
const HOSTED = 'openai/text-embedding-3-small';
const PROFILE = {
  dimensions: 1536,
  distance: 'cosine' as const,
  modelId: 'text-embedding-3-small',
  provider: 'openai' as const,
};
const settings = (embeddingModelTarget: string | null) => ({
  ...DEFAULT_RUNTIME_ASSISTANT_MEMORY_SETTINGS,
  semanticRecall: {
    ...DEFAULT_RUNTIME_ASSISTANT_MEMORY_SETTINGS.semanticRecall,
    embeddingModelTarget,
  },
});
const apiKey = async () => ({ apiKey: 'sk-test-probe', kind: 'api_key' as const });

afterEach(() => {
  vi.unstubAllGlobals();
});

async function refusal(work: Promise<unknown>) {
  const cause = await work.then(
    () => undefined,
    (error: unknown) => error
  );
  if (!(cause instanceof BoundaryFailureError)) {
    throw new Error(`Expected a typed failure, got ${String(cause)}`);
  }
  return cause.failure;
}

test('a hosted target resolves through Main with recall treated as on, as the run’s embedder', async () => {
  const readMemoryVectors = vi.fn(async () => PROFILE);
  const resolveProviderAuth = vi.fn(apiKey);
  // Recall is off in these settings: the probe still tests the selection.
  expect(settings(HOSTED).semanticRecall.enabled).toBe(false);

  const target = await resolveDesktopMemoryEmbedderProbe(
    settings(HOSTED),
    readMemoryVectors,
    resolveProviderAuth,
    new AbortController().signal
  );

  expect(readMemoryVectors).toHaveBeenCalledWith(
    expect.objectContaining({
      semanticRecall: expect.objectContaining({ embeddingModelTarget: HOSTED, enabled: true }),
    }),
    expect.any(AbortSignal)
  );
  expect(resolveProviderAuth).toHaveBeenCalledWith('openai');
  expect(target.identity.modelId).toBe('openai::text-embedding-3-small');
  expect(typeof target.embedder === 'object' && target.embedder.modelId).toBe(
    'text-embedding-3-small'
  );
});

test('a provider rejection reads with the hosted classification indexing uses', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async () =>
        new Response(JSON.stringify({ error: { message: 'Incorrect API key provided' } }), {
          headers: { 'content-type': 'application/json' },
          status: 401,
        })
    )
  );
  const target = await resolveDesktopMemoryEmbedderProbe(
    settings(HOSTED),
    async () => PROFILE,
    apiKey,
    new AbortController().signal
  );
  if (typeof target.embedder !== 'object' || target.embedder.specificationVersion !== 'v3') {
    throw new Error('The hosted embedder must be a v3 model');
  }

  const cause = await target.embedder.doEmbed({ values: ['probe'] }).then(
    () => undefined,
    (error: unknown) => error
  );

  expect(target.identity.classifyFailure?.(cause)).toEqual({
    detail: 'Embedding provider openai refused the request (HTTP 401).',
    httpStatus: 401,
  });
});

test('no selected target is the selection refusal, with its remedy', async () => {
  const failure = await refusal(
    resolveDesktopMemoryEmbedderProbe(settings(null), vi.fn(), apiKey, new AbortController().signal)
  );

  expect(failure).toMatchObject({
    code: 'memory.configuration-invalid',
    message: 'Semantic recall has no embedding model selected.',
    remedy: 'Choose an embedding model in Settings → Assistant Memory.',
  });
});

test('a provider with no key is the run’s credential refusal', async () => {
  const failure = await refusal(
    resolveDesktopMemoryEmbedderProbe(
      settings(HOSTED),
      async () => PROFILE,
      async () => undefined,
      new AbortController().signal
    )
  );

  expect(failure).toMatchObject({ code: 'memory.credential-missing', kind: 'refusal' });
});
