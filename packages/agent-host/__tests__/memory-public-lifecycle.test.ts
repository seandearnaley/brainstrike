import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { type MastraDBMessage, MessageList } from '@mastra/core/agent';
import { InMemoryStore, type MemoryStorage } from '@mastra/core/storage';
import { Memory } from '@mastra/memory';
import {
  Extractor,
  ObservationalMemory,
  type ObservationalMemoryConfig,
  TokenCounter,
} from '@mastra/memory/processors';
import { wrapLanguageModel } from 'ai';
import { MockLanguageModelV4, simulateReadableStream } from 'ai/test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

const require = createRequire(import.meta.url);
const cjsMemory = require('@mastra/memory') as typeof import('@mastra/memory');
const cjsProcessors =
  require('@mastra/memory/processors') as typeof import('@mastra/memory/processors');
const entrypoints = [
  { Engine: ObservationalMemory, label: 'ESM', Memory },
  { Engine: cjsProcessors.ObservationalMemory, label: 'CJS', Memory: cjsMemory.Memory },
] as const;
type EngineOptions = Omit<ObservationalMemoryConfig, 'storage' | 'memory' | 'model'> & {
  model?: ReturnType<typeof wrapLanguageModel>;
};
type ModelCall = Parameters<MockLanguageModelV4['doStream']>[0];
type ModelResult = Awaited<ReturnType<MockLanguageModelV4['doStream']>>;
interface Fixture {
  domain: MemoryStorage;
  engine: ObservationalMemory;
  memory: Memory | undefined;
  resourceId: string;
  storage: InMemoryStore;
  threadId: string;
}
const releases: (() => void)[] = [];
const fixtures: Fixture[] = [];

function gate() {
  const value = Promise.withResolvers<void>();
  releases.push(() => value.resolve());
  return value;
}

function watch<T>(promise: Promise<T>) {
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
function textStream(
  text = '<observations>\n- The user asked about Paris weather.\n</observations>'
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
  };
}

function model(call: (params: ModelCall) => Promise<ModelResult> = async () => textStream()) {
  return new MockLanguageModelV4({ doStream: call });
}

function abortingModel(started: ReturnType<typeof gate>, onSignal?: (signal: AbortSignal) => void) {
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

function observeFixture(
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
function triggerFixture(
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

function message(
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

afterEach(async () => {
  for (const release of releases.splice(0)) {
    release();
  }
  for (const fixture of fixtures.splice(0)) {
    await fixture.engine.settled().catch(() => undefined);
    await fixture.storage.close();
  }
  vi.useRealTimers();
});

describe.each(entrypoints)(
  '$label pinned public memory lifecycle',
  ({ Engine, Memory: MemoryCtor }) => {
    async function fixture(options: EngineOptions = {}, throughMemory = false): Promise<Fixture> {
      const storage = new InMemoryStore({ id: randomUUID() });
      await storage.init();
      const domain = await storage.getStore('memory');
      if (!domain) {
        throw new Error('Public in-memory storage has no memory domain');
      }
      const resourceId = randomUUID();
      const threadId = randomUUID();
      await domain.saveThread({
        thread: {
          createdAt: new Date('2026-10-06T00:00:00Z'),
          id: threadId,
          metadata: {},
          resourceId,
          title: 'Public lifecycle fixture',
          updatedAt: new Date('2026-10-06T00:00:00Z'),
        },
      });
      const config: EngineOptions = { ...options };
      config.model ??= model();
      config.observation ??= { bufferTokens: false, messageTokens: 10 };
      config.reflection ??= { observationTokens: 10_000 };
      const memory = throughMemory
        ? new MemoryCtor({
            options: {
              generateTitle: false,
              observationalMemory: config,
              workingMemory: { enabled: false },
            },
            storage,
          })
        : undefined;
      const engine = memory ? await memory.omEngine : new Engine({ ...config, storage: domain });
      if (!engine) {
        throw new Error('Public Memory did not construct its OM engine');
      }
      const result = { domain, engine, memory, resourceId, storage, threadId };
      fixtures.push(result);
      return result;
    }

    async function resourceFixture(options: EngineOptions) {
      const tokenCount = await new TokenCounter().countMessagesAsync([
        message({ resourceId: 'resource-fixture', threadId: 'thread-fixture' }),
      ]);
      const threshold = tokenCount + 1;
      const f = await fixture({
        ...options,
        observation: { bufferTokens: false, maxTokensPerBatch: 1, messageTokens: threshold },
        scope: 'resource',
      });
      const secondThreadId = randomUUID();
      await f.domain.saveThread({
        thread: {
          createdAt: new Date('2026-10-06T00:00:00Z'),
          id: secondThreadId,
          metadata: {},
          resourceId: f.resourceId,
          title: 'Second resource thread',
          updatedAt: new Date('2026-10-06T00:00:00Z'),
        },
      });
      const firstMessage = message(f);
      const secondMessage = message({ resourceId: f.resourceId, threadId: secondThreadId });
      await f.domain.saveMessages({ messages: [firstMessage, secondMessage] });
      const record = await f.engine.getOrCreateRecord(f.threadId, f.resourceId);
      // Native pending tokens represent messages accumulated before this call.
      await f.domain.setPendingMessageTokens(record.id, threshold);
      return { ...f, firstMessage, secondThreadId };
    }

    it('joins the launched observation read and orders final clear after the initial flag write', async () => {
      const f = await fixture({ observation: { bufferTokens: 100, messageTokens: 1000 } });
      const record = await f.engine.getOrCreateRecord(f.threadId, f.resourceId);
      const readStarted = gate();
      const read = gate();
      const initial = gate();
      const finalStarted = gate();
      const final = gate();
      const originalFlag = f.domain.setBufferingObservationFlag.bind(f.domain);
      const writes: boolean[] = [];
      f.domain.getObservationalMemory = async () => {
        readStarted.resolve();
        await read.promise;
        return null;
      };
      f.domain.setBufferingObservationFlag = async (id, value, tokens) => {
        writes.push(value);
        if (value) {
          await initial.promise;
        } else {
          finalStarted.resolve();
          await final.promise;
        }
        await originalFlag(id, value, tokens);
      };
      expect(await triggerFixture(f, record)).toBe(true);
      await readStarted.promise;
      const joined = watch(f.engine.settled());
      read.resolve();
      await nextTurn();
      expect(joined.settled).toBe(false);
      expect(writes).toEqual([true]);
      initial.resolve();
      await finalStarted.promise;
      expect(joined.settled).toBe(false);
      expect(await triggerFixture(f, record)).toBe(false);
      final.resolve();
      expect((await joined.result).status).toBe('fulfilled');
      expect(writes).toEqual([true, false]);
    });

    it('joins an independent held read and final clear before surfacing an initial flag failure', async () => {
      const f = await fixture({ observation: { bufferTokens: 100, messageTokens: 1000 } });
      const record = await f.engine.getOrCreateRecord(f.threadId, f.resourceId);
      const readStarted = gate();
      const read = gate();
      const finalStarted = gate();
      const final = gate();
      const failure = new Error('initial flag storage failure');
      f.domain.getObservationalMemory = async () => {
        readStarted.resolve();
        await read.promise;
        return null;
      };
      f.domain.setBufferingObservationFlag = async (_id, value) => {
        if (value) {
          throw failure;
        }
        finalStarted.resolve();
        await final.promise;
      };
      await triggerFixture(f, record);
      await readStarted.promise;
      const joined = watch(f.engine.settled());
      await nextTurn();
      expect(joined.settled).toBe(false);
      read.resolve();
      await finalStarted.promise;
      expect(joined.settled).toBe(false);
      final.resolve();
      expect(await joined.result).toEqual({ reason: failure, status: 'rejected' });
    });

    it.each([false, true])(
      'joins stale clearing and fences call cancellation=%s',
      async (cancel) => {
        const call = new AbortController();
        const reason = new DOMException('Stop during stale clearing', 'AbortError');
        const f = await fixture({ observation: { bufferTokens: 100, messageTokens: 1000 } });
        const record = await f.engine.getOrCreateRecord(f.threadId, f.resourceId);
        await f.domain.setBufferingObservationFlag(record.id, true);
        const staleStarted = gate();
        const stale = gate();
        const writes: boolean[] = [];
        const original = f.domain.setBufferingObservationFlag.bind(f.domain);
        f.domain.setBufferingObservationFlag = async (id, value, tokens) => {
          writes.push(value);
          if (writes.length === 1) {
            staleStarted.resolve();
            await stale.promise;
          }
          await original(id, value, tokens);
        };
        f.domain.getObservationalMemory = async () => null;
        const trigger = watch(
          triggerFixture(
            f,
            { ...record, isBufferingObservation: true },
            { abortSignal: call.signal }
          )
        );
        await staleStarted.promise;
        const joined = watch(f.engine.settled());
        await nextTurn();
        expect(trigger.settled).toBe(false);
        expect(joined.settled).toBe(false);
        expect(writes).toEqual([false]);
        if (cancel) {
          call.abort(reason);
        }
        stale.resolve();
        expect(await trigger.result).toMatchObject(
          cancel ? { reason, status: 'rejected' } : { status: 'fulfilled' }
        );
        expect((await joined.result).status).toBe('fulfilled');
        expect(writes).toEqual(cancel ? [false] : [false, true, false]);
      }
    );

    it('keeps a status read from launching a competing stale flag write', async () => {
      const f = await fixture({ observation: { bufferTokens: 100, messageTokens: 1000 } });
      const record = await f.engine.getOrCreateRecord(f.threadId, f.resourceId);
      await f.domain.setBufferingObservationFlag(record.id, true);
      const writes: boolean[] = [];
      const original = f.domain.setBufferingObservationFlag.bind(f.domain);
      f.domain.setBufferingObservationFlag = async (id, value, tokens) => {
        writes.push(value);
        await original(id, value, tokens);
      };
      const status = await f.engine.getStatus({
        messages: [message(f)],
        record: { ...record, isBufferingObservation: true },
        resourceId: f.resourceId,
        threadId: f.threadId,
      });
      expect(status.shouldBuffer).toBe(true);
      expect(writes).toEqual([]);
      await f.engine.triggerAsyncBuffering({
        pendingTokens: status.pendingTokens,
        record: status.record,
        resourceId: f.resourceId,
        threadId: f.threadId,
        threshold: status.threshold,
        unbufferedPendingTokens: status.unbufferedPendingTokens,
        unobservedMessages: [],
      });
      await f.engine.settled();
      expect(writes).toEqual([false, true, false]);
    });

    it.each(['non-blocking', 'await'] as const)(
      'joins hook-child writes while preserving %s hook scheduling',
      async (hookExecution) => {
        const hookStarted = gate();
        const hook = gate();
        const childStarted = gate();
        const child = gate();
        let accountingWrites = 0;
        const f = await fixture({
          hookExecution,
          hooks: {
            onObservationEnd: async () => {
              hookStarted.resolve();
              await hook.promise;
              childStarted.resolve();
              await child.promise;
              accountingWrites++;
            },
          },
        });
        const observation = watch(
          f.engine.observe({
            messages: [message(f)],
            resourceId: f.resourceId,
            threadId: f.threadId,
          })
        );
        await hookStarted.promise;
        await nextTurn();
        expect(observation.settled).toBe(hookExecution === 'non-blocking');
        const joined = watch(f.engine.settled());
        hook.resolve();
        await childStarted.promise;
        await nextTurn();
        expect(joined.settled).toBe(false);
        expect(accountingWrites).toBe(0);
        child.resolve();
        expect((await joined.result).status).toBe('fulfilled');
        expect((await observation.result).status).toBe('fulfilled');
        expect(accountingWrites).toBe(1);
      }
    );

    it('preserves a detached hook rejection as an owner-visible accounting failure', async () => {
      const hookStarted = gate();
      const hook = gate();
      const failure = new Error('accounting write rejected');
      const f = await fixture({
        hooks: {
          onObservationEnd: async () => {
            hookStarted.resolve();
            await hook.promise;
            throw failure;
          },
        },
      });
      const result = observeFixture(f);
      await hookStarted.promise;
      await result;
      const joined = watch(f.engine.settled());
      await nextTurn();
      expect(joined.settled).toBe(false);
      hook.resolve();
      expect(await joined.result).toEqual({ reason: failure, status: 'rejected' });
    });

    it('retains the cycle failure and joins an independently failing end hook before settlement rejects', async () => {
      const hookStarted = gate();
      const hook = gate();
      const cycleFailure = new Error('observation request rejected');
      const hookFailure = new Error('end accounting rejected');
      const f = await fixture({
        model: model(async () => {
          throw cycleFailure;
        }),
      });
      const observation = watch(
        f.engine.observe({
          hooks: {
            onObservationEnd: async () => {
              hookStarted.resolve();
              await hook.promise;
              throw hookFailure;
            },
          },
          messages: [message(f)],
          resourceId: f.resourceId,
          threadId: f.threadId,
        })
      );
      await hookStarted.promise;
      const joined = watch(f.engine.settled());
      await nextTurn();
      expect(joined.settled).toBe(false);
      hook.resolve();
      expect(await observation.result).toEqual({ reason: cycleFailure, status: 'rejected' });
      const result = await joined.result;
      expect(result.status).toBe('rejected');
      if (result.status !== 'rejected') {
        throw new Error('Expected retained failures');
      }
      expect(result.reason).toBeInstanceOf(AggregateError);
      if (!(result.reason instanceof AggregateError)) {
        throw new Error('Expected aggregate failure');
      }
      expect(result.reason.errors).toEqual([cycleFailure, hookFailure]);
    });

    it('owns async reflection, its end hook, and its final flag clear after public prepare returns', async () => {
      const providerStarted = gate();
      const provider = gate();
      const initial = gate();
      const endHookStarted = gate();
      const endHook = gate();
      const finalStarted = gate();
      const final = gate();
      const f = await fixture({
        hooks: {
          onReflectionEnd: async () => {
            endHookStarted.resolve();
            await endHook.promise;
          },
        },
        model: model(async () => {
          providerStarted.resolve();
          await provider.promise;
          return textStream();
        }),
        observation: { bufferTokens: 100, messageTokens: 1000 },
        reflection: { bufferActivation: 0.5, observationTokens: 100 },
      });
      const record = await f.engine.getOrCreateRecord(f.threadId, f.resourceId);
      await f.domain.updateActiveObservations({
        id: record.id,
        lastObservedAt: new Date('2026-10-06T00:00:00Z'),
        observations: '- The user is planning a Paris trip. '.repeat(10),
        tokenCount: 80,
      });
      const original = f.domain.setBufferingReflectionFlag.bind(f.domain);
      const writes: boolean[] = [];
      f.domain.setBufferingReflectionFlag = async (id, value) => {
        writes.push(value);
        if (value) {
          await initial.promise;
        } else {
          finalStarted.resolve();
          await final.promise;
        }
        await original(id, value);
      };
      const turn = f.engine.beginTurn({
        messageList: new MessageList({ resourceId: f.resourceId, threadId: f.threadId }),
        resourceId: f.resourceId,
        threadId: f.threadId,
      });
      await turn.start();
      await turn.step(0).prepare();
      await providerStarted.promise;
      const joined = watch(f.engine.settled());
      provider.resolve();
      await endHookStarted.promise;
      await nextTurn();
      expect(joined.settled).toBe(false);
      endHook.resolve();
      await nextTurn();
      expect(writes).toEqual([true]);
      initial.resolve();
      await finalStarted.promise;
      expect(joined.settled).toBe(false);
      final.resolve();
      expect((await joined.result).status).toBe('fulfilled');
      await turn.end();
      expect(
        (await f.domain.getObservationalMemory(f.threadId, f.resourceId))?.isBufferingReflection
      ).toBe(false);
    });

    it('forwards a narrower turn signal to async reflection and completes cleanup after cancellation', async () => {
      const owner = new AbortController();
      releases.push(() => owner.abort(new DOMException('Fixture cleanup', 'AbortError')));
      const call = new AbortController();
      const started = gate();
      const finalStarted = gate();
      const final = gate();
      let received: AbortSignal | undefined;
      const f = await fixture({
        abortSignal: owner.signal,
        model: abortingModel(started, (signal) => {
          received = signal;
        }),
        observation: { bufferTokens: 100, messageTokens: 1000 },
        reflection: { bufferActivation: 0.5, observationTokens: 100 },
      });
      const record = await f.engine.getOrCreateRecord(f.threadId, f.resourceId);
      await f.domain.updateActiveObservations({
        id: record.id,
        lastObservedAt: new Date('2026-10-06T00:00:00Z'),
        observations: '- The user is planning a Paris trip. '.repeat(10),
        tokenCount: 80,
      });
      const original = f.domain.setBufferingReflectionFlag.bind(f.domain);
      f.domain.setBufferingReflectionFlag = async (id, value) => {
        if (!value) {
          finalStarted.resolve();
          await final.promise;
        }
        await original(id, value);
      };
      const turn = f.engine.beginTurn({
        abortSignal: call.signal,
        messageList: new MessageList({ resourceId: f.resourceId, threadId: f.threadId }),
        resourceId: f.resourceId,
        threadId: f.threadId,
      });
      await turn.start();
      await turn.step(0).prepare();
      await started.promise;
      const reason = new DOMException('Stop async reflection turn', 'AbortError');
      call.abort(reason);
      const joined = watch(f.engine.settled());
      await finalStarted.promise;
      expect(received?.reason).toBe(reason);
      expect(owner.signal.aborted).toBe(false);
      expect(joined.settled).toBe(false);
      final.resolve();
      expect((await joined.result).status).toBe('fulfilled');
      await turn.end();
      expect(
        (await f.domain.getObservationalMemory(f.threadId, f.resourceId))?.isBufferingReflection
      ).toBe(false);
    });

    it('joins the remaining observation-group indexing branch before returning the first failure', async () => {
      const siblingStarted = gate();
      const sibling = gate();
      const failure = new Error('index branch rejected');
      const vectorWrites: string[] = [];
      const grouped =
        '<observations>\n<observation-group id="first" range="a:b">Paris weather.</observation-group>\n<observation-group id="second" range="c:d">Paris travel.</observation-group>\n</observations>';
      const f = await fixture({
        model: model(async () => textStream(grouped)),
        onIndexObservations: async ({ groupId }) => {
          if (groupId === 'first') {
            throw failure;
          }
          siblingStarted.resolve();
          await sibling.promise;
          vectorWrites.push(groupId);
        },
        retrieval: true,
      });
      const observation = watch(observeFixture(f));
      await siblingStarted.promise;
      const joined = watch(f.engine.settled());
      await nextTurn();
      expect(observation.settled).toBe(false);
      expect(joined.settled).toBe(false);
      expect(vectorWrites).toEqual([]);
      sibling.resolve();
      expect(await observation.result).toEqual({ reason: failure, status: 'rejected' });
      expect(await joined.result).toEqual({ reason: failure, status: 'rejected' });
      expect(vectorWrites).toEqual(['second']);
    });

    it('joins a held resource observation batch before returning a sibling provider failure', async () => {
      const siblingStarted = gate();
      const sibling = gate();
      const failure = new Error('resource batch rejected');
      let attempts = 0;
      let lateTails = 0;
      const f = await resourceFixture({
        model: model(async () => {
          attempts++;
          if (attempts === 1) {
            throw failure;
          }
          siblingStarted.resolve();
          await sibling.promise;
          lateTails++;
          return textStream();
        }),
      });
      const observation = watch(observeFixture(f, { messages: [f.firstMessage] }));
      await siblingStarted.promise;
      const joined = watch(f.engine.settled());
      await nextTurn();
      expect(observation.settled).toBe(false);
      expect(joined.settled).toBe(false);
      expect(lateTails).toBe(0);
      sibling.resolve();
      expect(await observation.result).toEqual({ reason: failure, status: 'rejected' });
      expect(await joined.result).toEqual({ reason: failure, status: 'rejected' });
      expect(attempts).toBe(2);
      expect(lateTails).toBe(1);
    });

    it('joins resource-thread indexing branches through their actual late callback write', async () => {
      const siblingStarted = gate();
      const sibling = gate();
      const failure = new Error('resource index rejected');
      const vectorWrites: string[] = [];
      const f = await resourceFixture({
        model: model(async () =>
          textStream(
            `<observations>\n<thread id="${f.threadId}"><observation-group id="first" range="a:b">Paris weather.</observation-group></thread>\n<thread id="${f.secondThreadId}"><observation-group id="second" range="c:d">Paris travel.</observation-group></thread>\n</observations>`
          )
        ),
        onIndexObservations: async ({ groupId }) => {
          if (groupId === 'first') {
            throw failure;
          }
          siblingStarted.resolve();
          await sibling.promise;
          vectorWrites.push(groupId);
        },
        retrieval: true,
      });
      const observation = watch(observeFixture(f, { messages: [f.firstMessage] }));
      await siblingStarted.promise;
      const joined = watch(f.engine.settled());
      await nextTurn();
      expect(observation.settled).toBe(false);
      expect(joined.settled).toBe(false);
      expect(vectorWrites).toEqual([]);
      sibling.resolve();
      expect(await observation.result).toEqual({ reason: failure, status: 'rejected' });
      expect(await joined.result).toEqual({ reason: failure, status: 'rejected' });
      expect(vectorWrites).toEqual(['second']);
    });

    it('propagates the Memory constructor owner signal to an active request and joins expected cancellation', async () => {
      const owner = new AbortController();
      const started = gate();
      let received: AbortSignal | undefined;
      const f = await fixture(
        {
          abortSignal: owner.signal,
          model: abortingModel(started, (signal) => {
            received = signal;
          }),
        },
        true
      );
      const observation = watch(observeFixture(f));
      await started.promise;
      const reason = new DOMException('Owner Stop', 'AbortError');
      owner.abort(reason);
      expect(received?.aborted).toBe(true);
      expect(received?.reason).toBe(reason);
      expect(await observation.result).toEqual({ reason, status: 'rejected' });
      await f.engine.settled();
    });

    it('composes a narrower call signal with the owner signal', async () => {
      const owner = new AbortController();
      const call = new AbortController();
      const started = gate();
      let received: AbortSignal | undefined;
      const f = await fixture({
        abortSignal: owner.signal,
        model: abortingModel(started, (signal) => {
          received = signal;
        }),
      });
      const observation = watch(observeFixture(f, { abortSignal: call.signal }));
      await started.promise;
      const reason = new DOMException('Call Stop', 'AbortError');
      call.abort(reason);
      expect(received?.reason).toBe(reason);
      expect(owner.signal.aborted).toBe(false);
      expect(await observation.result).toEqual({ reason, status: 'rejected' });
      await f.engine.settled();
    });

    it('joins a caller-registered abort-ignoring provider promise through its actual late tail', async () => {
      const owner = new AbortController();
      const started = gate();
      const provider = gate();
      let received: AbortSignal | undefined;
      let lateWrites = 0;
      const providerModel = model(async ({ abortSignal }) => {
        received = abortSignal;
        started.resolve();
        await provider.promise;
        lateWrites++;
        return textStream();
      });
      // The host wrapper must register the actual leaf; native output can finish before it.
      const wrapped = wrapLanguageModel({
        middleware: {
          specificationVersion: 'v4',
          wrapStream: ({ doStream, params }) =>
            f.engine.trackBackgroundWork(Promise.resolve(doStream()), params.abortSignal),
        },
        model: providerModel,
      });
      const f = await fixture({ abortSignal: owner.signal, model: wrapped });
      const observation = watch(observeFixture(f));
      await started.promise;
      const reason = new DOMException('Stop while provider ignores abort', 'AbortError');
      owner.abort(reason);
      const joined = watch(f.engine.settled());
      await nextTurn();
      expect(received?.aborted).toBe(true);
      expect(joined.settled).toBe(false);
      expect(lateWrites).toBe(0);
      provider.resolve();
      expect(await observation.result).toEqual({ reason, status: 'rejected' });
      expect((await joined.result).status).toBe('fulfilled');
      expect(lateWrites).toBe(1);
    });

    it('cancels an existing retry backoff without dispatching another provider attempt', async () => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      const owner = new AbortController();
      const attemptStarted = gate();
      let attempts = 0;
      const f = await fixture({
        abortSignal: owner.signal,
        model: model(async () => {
          attempts++;
          attemptStarted.resolve();
          throw new Error('fetch failed');
        }),
      });
      const observation = watch(observeFixture(f));
      await attemptStarted.promise;
      await nextTurn();
      expect(vi.getTimerCount()).toBeGreaterThan(0);
      const reason = new DOMException('Stop during existing backoff', 'AbortError');
      owner.abort(reason);
      expect(await observation.result).toEqual({ reason, status: 'rejected' });
      await f.engine.settled();
      await vi.advanceTimersByTimeAsync(5000);
      expect(attempts).toBe(1);
    });

    it('retains an abort-ignoring extraction hook until it finishes and prevents its result from being persisted', async () => {
      const owner = new AbortController();
      const extractionStarted = gate();
      const extraction = gate();
      let received: AbortSignal | undefined;
      const f = await fixture({
        abortSignal: owner.signal,
        observation: {
          bufferTokens: false,
          extract: [
            new Extractor({
              mode: 'hook',
              name: 'Held extraction',
              onExtracted: async ({ abortSignal }) => {
                received = abortSignal;
                extractionStarted.resolve();
                await extraction.promise;
              },
            }),
          ],
          messageTokens: 10,
        },
      });
      const observation = watch(observeFixture(f));
      await extractionStarted.promise;
      const reason = new DOMException('Stop during extraction', 'AbortError');
      owner.abort(reason);
      const joined = watch(f.engine.settled());
      await nextTurn();
      expect(received?.aborted).toBe(true);
      expect(observation.settled).toBe(false);
      expect(joined.settled).toBe(false);
      extraction.resolve();
      expect(await observation.result).toEqual({ reason, status: 'rejected' });
      expect((await joined.result).status).toBe('fulfilled');
      expect(
        (await f.domain.getObservationalMemory(f.threadId, f.resourceId))?.activeObservations
      ).toBe('');
    });

    it('keeps a cleanup write failure distinct from expected provider cancellation', async () => {
      const owner = new AbortController();
      const started = gate();
      const cleanupFailure = new Error('final observation flag clear failed');
      const f = await fixture({
        abortSignal: owner.signal,
        model: abortingModel(started),
        observation: { bufferTokens: 100, messageTokens: 1000 },
      });
      const record = await f.engine.getOrCreateRecord(f.threadId, f.resourceId);
      const original = f.domain.setBufferingObservationFlag.bind(f.domain);
      f.domain.setBufferingObservationFlag = async (id, value, tokens) => {
        if (!value) {
          throw cleanupFailure;
        }
        await original(id, value, tokens);
      };
      await triggerFixture(f, record, { unobservedMessages: [message(f)] });
      await started.promise;
      owner.abort(new DOMException('Expected provider cancellation', 'AbortError'));
      await expect(f.engine.settled()).rejects.toBe(cleanupFailure);
    });

    it('rejects the existing 100-wave guard without forgetting still-owned work', async () => {
      const f = await fixture();
      const waves = Array.from({ length: 102 }, () => gate());
      function launch(index: number): Promise<void> {
        const wave = waves[index];
        if (!wave) {
          throw new Error('Missing bounded fixture wave');
        }
        return wave.promise.then(() => {
          if (index + 1 < waves.length) {
            f.engine.trackBackgroundWork(launch(index + 1));
          }
        });
      }
      f.engine.trackBackgroundWork(launch(0));
      const joined = watch(f.engine.settled());
      for (const wave of waves.slice(0, 100)) {
        wave.resolve();
        await nextTurn();
      }
      const first = await joined.result;
      expect(first.status).toBe('rejected');
      if (first.status !== 'rejected') {
        throw new Error('Expected incomplete settlement');
      }
      expect(first.reason).toMatchObject({ name: 'ObservationalMemoryIncompleteSettlementError' });
      const retained = watch(f.engine.settled());
      await nextTurn();
      expect(retained.settled).toBe(false);
      for (const wave of waves.slice(100)) {
        wave.resolve();
        await nextTurn();
      }
      expect((await retained.result).status).toBe('fulfilled');
    });

    it('preserves an uncancelled public turn round trip and admits a fresh next-run owner signal', async () => {
      const stopped = new AbortController();
      stopped.abort(new DOMException('Previous run stopped', 'AbortError'));
      const old = await fixture({ abortSignal: stopped.signal }, true);
      await expect(
        old.engine.observe({
          messages: [message(old)],
          resourceId: old.resourceId,
          threadId: old.threadId,
        })
      ).rejects.toBe(stopped.signal.reason);
      await old.engine.settled();
      const owner = new AbortController();
      const f = await fixture({ abortSignal: owner.signal }, true);
      if (!f.memory) {
        throw new Error('Missing native Memory');
      }
      const messages = new MessageList({ resourceId: f.resourceId, threadId: f.threadId });
      messages.add([message(f)], 'input');
      const turn = f.engine.beginTurn({
        messageList: messages,
        resourceId: f.resourceId,
        threadId: f.threadId,
      });
      const context = await turn.start(f.memory);
      expect(context.record.threadId).toBe(f.threadId);
      const prepared = await turn.step(0).prepare();
      expect(prepared.observed).toBe(true);
      await turn.end();
      await f.memory.settled();
      const persisted = await f.domain.getObservationalMemory(f.threadId, f.resourceId);
      expect(persisted?.activeObservations).toContain('Paris');
      expect(owner.signal.aborted).toBe(false);
      expect(JSON.stringify(turn)).not.toContain('abortSignal');
    });

    it('forwards the runtime signal to structured extractor configuration', async () => {
      const owner = new AbortController();
      const settingsStarted = gate();
      const settings = gate();
      let received: AbortSignal | undefined;
      const f = await fixture({
        abortSignal: owner.signal,
        observation: {
          bufferTokens: false,
          extract: [
            new Extractor({
              instructions: 'Extract the place named by the user.',
              name: 'Configured place',
              schema: async ({ abortSignal }) => {
                received = abortSignal;
                settingsStarted.resolve();
                await settings.promise;
                return z.string();
              },
            }),
          ],
          messageTokens: 10,
        },
      });
      const observation = watch(observeFixture(f));
      await settingsStarted.promise;
      const reason = new DOMException('Stop while resolving extraction settings', 'AbortError');
      owner.abort(reason);
      const joined = watch(f.engine.settled());
      await nextTurn();
      expect(received?.aborted).toBe(true);
      expect(joined.settled).toBe(false);
      settings.resolve();
      expect(await observation.result).toEqual({ reason, status: 'rejected' });
      expect((await joined.result).status).toBe('fulfilled');
    });
  }
);
