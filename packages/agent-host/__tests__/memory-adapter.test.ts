import { randomUUID } from 'node:crypto';
import { setImmediate as nextTurn } from 'node:timers/promises';
import type { MastraDBMessage } from '@mastra/core/agent';
import { InMemoryStore } from '@mastra/core/storage';
import { Memory } from '@mastra/memory';
import { streamText, wrapLanguageModel } from 'ai';
import { MockLanguageModelV4, simulateReadableStream } from 'ai/test';
import { expect, test } from 'vitest';
import {
  HostMemory,
  type HostMemoryCapabilities,
  type HostMemoryIdentity,
} from '../src/adapters/memory.js';
import { scriptedModel } from './fixtures/scripted-model.js';

async function fixture(
  overrides: Partial<HostMemoryCapabilities> = {},
  options?: HostMemoryCapabilities['native']['options']
): Promise<{
  adapter: HostMemory;
  controller: AbortController;
  identity: HostMemoryIdentity;
  storage: InMemoryStore;
}> {
  const storage = new InMemoryStore({ id: randomUUID() });
  await storage.init();
  const domain = await storage.getStore('memory');
  if (!domain) {
    throw new Error('Public memory storage domain is absent');
  }
  const controller = new AbortController();
  const identity = {
    resourceId: randomUUID(),
    runId: randomUUID(),
    signal: controller.signal,
    threadId: randomUUID(),
  };
  const now = new Date('2026-10-06T00:00:00Z');
  await domain.saveThread({
    thread: {
      createdAt: now,
      id: identity.threadId,
      metadata: {},
      resourceId: identity.resourceId,
      title: 'Public memory fixture',
      updatedAt: now,
    },
  });
  const adapter = new HostMemory(identity, {
    joinNativeLifetime: async () => undefined,
    native: {
      options: options ?? {
        observationalMemory: false,
        semanticRecall: false,
        workingMemory: { enabled: true, scope: 'thread' },
      },
      storage,
    },
    recordObserverUsage: async () => undefined,
    recordPrompt: async () => undefined,
    ...overrides,
  });
  return { adapter, controller, identity, storage };
}

function message(identity: HostMemoryIdentity, role: 'assistant' | 'user'): MastraDBMessage {
  return {
    content: { format: 2, parts: [{ text: 'Runtime message fixture.', type: 'text' }] },
    createdAt: new Date(role === 'user' ? '2026-10-06T00:00:00Z' : '2026-10-06T00:00:01Z'),
    id: randomUUID(),
    resourceId: identity.resourceId,
    role,
    threadId: identity.threadId,
  };
}

test('public Memory preserves working memory and committed message IDs through recall', async () => {
  const f = await fixture();
  try {
    const user = message(f.identity, 'user');
    const assistant = message(f.identity, 'assistant');
    await f.adapter.commitStep([user]);
    await f.adapter.beginTurn([user]);
    await f.adapter.updateWorkingMemory('Runtime fixture working memory');
    await f.adapter.commitStep([assistant]);
    expect(await f.adapter.getWorkingMemory()).toBe('Runtime fixture working memory');
    const step = await f.adapter.prepareStep(0);
    expect(step.messages.map((item) => item.id)).toEqual([user.id, assistant.id]);
    expect(step.workingMemory).toBe('Runtime fixture working memory');
    const recalled = await f.adapter.recall({ resourceId: f.identity.resourceId });
    expect(recalled.messages.map((item) => item.id)).toEqual([user.id, assistant.id]);
  } finally {
    await f.adapter.close();
    await f.storage.close();
  }
});

test('adapter drives the public OM turn and foreground observation without vendor changes', async () => {
  const model = new MockLanguageModelV4({
    doStream: async () => ({
      stream: simulateReadableStream({
        chunkDelayInMs: null,
        chunks: [
          { type: 'stream-start', warnings: [] },
          { id: 'observation-text', type: 'text-start' },
          {
            delta: '<observations>\n- The user asked about Paris weather.\n</observations>',
            id: 'observation-text',
            type: 'text-delta',
          },
          { id: 'observation-text', type: 'text-end' },
          {
            finishReason: { raw: 'stop', unified: 'stop' },
            type: 'finish',
            usage: {
              inputTokens: { cacheRead: 0, cacheWrite: 0, noCache: 42, total: 42 },
              outputTokens: { reasoning: 0, text: 9, total: 9 },
            },
          },
        ],
        initialDelayInMs: null,
      }),
    }),
  });
  const f = await fixture(
    {},
    {
      observationalMemory: {
        model,
        observation: { bufferOnIdle: false, bufferTokens: false, messageTokens: 30 },
        reflection: { observationTokens: 50_000 },
      },
      semanticRecall: false,
    }
  );
  try {
    const user = message(f.identity, 'user');
    user.content.parts = [{ text: 'Paris weather. '.repeat(60), type: 'text' }];
    await f.adapter.commitStep([user]);
    await f.adapter.beginTurn([user]);
    const step = await f.adapter.prepareStep(0);
    expect(step.observation?.observed).toBe(true);
    expect(step.context.hasObservations).toBe(true);
    expect(step.context.omRecord?.activeObservations).toBeDefined();
    expect(model.doStreamCalls.length).toBeGreaterThan(0);
  } finally {
    await f.adapter.close();
    await f.storage.close();
  }
});

test('close fences admission and joins the explicit enclosing native lifetime', async () => {
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const f = await fixture({
    joinNativeLifetime: async () => {
      entered.resolve();
      await release.promise;
    },
  });
  try {
    let joined = false;
    const closing = f.adapter.close().then(() => {
      joined = true;
    });
    await entered.promise;
    await expect(f.adapter.getWorkingMemory()).rejects.toBeInstanceOf(Error);
    expect(joined).toBe(false);
    release.resolve();
    await closing;
    expect(joined).toBe(true);
    expect(f.adapter.close()).toBe(f.adapter.close());
  } finally {
    release.resolve();
    await f.adapter.close();
    await f.storage.close();
  }
});

test('final prompt receipt uses actual public SDK request and reported usage survives Stop', async () => {
  const promptReceipts: Parameters<HostMemoryCapabilities['recordPrompt']>[1][] = [];
  const usageReceipts: Parameters<HostMemoryCapabilities['recordObserverUsage']>[1][] = [];
  const provider = scriptedModel();
  const f = await fixture({
    recordObserverUsage: async (_identity, receipt) => {
      usageReceipts.push(receipt);
    },
    recordPrompt: async (_identity, request) => {
      promptReceipts.push(request);
    },
  });
  try {
    const result = streamText({
      maxRetries: 0,
      model: wrapLanguageModel({
        middleware: {
          specificationVersion: 'v4',
          wrapStream: async ({ doStream, params }) => {
            await f.adapter.recordPrompt(params);
            return doStream();
          },
        },
        model: provider,
      }),
      prompt: 'Runtime final prompt fixture',
      system: 'Host-composed system fixture',
    });
    await result.consumeStream();
    const usage = await result.usage;
    expect(promptReceipts).toHaveLength(1);
    expect(promptReceipts[0]).toEqual(provider.doStreamCalls[0]);
    f.controller.abort();
    await f.adapter.recordObserverUsage({ kind: 'observation', modelId: provider.modelId, usage });
    expect(usageReceipts).toEqual([{ kind: 'observation', modelId: provider.modelId, usage }]);
    expect(usage.inputTokens).toBe(1);
    expect(usage.outputTokens).toBe(1);
  } finally {
    await f.adapter.close();
    await f.storage.close();
  }
});

test('cleanup retains callback failure and joins an admitted sibling write', async () => {
  const writeEntered = Promise.withResolvers<void>();
  const releaseWrite = Promise.withResolvers<void>();
  const failure = new Error('Actual receipt callback failure');
  const f = await fixture({
    recordObserverUsage: async () => {
      writeEntered.resolve();
      await releaseWrite.promise;
    },
    recordPrompt: async () => {
      throw failure;
    },
  });
  try {
    const provider = scriptedModel();
    const result = streamText({ model: provider, prompt: 'Usage fixture' });
    await result.consumeStream();
    const write = f.adapter.recordObserverUsage({
      kind: 'reflection',
      modelId: provider.modelId,
      usage: await result.usage,
    });
    await writeEntered.promise;
    await expect(f.adapter.recordPrompt(provider.doStreamCalls[0]!)).rejects.toBe(failure);
    let joined = false;
    const closing = f.adapter.close().finally(() => {
      joined = true;
    });
    closing.catch(() => undefined);
    await nextTurn();
    expect(joined).toBe(false);
    releaseWrite.resolve();
    await write;
    await expect(closing).rejects.toMatchObject({ errors: [failure] });
  } finally {
    releaseWrite.resolve();
    await f.adapter.close().catch(() => undefined);
    await f.storage.close();
  }
});

test('unmodified Memory.settled loses a registered native job failure', async () => {
  const storage = new InMemoryStore({ id: randomUUID() });
  await storage.init();
  const memory = new Memory({
    options: { observationalMemory: { model: scriptedModel() } },
    storage,
  });
  try {
    const engine = await memory.omEngine;
    if (!engine) {
      throw new Error('Public observational memory engine is absent');
    }
    const nativeFailure = new Error('Registered native background failure');
    engine.trackBackgroundWork(Promise.reject(nativeFailure));
    await expect(memory.settled()).resolves.toBeUndefined();
  } finally {
    await memory.settled();
    await storage.close();
  }
});

test('unmodified Memory.settled can resolve while a registered native job remains held', async () => {
  const storage = new InMemoryStore({ id: randomUUID() });
  await storage.init();
  const memory = new Memory({
    options: { observationalMemory: { model: scriptedModel() } },
    storage,
  });
  const gates = Array.from({ length: 101 }, () => Promise.withResolvers<void>());
  const jobs: Promise<void>[] = [];
  try {
    const engine = await memory.omEngine;
    if (!engine) {
      throw new Error('Public observational memory engine is absent');
    }
    const register = (index: number): void => {
      const gate = gates[index];
      if (!gate) {
        throw new Error('Native generation gate is absent');
      }
      const job = gate.promise.then(() => {
        if (index < gates.length - 1) {
          register(index + 1);
        }
      });
      jobs.push(job);
      engine.trackBackgroundWork(job);
    };
    register(0);
    let nativeSettled = false;
    const settling = memory.settled().then(() => {
      nativeSettled = true;
    });
    // Let public Memory enter the engine join before releasing generation zero.
    await nextTurn();
    // Each actual native drain round admits the next job. The published
    // 100-round guard returns with the final registered job still gated.
    for (const gate of gates.slice(0, -1)) {
      gate.resolve();
      await nextTurn();
    }
    expect(jobs).toHaveLength(101);
    expect(nativeSettled).toBe(true);
    let finalJobJoined = false;
    jobs.at(-1)?.then(() => {
      finalJobJoined = true;
    });
    await nextTurn();
    expect(finalJobJoined).toBe(false);
    await settling;
  } finally {
    for (const gate of gates) {
      gate.resolve();
    }
    await Promise.allSettled(jobs);
    await memory.settled();
    await storage.close();
  }
});

test('enabled native OM rejects unresolved routing models before credential lookup', async () => {
  const storage = new InMemoryStore({ id: randomUUID() });
  const identity = {
    resourceId: randomUUID(),
    runId: randomUUID(),
    signal: new AbortController().signal,
    threadId: randomUUID(),
  };
  expect(
    () =>
      new HostMemory(identity, {
        joinNativeLifetime: async () => undefined,
        native: {
          options: { observationalMemory: { model: 'openai/unresolved-fixture' } },
          storage,
        },
        recordObserverUsage: async () => undefined,
        recordPrompt: async () => undefined,
      })
  ).toThrow(Error);
});
