import { randomUUID } from 'node:crypto';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RuntimeData } from '@brainstrike/agent/provider-runtime';
import { resolveScaledToolResultBudget } from '@brainstrike/agent/tool-runtime';
import { DEFAULT_PERMISSION_POLICIES } from '@brainstrike/assistant-contract';
import { INTERNAL_FAULT } from '@brainstrike/assistant-contract/boundary-failure';
import type { VectorProfile } from '@brainstrike/indexer';
import type { MastraEmbeddingModel } from '@mastra/core/vector';
import { APICallError } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { attachAgentHost, type HostClient } from '../dist/client.js';
import {
  createProductionHostPlatform,
  type ProductionHostRunConfiguration,
} from '../dist/production-platform.js';
import type { HostEvent } from '../dist/protocol.js';
import { type AgentHost, startAgentHost } from '../dist/runtime.js';
import { scriptedToolSequence } from '../dist/test-fixtures/scripted-model.js';
import { captureHostFailureDiagnostics } from './fixtures/host-failure-diagnostics.js';

type Memory = Pick<ProductionHostRunConfiguration['memory'], 'native' | 'vectors'> &
  Partial<Pick<ProductionHostRunConfiguration['memory'], 'recordPrompt'>>;
type Finished = Extract<HostEvent, { type: 'run.finished' }>;

const modelId = 'gpt-6-sol';
const configuration: RuntimeData = { model: modelId, provider: 'openai' };
const resourceId = 'memory-failure-fixture';
const profile: VectorProfile = {
  dimensions: 4,
  distance: 'cosine',
  modelId: 'fixture-embedder-4',
  provider: 'openai',
};
const plain: Memory = {
  native: {
    options: {
      lastMessages: 4,
      observationalMemory: false,
      semanticRecall: false,
      workingMemory: { enabled: false },
    },
  },
};
const recall = { messageRange: 0, scope: 'resource', topK: 1 } as const;
/** A run's detail names its correlation id; the one diagnostic record with it holds the cause. */
const REFERENCE = / Reference: ([0-9a-f-]{36})$/u;

const fetch = vi.fn(async () => {
  throw new Error('Memory failure proofs make no provider requests');
});
beforeEach(() => {
  fetch.mockClear();
  vi.stubGlobal('fetch', fetch);
});
afterEach(() => vi.unstubAllGlobals());

/** An embedder whose first call with a value matching `fails` throws `failure()`. */
function embedder(
  fails: RegExp,
  failure: () => unknown = () => new Error('Recorded embedder failure'),
  dimensions = 4
): Extract<MastraEmbeddingModel<string>, { specificationVersion: 'v3' }> {
  let failed = false;
  return {
    doEmbed: async ({ values }) => {
      if (!failed && values.some((value) => fails.test(value))) {
        failed = true;
        throw failure();
      }
      return {
        embeddings: values.map(() => Array.from({ length: dimensions }, (_, i) => (i ? 0 : 1))),
        warnings: [],
      };
    },
    maxEmbeddingsPerCall: 16,
    modelId: profile.modelId,
    provider: 'fixture',
    specificationVersion: 'v3',
    supportsParallelCalls: false,
  };
}

/** Semantic recall over `failing`, with the recall query's embedding first. */
const recalling =
  (failing: ReturnType<typeof embedder>, vectorProfile: VectorProfile = profile) =>
  (): Memory => ({
    native: { options: { ...plain.native.options, semanticRecall: recall } },
    vectors: { embedder: failing, profile: vectorProfile },
  });

/** The production composition through the runtime; `memory(n)` configures run n. */
async function failureHost(memory: (run: number) => Memory) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'bs-memory-failure-')));
  let admitted = 0;
  const host: AgentHost = await startAgentHost({ lifetime: 'persistent', root }, (startup) =>
    createProductionHostPlatform({
      close: async () => undefined,
      memoryResourceIds: [resourceId],
      readConfiguration: async (): Promise<ProductionHostRunConfiguration> => ({
        configuration,
        durableConfiguration: { model: modelId, provider: 'openai' },
        maxSteps: 2,
        memory: {
          recordPrompt: async () => undefined,
          ...memory(admitted++),
          observerModelId: 'openai::gpt-4.1-mini',
          resourceId,
        },
        providerRequestContext: {
          inputTokenLimit: 50_000,
          provider: 'openai',
          runtimeData: configuration,
        },
        resolvedToolResultBudget: resolveScaledToolResultBudget(20_000),
        tools: {},
        toolTimeoutMs: 10_000,
      }),
      readPermissionPolicy: () => ({ policies: DEFAULT_PERMISSION_POLICIES, yolo: false }),
      resolveModel: async () => scriptedToolSequence([]),
      resolveProviderAuth: async () => undefined,
      startup,
    })
  );
  const client: HostClient = await attachAgentHost(host.record);
  const { threadId } = await client.request('thread/start', { commandId: randomUUID() });
  const run = async (prompt: string): Promise<Finished | undefined> => {
    const { runId } = await client.request('run/start', {
      commandId: randomUUID(),
      modelId: `openai::${modelId}`,
      prompt,
      threadId,
    });
    let finished: Finished | undefined;
    await expect
      .poll(
        async () => {
          finished = (await client.request('thread/read', { fromSeq: 0, threadId })).rows
            .map((row) => row.event)
            .find(
              (event): event is Finished => event.type === 'run.finished' && event.runId === runId
            );
          return finished !== undefined;
        },
        { timeout: 30_000 }
      )
      .toBe(true);
    return finished;
  };
  return {
    close: async () => {
      await client.close();
      await host.close();
      await rm(root, { force: true, recursive: true });
    },
    run,
  };
}

const observer = (fail: boolean): MockLanguageModelV4 =>
  new MockLanguageModelV4({
    doStream: async () => {
      if (fail) {
        throw new Error('Recorded observer failure');
      }
      return scriptedToolSequence([]).doStream({ prompt: [] });
    },
  });

/** A provider's HTTP rejection, as the AI SDK reports one. */
const rejected = (statusCode: number) => () =>
  new APICallError({
    isRetryable: false,
    message: 'Incorrect API key provided: sk-fixture-not-a-key',
    requestBodyValues: {},
    responseBody: '{"error":{"message":"Incorrect API key provided: sk-fixture-not-a-key"}}',
    statusCode,
    url: 'https://memory-provider.invalid/v1/embeddings',
  });

const observing = (run: number): Memory => ({
  native: {
    options: {
      ...plain.native.options,
      observationalMemory: {
        model: observer(run === 0),
        // The committed prompt alone crosses this threshold.
        observation: { bufferTokens: false, messageTokens: 5 },
        reflection: { observationTokens: 40_000 },
        scope: 'thread',
      },
    },
  },
});

test.each([
  {
    cause: 'Observational memory requires resolved concrete observer and reflector models',
    code: 'memory.configuration-invalid',
    detail:
      'Memory cannot run with this configuration. Review Settings → Assistant Memory, then retry.',
    // A non-concrete observer refuses construction: the run's Memory never opens.
    memory: (run: number): Memory =>
      run === 0
        ? {
            native: {
              options: {
                ...plain.native.options,
                observationalMemory: { model: 'openai/gpt-4.1-mini', scope: 'thread' },
              },
            },
          }
        : plain,
    name: 'configuration',
  },
  {
    cause: 'Recorded embedder failure',
    code: 'memory.embedder-failed',
    detail:
      'Memory recall failed because its embedding model (OpenAI fixture-embedder-4) failed. Retry, or review Settings → Assistant Memory.',
    memory: recalling(embedder(/Which city/u)),
    name: 'recall embedder',
  },
  {
    cause: 'Recorded embedder failure',
    code: 'memory.embedder-failed',
    detail:
      'Memory save failed because its embedding model (OpenAI fixture-embedder-4) failed. Retry, or review Settings → Assistant Memory.',
    // Only the saved assistant reply embeds this text; recall never queries it.
    memory: recalling(embedder(/Host run completed/u)),
    name: 'save embedder',
  },
  {
    cause: 'Incorrect API key provided',
    code: 'memory.embedder-failed',
    // The run's chat provider is OpenAI; the memory embedder's own provider is named.
    detail:
      'Memory recall failed because its embedding model (Google AI Studio fixture-embedder-4) failed. Check the Google AI Studio API key in Settings → Providers, or choose another embedding model in Settings → Assistant Memory. Provider response: Google AI Studio returned HTTP 401.',
    memory: recalling(embedder(/Which city/u, rejected(401)), { ...profile, provider: 'google' }),
    name: 'rejected embedder credential',
  },
  {
    cause: 'Native Memory index does not match the acquired vector profile',
    code: 'memory.vector-store-failed',
    detail: 'Memory recall failed because its vector store failed.',
    // The store refuses a query vector of another profile's dimensions.
    memory: (run: number): Memory =>
      run === 0 ? recalling(embedder(/^$/u, undefined, 3))() : plain,
    name: 'vector store',
  },
  {
    cause: 'Recorded observer failure',
    code: 'memory.observer-failed',
    detail:
      'Memory observe failed because its observer model (OpenAI gpt-4.1-mini) failed. Retry, or review Settings → Assistant Memory.',
    memory: observing,
    name: 'observer',
  },
  {
    cause: 'Recorded prompt receipt failure',
    code: INTERNAL_FAULT.code,
    // An untyped memory failure stays the internal fault, its cause found by reference.
    detail: INTERNAL_FAULT.message,
    memory: (run: number): Memory =>
      run === 0
        ? {
            ...plain,
            recordPrompt: async () => {
              throw new Error('Recorded prompt receipt failure');
            },
          }
        : plain,
    name: 'untyped',
  },
])(
  'a $name memory failure fails the run with its typed reason and reference, and the thread runs again',
  async ({ cause, code, detail, memory }) => {
    const diagnostics = captureHostFailureDiagnostics();
    const host = await failureHost(memory);
    try {
      const failed = await host.run('Which city did I mention?');
      expect(failed).toMatchObject({ outcome: 'failed' });
      // One typed reason, once, naming the reference its cause was logged under.
      const reference = REFERENCE.exec(failed?.detail ?? '')?.[1];
      expect(failed?.detail).toBe(`${detail} Reference: ${reference}`);
      diagnostics.expectCorrelatedCause(reference ?? 'no reference', { cause, code });
      // The owner was released: the same thread admits and completes another run.
      expect(await host.run('Report completion.')).toMatchObject({ outcome: 'completed' });
      expect(fetch).not.toHaveBeenCalled();
    } finally {
      await host.close();
    }
  }
);
