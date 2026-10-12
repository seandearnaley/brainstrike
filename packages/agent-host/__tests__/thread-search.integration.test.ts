/**
 * Gap 10: lexical, semantic and title search over host threads through the
 * host's own derived state index, filtered by each thread's committed
 * selected path.
 */
import { randomUUID } from 'node:crypto';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RuntimeData } from '@brainstrike/agent/provider-runtime';
import { resolveScaledToolResultBudget } from '@brainstrike/agent/tool-runtime';
import { DEFAULT_PERMISSION_POLICIES } from '@brainstrike/assistant-contract';
import { StateStore } from '@brainstrike/state-store';
import { MockLanguageModelV4, simulateReadableStream } from 'ai/test';
import { expect, test } from 'vitest';
import { HostCore } from '../src/core.js';
import {
  createProductionHostPlatform,
  type ProductionHostRunConfiguration,
} from '../src/production-platform.js';
import {
  coverageHostSearchVectors,
  pendingHostSearchVectors,
  putHostSearchVectors,
  searchHostThreads,
} from '../src/thread-search.js';

const modelId = 'gpt-6-sol';
/** The caller's embedder identity, as the renderer's search embedder names its model. */
const profile = {
  dimensions: 3,
  distance: 'cosine',
  dtype: 'q8',
  modelId: 'host-search-proof',
  provider: 'local',
} as const;
const TOPICS = ['saffron', 'autumn', 'Crocus'];
/** One axis per topic, so cosine similarity names the nearest row exactly. */
const topic = (text: string): number[] => TOPICS.map((word) => (text.includes(word) ? 1 : 0));
const configuration: RuntimeData = { model: modelId, provider: 'openai' };
const usage = {
  inputTokens: { cacheRead: 0, cacheWrite: 0, noCache: 1, total: 1 },
  outputTokens: { reasoning: 0, text: 1, total: 1 },
};

/** A chat model whose one answer is `text`. */
function answering(text: string): MockLanguageModelV4 {
  return new MockLanguageModelV4({
    doStream: async () => ({
      stream: simulateReadableStream({
        chunkDelayInMs: null,
        chunks: [
          { type: 'stream-start' as const, warnings: [] },
          { id: 'text-1', type: 'text-start' as const },
          { delta: text, id: 'text-1', type: 'text-delta' as const },
          { id: 'text-1', type: 'text-end' as const },
          {
            finishReason: { raw: 'stop', unified: 'stop' as const },
            type: 'finish' as const,
            usage,
          },
        ],
        initialDelayInMs: null,
      }),
    }),
  });
}

test('host search finds content by words and by meaning on the selected path, and titles, never a sibling branch', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'bs-thread-search-')));
  const store = await StateStore.open(root, {
    memoryCalculatorModule: join(
      import.meta.dirname,
      '../dist/adapters/memory-storage-calculator.js'
    ),
  });
  const answers: string[] = [];
  const platform = await createProductionHostPlatform({
    close: async () => undefined,
    readConfiguration: async (): Promise<ProductionHostRunConfiguration> => ({
      configuration,
      durableConfiguration: { model: modelId, provider: 'openai' },
      maxSteps: 2,
      memory: {
        native: {
          options: {
            lastMessages: 4,
            observationalMemory: false,
            semanticRecall: false,
            workingMemory: { enabled: false },
          },
        },
        recordPrompt: async () => undefined,
        resourceId: 'thread-search-fixture',
      },
      providerRequestContext: { inputTokenLimit: 50_000, provider: 'openai' },
      resolvedToolResultBudget: resolveScaledToolResultBudget(20_000),
      tools: {},
      toolTimeoutMs: 10_000,
    }),
    readPermissionPolicy: () => ({ policies: DEFAULT_PERMISSION_POLICIES, yolo: false }),
    // Each admission answers with the next scripted text; titling reuses it.
    resolveModel: async () => answering(answers.shift() ?? 'A short reply'),
    resolveProviderAuth: async () => undefined,
    startup: { register: async () => undefined, signal: new AbortController().signal, store },
  });
  const core = await HostCore.open(store, platform, () => () => undefined);
  const finished = async (threadId: string, runId: string): Promise<void> => {
    await expect
      .poll(
        async () =>
          (await core.read(threadId, 0)).some(
            (row) => row.event.type === 'run.finished' && row.event.runId === runId
          ),
        { timeout: 30_000 }
      )
      .toBe(true);
  };
  const search = (query: string) =>
    searchHostThreads(core, platform.searchState, platform.searchStateVectors, { query });
  try {
    const { threadId: harvest } = await core.startThread({ commandId: randomUUID() });
    const promptId = randomUUID();
    answers.push('Saffron harvest happens in the autumn.');
    const first = await core.startRun({
      commandId: promptId,
      modelId: `openai::${modelId}`,
      prompt: 'When is the saffron harvest?',
      threadId: harvest,
    });
    await finished(harvest, first.runId);
    // The regenerated answer becomes the selected path; the first is a sibling.
    answers.push('Crocus threads are picked by hand.');
    const second = await core.regenerateRun({
      commandId: randomUUID(),
      modelId: `openai::${modelId}`,
      threadId: harvest,
      userMessageId: promptId,
    });
    await finished(harvest, second.runId);

    const { threadId: recipes } = await core.startThread({ commandId: randomUUID() });
    await core.updateThread({ commandId: randomUUID(), threadId: recipes, title: 'Saffron rice' });

    const saffron = await search('saffron');
    expect(saffron.messages).toEqual([
      expect.objectContaining({
        headline: expect.stringContaining('<mark>saffron</mark>'),
        messageId: promptId,
        role: 'user',
        rootThreadId: harvest,
        threadId: harvest,
      }),
    ]);
    expect(saffron.titles).toEqual([
      { similarity: expect.any(Number), threadId: recipes, title: 'Saffron rice' },
    ]);
    // The selected path's answer is found under its run's message id.
    expect((await search('crocus hand')).messages).toEqual([
      expect.objectContaining({ messageId: second.runId, role: 'assistant', threadId: harvest }),
    ]);
    // The sibling answer is indexed, and filtered: nothing on the path says autumn.
    expect((await search('autumn')).messages).toEqual([]);

    // The semantic arm: every row is the backlog, embedded once by the caller.
    const vectors = platform.searchStateVectors;
    const pending = await pendingHostSearchVectors(core, vectors, { limit: 64, profile });
    expect(pending.rows.map(({ text }) => text)).toEqual([
      'When is the saffron harvest?',
      'Saffron harvest happens in the autumn.',
      'Crocus threads are picked by hand.',
    ]);
    // The first row fails to embed: it is errored, out of the backlog, as legacy's is.
    const [failing, ...embeddable] = pending.rows;
    if (!failing) {
      throw new Error('Expected a backlog row');
    }
    expect(
      await putHostSearchVectors(vectors, {
        profile,
        rows: [
          {
            error: 'model unavailable',
            seq: failing.seq,
            sourceHash: failing.sourceHash,
            threadId: failing.threadId,
          },
        ],
      })
    ).toEqual({ failed: 1, stale: 0, stored: 0 });
    expect(await coverageHostSearchVectors(core, vectors, { profile })).toEqual({
      embedded: 0,
      errored: 1,
      rows: 3,
    });
    expect(
      (await pendingHostSearchVectors(core, vectors, { limit: 64, profile })).rows.map(
        ({ seq }) => seq
      )
    ).toEqual(embeddable.map(({ seq }) => seq));
    // A vector for every row stores them all and clears the failure.
    expect(
      await putHostSearchVectors(vectors, {
        profile,
        rows: pending.rows.map(({ seq, sourceHash, text, threadId }) => ({
          seq,
          sourceHash,
          threadId,
          vector: topic(text),
        })),
      })
    ).toEqual({ failed: 0, stale: 0, stored: 3 });
    expect(await coverageHostSearchVectors(core, vectors, { profile })).toEqual({
      embedded: 3,
      errored: 0,
      rows: 3,
    });
    expect((await pendingHostSearchVectors(core, vectors, { limit: 64, profile })).rows).toEqual(
      []
    );
    const meaning = async (vector: number[]) =>
      (
        await searchHostThreads(core, platform.searchState, vectors, {
          query: 'unmatched',
          semantic: { profile, threshold: 0.5, vector },
        })
      ).similar;
    // The nearest answer on the selected path, under its run's message id.
    expect(await meaning(topic('Crocus'))).toEqual([
      expect.objectContaining({
        headline: 'Crocus threads are picked by hand.',
        messageId: second.runId,
        role: 'assistant',
        rootThreadId: harvest,
        threadId: harvest,
      }),
    ]);
    // Only the sibling answer is near this vector, and it is filtered.
    expect(await meaning(topic('autumn'))).toEqual([]);
  } finally {
    await core.close();
    await platform.close();
    await store.close();
    await rm(root, { force: true, recursive: true });
  }
});
