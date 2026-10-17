// @vitest-environment node
import type { LocalEmbeddingHostClient } from '@brainstrike/agent/provider-runtime';
import type { VectorProfile } from '@brainstrike/indexer';
import { Schema } from 'effect';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { createDesktopHostMemoryConfiguration } from '../agent-host-platform/memory-model-configuration';
import {
  type PlatformSelection,
  PlatformSelectionSchema,
} from '../agent-host-platform/platform-wire';
import type { MutableFixture } from './fixtures/mutable-schema-fixture';

// The workspace index's one profile rule: a local token cap is optional.
const localProfile: VectorProfile = {
  dimensions: 8,
  distance: 'cosine',
  dtype: 'fp32',
  modelId: 'deterministic-configuration-proof',
  provider: 'local',
  revision: 'c'.repeat(40),
};
const hostedProfile: VectorProfile = {
  dimensions: 4,
  distance: 'cosine',
  modelId: 'text-embedding-3-small',
  provider: 'openai',
};
function selection(
  vectorProfile: VectorProfile | undefined,
  scope: 'thread' | 'resource' = 'thread'
): MutableFixture<PlatformSelection> {
  return Schema.decodeUnknownSync(PlatformSelectionSchema, {
    errors: 'all',
    onExcessProperty: 'error',
  })({
    configuration: { model: 'gpt-4.1-mini', provider: 'openai' },
    contextWindow: 128_000,
    durableConfiguration: {},
    inputTokenLimit: 64_000,
    maxSteps: 1,
    memory: {
      options: {
        lastMessages: 1,
        workingMemory: { enabled: false, scope: 'thread', template: '# Configuration proof' },
      },
      settings: {
        observationalMemory: {
          enabled: false,
          messageTokens: 30_000,
          modelTarget: 'openai/gpt-4.1-mini',
          observationTokens: 40_000,
          retrievalMode: 'off',
          scope: 'thread',
        },
        semanticRecall: {
          embeddingModelTarget: vectorProfile
            ? `${vectorProfile.provider}/${vectorProfile.modelId}`
            : null,
          enabled: vectorProfile !== undefined,
          messageRange: 0,
          scope,
          topK: 1,
        },
      },
      ...(vectorProfile ? { vectorProfile } : {}),
    },
    nativeRuntime: { provider: 'openai', workspaceRoots: [] },
    resourceId: 'configuration-proof-resource',
    tools: {},
    toolTimeoutMs: 10_000,
  });
}
function borrowed(queryEmbedding: LocalEmbeddingHostClient['queryEmbedding']) {
  return {
    embedding: { queryEmbedding },
    llm: {
      generate: async () => {
        throw new Error('Recall configuration borrows no local LLM');
      },
      warmup: async () => {
        throw new Error('Recall configuration borrows no local LLM');
      },
    },
    signal: new AbortController().signal,
  };
}
const fetch = vi.fn<typeof globalThis.fetch>(async () => {
  throw new Error('Live inference is forbidden in deterministic configuration proofs');
});
beforeEach(() => {
  fetch.mockClear();
  vi.stubGlobal('fetch', fetch);
});
afterEach(() => {
  vi.unstubAllGlobals();
});
test.each(['thread', 'resource'] as const)(
  'local %s recall borrows Main’s embedding host for the admitted profile and the caller signal',
  async (scope) => {
    const queries: {
      payload: unknown;
      signal: AbortSignal | undefined;
    }[] = [];
    const auth = vi.fn(async () => undefined);
    const configured = await createDesktopHostMemoryConfiguration(
      selection(localProfile, scope),
      auth,
      borrowed(async (payload, options) => {
        queries.push({ payload, signal: options?.signal });
        return Array.from({ length: localProfile.dimensions }, (_, index) => (index ? 0 : 1));
      })
    );
    expect(configured.native.options?.semanticRecall).toEqual({ messageRange: 0, scope, topK: 1 });
    expect(configured.vectors?.profile).toEqual(localProfile);
    const embedder = configured.vectors?.embedder;
    if (!embedder || typeof embedder === 'string') {
      throw new Error('A concrete local embedder is required');
    }
    const controller = new AbortController();
    await embedder.doEmbed({ abortSignal: controller.signal, values: ['recall query'] });
    expect(queries).toEqual([
      {
        payload: {
          dimensions: localProfile.dimensions,
          modelId: localProfile.modelId,
          modelKey: `local::${localProfile.modelId}`,
          query: 'recall query',
        },
        signal: controller.signal,
      },
    ]);
    expect(auth).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  }
);
test('hosted recall embeds in Node with the resolved credential for the admitted profile', async () => {
  fetch.mockImplementationOnce(async () =>
    Response.json({
      data: [{ embedding: [1, 0, 0, 0], index: 0, object: 'embedding' }],
      model: hostedProfile.modelId,
      object: 'list',
      usage: { prompt_tokens: 2, total_tokens: 2 },
    })
  );
  const auth = vi.fn(async () => ({ apiKey: 'offline-fixture-key', kind: 'api_key' as const }));
  const configured = await createDesktopHostMemoryConfiguration(selection(hostedProfile), auth);
  expect(auth).toHaveBeenCalledExactlyOnceWith('openai');
  expect(configured.vectors?.profile).toEqual(hostedProfile);
  const embedder = configured.vectors?.embedder;
  if (!embedder || typeof embedder === 'string') {
    throw new Error('A concrete hosted embedder is required');
  }
  const result = await embedder.doEmbed({ values: ['recall query'] });
  expect(result.embeddings).toEqual([[1, 0, 0, 0]]);
  const request = new Request(...(fetch.mock.calls[0] ?? ['about:blank']));
  expect(request.url).toMatch(/\/embeddings$/u);
  expect(request.headers.get('authorization')).toBe('Bearer offline-fixture-key');
});
test('missing vector capabilities refuse visibly without substituting a model', async () => {
  const noProfile = selection(localProfile);
  const { vectorProfile: _omitted, ...memory } = noProfile.memory;
  await expect(
    createDesktopHostMemoryConfiguration(
      { ...noProfile, memory },
      async () => undefined,
      borrowed(async () => [])
    )
  ).rejects.toThrow(/embedding profile Main admitted/);
  await expect(
    createDesktopHostMemoryConfiguration(selection(localProfile), async () => undefined)
  ).rejects.toThrow(/desktop embedding host/);
  await expect(
    createDesktopHostMemoryConfiguration(selection(hostedProfile), async () => undefined)
  ).rejects.toThrow(
    'Semantic recall requires a configured OpenAI API key. Configure it in Settings → Providers, choose a keyless local embedder, or turn semantic recall off.'
  );
  expect(fetch).not.toHaveBeenCalled();
});
test('disabled recall and existing observer messages/off options preserve provider model and thresholds', async () => {
  const admitted = selection(undefined);
  const disabled = await createDesktopHostMemoryConfiguration(admitted, async () => undefined);
  expect(disabled.native.options).toEqual({
    ...admitted.memory.options,
    observationalMemory: false,
    semanticRecall: false,
  });
  expect(disabled.vectors).toBeUndefined();
  for (const retrievalMode of ['off', 'messages'] as const) {
    admitted.memory.settings.observationalMemory = {
      ...admitted.memory.settings.observationalMemory,
      enabled: true,
      retrievalMode,
      scope: 'resource',
    };
    const auth = vi.fn(async () => ({
      apiKey: 'deterministic-no-call-fixture',
      kind: 'api_key' as const,
    }));
    const configuration = await createDesktopHostMemoryConfiguration(admitted, auth);
    expect(auth).toHaveBeenCalledExactlyOnceWith('openai');
    expect(configuration.native.options?.observationalMemory).toMatchObject({
      model: { modelId: 'gpt-4.1-mini' },
      observation: { messageTokens: 30_000 },
      reflection: { observationTokens: 40_000 },
      scope: 'resource',
    });
    const observation = configuration.native.options?.observationalMemory;
    if (!observation || typeof observation !== 'object') {
      throw new Error('Concrete observer is required');
    }
    expect(observation.retrieval).toEqual(
      retrievalMode === 'messages' ? { scope: 'resource' } : undefined
    );
  }
  await expect(
    createDesktopHostMemoryConfiguration(admitted, async () => undefined)
  ).rejects.toThrow(
    'Observational memory requires a configured OpenAI API key. Configure it in Settings → Providers, choose a keyless local observer, or turn observations off.'
  );
  expect(fetch).not.toHaveBeenCalled();
});
