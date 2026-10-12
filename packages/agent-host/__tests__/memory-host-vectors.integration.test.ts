import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { RuntimeData } from '@brainstrike/agent/provider-runtime';
import { resolveScaledToolResultBudget } from '@brainstrike/agent/tool-runtime';
import { DEFAULT_PERMISSION_POLICIES } from '@brainstrike/assistant-contract';
import { acquireProfileResetLease } from '@brainstrike/host-lease';
import type { VectorProfile } from '@brainstrike/indexer';
import { StateStore } from '@brainstrike/state-store';
import type { MastraEmbeddingModel } from '@mastra/core/vector';
import { MockLanguageModelV4, simulateReadableStream } from 'ai/test';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { attachAgentHost, type HostClient } from '../dist/client.js';
import { HOST_STATE_INDEX_FILE, openHostStateIndex } from '../dist/host-state-index.js';
import {
  createProductionHostPlatform,
  type ProductionHostRunConfiguration,
} from '../dist/production-platform.js';
import type { HostEvent } from '../dist/protocol.js';
import { type AgentHost, startAgentHost } from '../dist/runtime.js';
import { scriptedToolSequence } from '../dist/test-fixtures/scripted-model.js';

type NativeOptions = NonNullable<ProductionHostRunConfiguration['memory']['native']['options']>;

const modelId = 'gpt-6-sol';
const configuration: RuntimeData = { model: modelId, provider: 'openai' };
const resourceId = 'memory-host-vectors-fixture';
// A hosted-shaped profile; the host never calls a provider for it.
const profile: VectorProfile = {
  dimensions: 8,
  distance: 'cosine',
  modelId: 'fixture-embedder-8',
  provider: 'openai',
};

/** Paris-related text shares one direction; everything else another. */
function embedding(text: string): number[] {
  return Array.from({ length: profile.dimensions }, (_, index) =>
    index === (/Paris|city/u.test(text) ? 0 : 1) ? 1 : 0
  );
}

const fetch = vi.fn(async () => {
  throw new Error('Host memory vectors make no provider requests');
});
beforeEach(() => {
  fetch.mockClear();
  vi.stubGlobal('fetch', fetch);
});
afterEach(() => vi.unstubAllGlobals());

/** The production composition through the runtime, as desktop and CLI hosts start it. */
async function vectorHost(
  options: NativeOptions,
  models: MockLanguageModelV4[],
  existingRoot?: string
) {
  const root =
    existingRoot ?? (await realpath(await mkdtemp(join(tmpdir(), 'bs-memory-host-vectors-'))));
  const embedded: string[] = [];
  const embedder: Extract<MastraEmbeddingModel<string>, { specificationVersion: 'v3' }> = {
    doEmbed: async ({ values }) => {
      embedded.push(...values);
      return { embeddings: values.map(embedding), warnings: [] };
    },
    maxEmbeddingsPerCall: 16,
    modelId: profile.modelId,
    provider: 'fixture',
    specificationVersion: 'v3',
    supportsParallelCalls: false,
  };
  const host: AgentHost = await startAgentHost({ lifetime: 'persistent', root }, (startup) =>
    createProductionHostPlatform({
      close: async () => undefined,
      memoryResourceIds: [resourceId],
      readConfiguration: async (): Promise<ProductionHostRunConfiguration> => ({
        configuration,
        durableConfiguration: { model: modelId, provider: 'openai' },
        maxSteps: 2,
        memory: {
          native: { options },
          observerModelId: 'openai::gpt-4.1-mini',
          recordPrompt: async () => undefined,
          resourceId,
          vectors: { embedder, profile },
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
      resolveModel: async () => {
        const model = models.shift();
        if (!model) {
          throw new Error('The fixture has no scripted model for this run');
        }
        return model;
      },
      resolveProviderAuth: async () => undefined,
      startup,
    })
  );
  const client: HostClient = await attachAgentHost(host.record);
  const run = async (prompt: string, threadId?: string) => {
    const thread =
      threadId ?? (await client.request('thread/start', { commandId: randomUUID() })).threadId;
    const { runId } = await client.request('run/start', {
      commandId: randomUUID(),
      modelId: `openai::${modelId}`,
      prompt,
      threadId: thread,
    });
    let events: HostEvent[] = [];
    await expect
      .poll(
        async () => {
          events = (await client.request('thread/read', { fromSeq: 0, threadId: thread })).rows.map(
            (row) => row.event
          );
          return events.some((event) => event.type === 'run.finished' && event.runId === runId);
        },
        { timeout: 30_000 }
      )
      .toBe(true);
    return {
      finished: events.find(
        (event): event is Extract<HostEvent, { type: 'run.finished' }> =>
          event.type === 'run.finished' && event.runId === runId
      ),
      threadId: thread,
    };
  };
  const storedVectors = (
    table: 'state_message_vectors' | 'state_observation_vectors' = 'state_message_vectors'
  ): number => {
    const db = new DatabaseSync(join(root, HOST_STATE_INDEX_FILE), { readOnly: true });
    try {
      return Number(db.prepare(`SELECT count(*) AS count FROM ${table}`).get()?.['count']);
    } finally {
      db.close();
    }
  };
  const stop = async (): Promise<void> => {
    await client.close();
    await host.close();
  };
  return {
    client,
    close: async () => {
      await stop();
      await rm(root, { force: true, recursive: true });
    },
    embedded,
    root,
    run,
    stop,
    storedVectors,
  };
}

function prompt(model: MockLanguageModelV4): string {
  return JSON.stringify(model.doStreamCalls[0]?.prompt ?? []);
}

test('semantic recall writes vectors to the host state index and recalls them on another thread', async () => {
  const writer = scriptedToolSequence([]);
  const reader = scriptedToolSequence([]);
  const host = await vectorHost(
    {
      lastMessages: 1,
      observationalMemory: false,
      semanticRecall: { messageRange: 0, scope: 'resource', topK: 1 },
      workingMemory: { enabled: false },
    },
    [writer, reader]
  );
  try {
    expect((await host.run('The capital of France is Paris.')).finished?.outcome).toBe('completed');
    expect(host.storedVectors()).toBeGreaterThan(0);
    expect((await host.run('Which city did I mention?')).finished?.outcome).toBe('completed');
    // The recalled earlier turn from another thread reaches the provider request.
    expect(prompt(reader)).toContain('The capital of France is Paris.');
    expect(host.embedded).toContain('Which city did I mention?');
    expect(fetch).not.toHaveBeenCalled();
  } finally {
    await host.close();
  }
});

test('thread deletion erases that thread’s recall vectors from the host state index', async () => {
  const host = await vectorHost(
    {
      lastMessages: 1,
      observationalMemory: false,
      semanticRecall: { messageRange: 0, scope: 'resource', topK: 1 },
      workingMemory: { enabled: false },
    },
    [scriptedToolSequence([])]
  );
  try {
    const { threadId } = await host.run('The capital of France is Paris.');
    expect(host.storedVectors()).toBeGreaterThan(0);
    expect(await host.client.request('thread/delete', { threadId })).toEqual({
      deleted: true,
      threadIds: [threadId],
    });
    expect(host.storedVectors()).toBe(0);
  } finally {
    await host.close();
  }
});

test('vector observational retrieval indexes observations in the host state index and offers recall search', async () => {
  const observer = new MockLanguageModelV4({
    doStream: async () => ({
      stream: simulateReadableStream({
        chunkDelayInMs: null,
        chunks: [
          { type: 'stream-start', warnings: [] },
          { id: 'observation', type: 'text-start' },
          {
            delta:
              '<observations>\n- The user said the capital of France is Paris.\n</observations>',
            id: 'observation',
            type: 'text-delta',
          },
          { id: 'observation', type: 'text-end' },
          {
            finishReason: { raw: 'stop', unified: 'stop' },
            type: 'finish',
            usage: {
              inputTokens: { cacheRead: 0, cacheWrite: 0, noCache: 40, total: 40 },
              outputTokens: { reasoning: 0, text: 9, total: 9 },
            },
          },
        ],
        initialDelayInMs: null,
      }),
    }),
  });
  const model = scriptedToolSequence([]);
  const host = await vectorHost(
    {
      lastMessages: 4,
      observationalMemory: {
        model: observer,
        // The committed prompt alone crosses this threshold.
        observation: { bufferTokens: false, messageTokens: 5 },
        reflection: { observationTokens: 40_000 },
        retrieval: { scope: 'thread', vector: true },
        scope: 'thread',
      },
      semanticRecall: false,
      workingMemory: { enabled: false },
    },
    [model]
  );
  try {
    expect((await host.run('The capital of France is Paris.')).finished?.outcome).toBe('completed');
    const recall = model.doStreamCalls[0]?.tools?.find((tool) => tool.name === 'recall');
    expect(recall?.type === 'function' ? recall.description : undefined).toContain('mode="search"');
    expect(host.storedVectors('state_observation_vectors')).toBeGreaterThan(0);
  } finally {
    await host.close();
  }
});

test('a host state index opened before memory grants is rebuilt once from the state log', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'bs-host-index-rebuild-')));
  const store = await StateStore.open(root, {
    memoryCalculatorModule: join(
      import.meta.dirname,
      '../dist/adapters/memory-storage-calculator.js'
    ),
  });
  try {
    // The identity every existing host index has: no memory resource grants.
    await (await openHostStateIndex(root)).close();
    const granted = await openHostStateIndex(root, [resourceId]);
    try {
      expect(granted.rootId).toBe(root);
      // The rebuilt index authorizes the granted resource (an empty, valid query).
      await expect(
        granted.vectors.queryStateMessageVectors({
          limit: 1,
          profile,
          scope: { resourceId, rootId: root, threadId: 'absent-thread' },
          vector: embedding('Paris'),
        })
      ).rejects.toMatchObject({ code: 'thread-not-authorized' });
    } finally {
      await granted.close();
    }
    // The same grants reopen without another rebuild.
    await (await openHostStateIndex(root, [resourceId])).close();
  } finally {
    await store.close();
    await rm(root, { force: true, recursive: true });
  }
});

test('factory reset of the host root erases working memory, recall vectors and the derived index', async () => {
  const options: NativeOptions = {
    lastMessages: 1,
    observationalMemory: false,
    semanticRecall: { messageRange: 0, scope: 'resource', topK: 1 },
    workingMemory: { enabled: true, scope: 'resource', template: '# Fixture facts' },
  };
  const remembered = '# Fixture facts\n- Capital: Paris';
  const control = scriptedToolSequence([]);
  const first = await vectorHost(options, [
    scriptedToolSequence([{ input: { memory: remembered }, toolId: 'updateWorkingMemory' }]),
    control,
  ]);
  try {
    expect((await first.run('The capital of France is Paris.')).finished?.outcome).toBe(
      'completed'
    );
    expect(first.storedVectors()).toBeGreaterThan(0);
    // Control: before the reset, another thread receives both memories.
    expect((await first.run('Which city did I mention?')).finished?.outcome).toBe('completed');
    expect(prompt(control)).toContain('Capital: Paris');
    expect(prompt(control)).toContain('The capital of France is Paris.');
  } finally {
    await first.stop();
  }
  // The desktop factory reset clears the stopped host's root under its profile lease.
  const lease = await acquireProfileResetLease(first.root);
  await lease.clearRootContents();
  lease.release();
  for (const file of ['state.db', HOST_STATE_INDEX_FILE]) {
    expect(existsSync(join(first.root, file))).toBe(false);
  }
  const reader = scriptedToolSequence([]);
  const second = await vectorHost(options, [reader], first.root);
  try {
    expect((await second.run('Which city did I mention?')).finished?.outcome).toBe('completed');
    // Neither the working memory nor the recalled earlier turn survived the reset.
    expect(prompt(reader)).not.toContain('Capital: Paris');
    expect(prompt(reader)).not.toContain('The capital of France is Paris.');
  } finally {
    await second.close();
  }
});
