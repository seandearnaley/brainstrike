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

type Memory = Pick<ProductionHostRunConfiguration['memory'], 'native' | 'vectors'>;
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

const fetch = vi.fn(async () => {
  throw new Error('Memory failure proofs make no provider requests');
});
beforeEach(() => {
  fetch.mockClear();
  vi.stubGlobal('fetch', fetch);
});
afterEach(() => vi.unstubAllGlobals());

/** An embedder that fails its first call whose values match `fails`. */
function embedder(
  fails: RegExp
): Extract<MastraEmbeddingModel<string>, { specificationVersion: 'v3' }> {
  let failed = false;
  return {
    doEmbed: async ({ values }) => {
      if (!failed && values.some((value) => fails.test(value))) {
        failed = true;
        throw new Error('Recorded embedder failure');
      }
      return {
        embeddings: values.map(() => Array.from({ length: 4 }, (_, i) => (i ? 0 : 1))),
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
          ...memory(admitted++),
          observerModelId: 'openai::gpt-4.1-mini',
          recordPrompt: async () => undefined,
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

test.each([
  {
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
    step: 'open',
  },
  {
    memory: (() => {
      const failing = embedder(/Which city/u);
      return (): Memory => ({
        native: {
          options: {
            ...plain.native.options,
            semanticRecall: { messageRange: 0, scope: 'resource', topK: 1 },
          },
        },
        vectors: { embedder: failing, profile },
      });
    })(),
    step: 'recall',
  },
  {
    memory: (() => {
      // Only the saved assistant reply embeds this text; recall never queries it.
      const failing = embedder(/Host run completed/u);
      return (): Memory => ({
        native: {
          options: {
            ...plain.native.options,
            semanticRecall: { messageRange: 0, scope: 'resource', topK: 1 },
          },
        },
        vectors: { embedder: failing, profile },
      });
    })(),
    step: 'save',
  },
  {
    memory: (run: number): Memory => ({
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
    }),
    step: 'observe',
  },
])(
  'a memory $step failure ends the run as failed and the thread accepts the next run',
  async ({ memory, step }) => {
    const diagnostics = captureHostFailureDiagnostics();
    const host = await failureHost(memory);
    try {
      expect(await host.run('Which city did I mention?')).toMatchObject({
        detail: INTERNAL_FAULT.message,
        outcome: 'failed',
      });
      diagnostics.expectCause(`Memory ${step} failed`);
      diagnostics.expectCause(
        step === 'open'
          ? 'Observational memory requires resolved concrete observer and reflector models'
          : step === 'observe'
            ? 'Recorded observer failure'
            : 'Recorded embedder failure'
      );
      // The owner was released: the same thread admits and completes another run.
      expect(await host.run('Report completion.')).toMatchObject({ outcome: 'completed' });
      expect(fetch).not.toHaveBeenCalled();
    } finally {
      await host.close();
    }
  }
);
