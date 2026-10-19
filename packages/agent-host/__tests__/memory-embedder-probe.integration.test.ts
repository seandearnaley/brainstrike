import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  BoundaryFailureError,
  DEFAULT_PERMISSION_POLICIES,
  refusalError,
} from '@brainstrike/assistant-contract';
import type { MastraEmbeddingModel } from '@mastra/core/vector';
import { APICallError } from 'ai';
import { expect, test, vi } from 'vitest';
import { attachAgentHost } from '../dist/client.js';
import {
  createProductionHostPlatform,
  type ProductionHostPlatformOptions,
} from '../dist/production-platform.js';
import { HOST_MEMORY_EMBEDDER_PROBE_TEXT } from '../dist/protocol.js';
import { startAgentHost } from '../dist/runtime.js';

/**
 * BST-2227 `memory/embedder/probe` through the production composition and a
 * real connection: the platform resolves the embedder, the host embeds the
 * fixed probe text once, and a failure reads as a run's embedder failure.
 */
const MEMORY_SETTINGS = {
  observationalMemory: { enabled: false },
  semanticRecall: { embeddingModelTarget: 'openai/text-embedding-3-small', enabled: false },
};
const MODEL_ID = 'openai::text-embedding-3-small';
const PROVIDER_BODY = '{"error":{"message":"Incorrect API key provided: sk-fixture-not-a-key"}}';

/** A provider embedding model whose one call answers with `embed`, recording each call's texts. */
function embeddingModel(embed: () => Promise<number[][]>) {
  const calls: string[][] = [];
  const model: MastraEmbeddingModel<string> = {
    doEmbed: async ({ values }) => {
      calls.push([...values]);
      return { embeddings: await embed(), warnings: [] };
    },
    maxEmbeddingsPerCall: 1,
    modelId: 'text-embedding-3-small',
    provider: 'openai',
    specificationVersion: 'v3',
    supportsParallelCalls: true,
  };
  return { calls, model };
}

async function probe(
  resolveMemoryEmbedder?: ProductionHostPlatformOptions['resolveMemoryEmbedder']
) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'bs-memory-embedder-probe-')));
  const host = await startAgentHost({ lifetime: 'persistent', root }, (startup) =>
    createProductionHostPlatform({
      close: async () => undefined,
      readConfiguration: async () => {
        throw new Error('A probe must not acquire a run selection');
      },
      readPermissionPolicy: () => ({ policies: { ...DEFAULT_PERMISSION_POLICIES }, yolo: false }),
      ...(resolveMemoryEmbedder ? { resolveMemoryEmbedder } : {}),
      resolveProviderAuth: async () => {
        throw new Error('A probe resolves credentials through its platform resolver');
      },
      startup,
    })
  );
  const client = await attachAgentHost(host.record);
  try {
    return await client.request('memory/embedder/probe', { memorySettings: MEMORY_SETTINGS }).then(
      (result) => ({ result }) as const,
      (failure: unknown) => ({ failure }) as const
    );
  } finally {
    await client.close();
    await host.close();
    await rm(root, { force: true, recursive: true });
  }
}

function typedFailure(outcome: Awaited<ReturnType<typeof probe>>) {
  if (!('failure' in outcome && outcome.failure instanceof BoundaryFailureError)) {
    throw new Error(`Expected a typed failure, got ${JSON.stringify(outcome)}`);
  }
  return outcome.failure.failure;
}

test('the probe embeds the fixed text once and reports its dimensions and latency', async () => {
  const embedder = embeddingModel(async () => [[0.1, 0.2, 0.3, 0.4]]);
  const resolveMemoryEmbedder = vi.fn<
    NonNullable<ProductionHostPlatformOptions['resolveMemoryEmbedder']>
  >(async () => ({ embedder: embedder.model, identity: { modelId: MODEL_ID } }));

  const outcome = await probe(resolveMemoryEmbedder);

  expect(outcome).toEqual({
    result: { dimensions: 4, latencyMs: expect.any(Number), modelId: MODEL_ID },
  });
  // The settings reach the platform as the client sent them.
  expect(resolveMemoryEmbedder).toHaveBeenCalledWith(
    expect.objectContaining({ memorySettings: MEMORY_SETTINGS })
  );
  // One provider call, no retry, with only the fixed probe text.
  expect(embedder.calls).toEqual([[HOST_MEMORY_EMBEDDER_PROBE_TEXT]]);
});

test('a rejected probe is the embedder’s typed failure, read with the platform’s classification', async () => {
  const embedder = embeddingModel(async () => {
    throw new APICallError({
      isRetryable: false,
      message: 'Incorrect API key provided: sk-fixture-not-a-key',
      requestBodyValues: {},
      responseBody: PROVIDER_BODY,
      statusCode: 401,
      url: 'https://memory-provider.invalid/v1/embeddings',
    });
  });
  const classifyFailure = vi.fn(() => ({
    detail: 'Embedding provider openai refused the request (HTTP 401).',
    httpStatus: 401,
  }));

  const failure = typedFailure(
    await probe(async () => ({
      embedder: embedder.model,
      identity: { classifyFailure, modelId: MODEL_ID },
    }))
  );

  expect(failure).toMatchObject({
    code: 'memory.embedder-failed',
    correlationId: expect.stringMatching(/^[0-9a-f-]{36}$/u),
    kind: 'fault',
    message:
      'Memory embedder test failed because its embedding model (OpenAI text-embedding-3-small) failed: Embedding provider openai refused the request (HTTP 401).',
    providerEvidence: 'OpenAI returned HTTP 401.',
    remedy:
      'Check the OpenAI API key in Settings → Providers, or choose another embedding model in Settings → Assistant Memory.',
  });
  expect(classifyFailure).toHaveBeenCalledTimes(1);
  // The provider's body and the key it echoes stay in the log, never in the failure.
  expect(JSON.stringify(failure)).not.toContain('sk-fixture-not-a-key');
});

test('a platform refusal while resolving the embedder crosses unchanged', async () => {
  const failure = typedFailure(
    await probe(async () => {
      throw refusalError(
        'configuration',
        'memory.credential-missing',
        'Semantic recall uses OpenAI, which needs an API key.'
      );
    })
  );

  expect(failure).toEqual({
    category: 'configuration',
    code: 'memory.credential-missing',
    kind: 'refusal',
    message: 'Semantic recall uses OpenAI, which needs an API key.',
  });
});

test('an embedder that answers with no vector is a fault, not a passed test', async () => {
  const embedder = embeddingModel(async () => []);

  const failure = typedFailure(
    await probe(async () => ({ embedder: embedder.model, identity: { modelId: MODEL_ID } }))
  );

  expect(failure).toMatchObject({
    code: 'memory.embedder-failed',
    kind: 'fault',
    message: `The embedding model (${MODEL_ID}) returned no embedding for the test text.`,
  });
});

test('a host without an embedder resolver refuses the probe', async () => {
  expect(typedFailure(await probe())).toEqual({
    category: 'configuration',
    code: 'memory.unavailable',
    kind: 'refusal',
    message: 'This host cannot test a memory embedder',
  });
});
