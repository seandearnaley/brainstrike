import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import type { MastraDBMessage } from '@mastra/core/agent';
import type { InMemoryStore, MemoryStorage } from '@mastra/core/storage';
import { Memory } from '@mastra/memory';
import { ObservationalMemory, type ObservationalMemoryConfig } from '@mastra/memory/processors';
import type { wrapLanguageModel } from 'ai';
import { MockLanguageModelV4, simulateReadableStream } from 'ai/test';

const require = createRequire(import.meta.url);
const cjsMemory = require('@mastra/memory') as typeof import('@mastra/memory');
const cjsProcessors =
  require('@mastra/memory/processors') as typeof import('@mastra/memory/processors');
export const entrypoints = [
  { Engine: ObservationalMemory, label: 'ESM', Memory },
  { Engine: cjsProcessors.ObservationalMemory, label: 'CJS', Memory: cjsMemory.Memory },
] as const;
export type EngineOptions = Omit<ObservationalMemoryConfig, 'storage' | 'memory' | 'model'> & {
  model?: ReturnType<typeof wrapLanguageModel>;
};
type ModelCall = Parameters<MockLanguageModelV4['doStream']>[0];
type ModelResult = Awaited<ReturnType<MockLanguageModelV4['doStream']>>;
export interface Fixture {
  domain: MemoryStorage;
  engine: ObservationalMemory;
  memory: Memory | undefined;
  resourceId: string;
  storage: InMemoryStore;
  threadId: string;
}
export const releases: (() => void)[] = [];
export const fixtures: Fixture[] = [];

export function gate() {
  const value = Promise.withResolvers<void>();
  releases.push(() => value.resolve());
  return value;
}

export function watch<T>(promise: Promise<T>) {
  let settled = false;
  const result = promise.then(
    (value) => {
      settled = true;
      return { status: 'fulfilled' as const, value };
    },
    (reason: unknown) => {
      settled = true;
      return { reason, status: 'rejected' as const };
    }
  );
  return {
    result,
    get settled() {
      return settled;
    },
  };
}

// XML and SDK v4 payloads follow the shipped memory-persistence and scripted-model fixtures.
export function textStream(
  text = '<observations>\n- The user asked about Paris weather.\n</observations>',
  finishReason: { raw: string | undefined; unified: 'interrupted' | 'stop' } = {
    raw: 'stop',
    unified: 'stop',
  }
): ModelResult {
  return {
    stream: simulateReadableStream({
      chunkDelayInMs: null,
      chunks: [
        { type: 'stream-start', warnings: [] },
        { id: 'observation-text', type: 'text-start' },
        { delta: text, id: 'observation-text', type: 'text-delta' },
        { id: 'observation-text', type: 'text-end' },
        {
          finishReason,
          type: 'finish',
          usage: {
            inputTokens: { cacheRead: 0, cacheWrite: 0, noCache: 42, total: 42 },
            outputTokens: { reasoning: 0, text: 9, total: 9 },
          },
        },
      ],
      initialDelayInMs: null,
    }),
  };
}

export function model(
  call: (params: ModelCall) => Promise<ModelResult> = async () => textStream()
) {
  return new MockLanguageModelV4({ doStream: call });
}

export function abortingModel(
  started: ReturnType<typeof gate>,
  onSignal?: (signal: AbortSignal) => void
) {
  return model(async ({ abortSignal }) => {
    if (!abortSignal) {
      throw new Error('Expected the public request lifetime signal');
    }
    onSignal?.(abortSignal);
    started.resolve();
    return await new Promise<ModelResult>((_resolve, reject) => {
      abortSignal.addEventListener('abort', () => reject(abortSignal.reason), { once: true });
    });
  });
}

export function observeFixture(
  f: Fixture,
  options: Omit<Parameters<ObservationalMemory['observe']>[0], 'threadId' | 'resourceId'> = {}
) {
  return f.engine.observe({
    messages: [message(f)],
    ...options,
    resourceId: f.resourceId,
    threadId: f.threadId,
  });
}

type AsyncTrigger = Parameters<ObservationalMemory['triggerAsyncBuffering']>[0];
export function triggerFixture(
  f: Fixture,
  record: AsyncTrigger['record'],
  options: Partial<Omit<AsyncTrigger, 'record' | 'threadId' | 'resourceId'>> = {}
) {
  return f.engine.triggerAsyncBuffering({
    pendingTokens: 200,
    threshold: 1000,
    unbufferedPendingTokens: 200,
    unobservedMessages: [],
    ...options,
    record,
    resourceId: f.resourceId,
    threadId: f.threadId,
  });
}

export function message(
  fixture: Pick<Fixture, 'threadId' | 'resourceId'>,
  text = 'Paris weather. '.repeat(60)
): MastraDBMessage {
  return {
    content: { format: 2, parts: [{ text, type: 'text' }] },
    createdAt: new Date('2026-10-06T00:00:00Z'),
    id: randomUUID(),
    resourceId: fixture.resourceId,
    role: 'user',
    threadId: fixture.threadId,
  };
}
