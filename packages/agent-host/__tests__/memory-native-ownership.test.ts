import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { type MastraDBMessage, MessageList } from '@mastra/core/agent';
import { InMemoryStore, type MemoryStorage } from '@mastra/core/storage';
import { ObservationalMemory, type ObservationalMemoryConfig } from '@mastra/memory/processors';
import { MockLanguageModelV4, simulateReadableStream } from 'ai/test';
import { afterEach, describe, expect, it, vi } from 'vitest';

// Owner cases for the patched Memory 1.38 lifecycle hunks that the public
// lifecycle suite does not already pin (patches/@mastra__memory@1.38.0.patch).
// Each one fails with its hunk reverted to the upstream 1.38.0 text.

const require = createRequire(import.meta.url);
const cjsProcessors =
  require('@mastra/memory/processors') as typeof import('@mastra/memory/processors');
const entrypoints = [
  { Engine: ObservationalMemory, label: 'ESM' },
  { Engine: cjsProcessors.ObservationalMemory, label: 'CJS' },
] as const;
const releases: (() => void)[] = [];
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const release of releases.splice(0)) {
    release();
  }
  for (const step of cleanup.splice(0).reverse()) {
    await step();
  }
});

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

function reflectionModel() {
  return new MockLanguageModelV4({
    doStream: async () => ({
      stream: simulateReadableStream({
        chunkDelayInMs: null,
        chunks: [
          { type: 'stream-start', warnings: [] },
          { id: 'text', type: 'text-start' },
          {
            delta: '<observations>\n- The user is planning a Paris trip.\n</observations>',
            id: 'text',
            type: 'text-delta',
          },
          { id: 'text', type: 'text-end' },
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
}

describe.each(entrypoints)('$label patched native ownership', ({ Engine }) => {
  async function fixture(options: Omit<ObservationalMemoryConfig, 'storage' | 'memory'>) {
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
        title: 'Native ownership fixture',
        updatedAt: new Date('2026-10-06T00:00:00Z'),
      },
    });
    const engine = new Engine({ ...options, storage: domain });
    cleanup.push(async () => {
      await engine.settled().catch(() => undefined);
      await storage.close();
    });
    return { domain, engine, resourceId, threadId };
  }

  function message(
    f: { resourceId: string; threadId: string },
    text = 'Paris weather. '.repeat(60)
  ): MastraDBMessage {
    return {
      content: { format: 2, parts: [{ text, type: 'text' }] },
      createdAt: new Date('2026-10-06T00:00:00Z'),
      id: randomUUID(),
      resourceId: f.resourceId,
      role: 'user',
      threadId: f.threadId,
    };
  }

  function holdFlag(
    domain: MemoryStorage,
    method: 'setBufferingObservationFlag' | 'setBufferingReflectionFlag',
    holdWhen: (value: boolean, writes: readonly boolean[]) => boolean
  ) {
    const started = gate();
    const held = gate();
    const writes: boolean[] = [];
    const original = domain[method].bind(domain);
    domain[method] = async (id: string, value: boolean, tokens?: number) => {
      writes.push(value);
      if (holdWhen(value, writes)) {
        started.resolve();
        await held.promise;
      }
      await original(id, value, tokens);
    };
    return { held, started, writes };
  }

  it('keeps buffer() owning its flag until its final clear lands, so a status read starts no stale clear', async () => {
    const f = await fixture({
      model: reflectionModel(),
      observation: { bufferTokens: 100, messageTokens: 1000 },
      reflection: { observationTokens: 10_000 },
    });
    const record = await f.engine.getOrCreateRecord(f.threadId, f.resourceId);
    const flag = holdFlag(
      f.domain,
      'setBufferingObservationFlag',
      (value, writes) => !value && writes.length === 2
    );
    // Nothing to buffer: the cycle records no chunk, so its cleanup clears the flag.
    const buffered = f.engine.buffer({
      messages: [],
      pendingTokens: 200,
      record,
      resourceId: f.resourceId,
      threadId: f.threadId,
    });
    await flag.started.promise;
    expect(flag.writes).toEqual([true, false]);
    // During that clear the flag is still this operation's, not a stale one.
    await expect(
      f.engine.triggerAsyncBuffering({
        pendingTokens: 200,
        record: { ...record, isBufferingObservation: true },
        resourceId: f.resourceId,
        threadId: f.threadId,
        threshold: 1000,
        unbufferedPendingTokens: 200,
        unobservedMessages: [],
      })
    ).resolves.toBe(false);
    expect(flag.writes).toEqual([true, false]);
    flag.held.resolve();
    await expect(buffered).resolves.toMatchObject({ buffered: false });
    await f.engine.settled();
    expect(flag.writes).toEqual([true, false]);
  });

  it('joins a stale buffering-reflection clear before maybeReflect returns', async () => {
    const f = await fixture({
      model: reflectionModel(),
      observation: { bufferTokens: 100, messageTokens: 1000 },
      reflection: { bufferActivation: 0.5, observationTokens: 1000 },
    });
    const record = await f.engine.getOrCreateRecord(f.threadId, f.resourceId);
    await f.domain.setBufferingReflectionFlag(record.id, true);
    const flag = holdFlag(f.domain, 'setBufferingReflectionFlag', (value) => !value);
    const reflected = watch(
      f.engine.reflector.maybeReflect({
        observationTokens: 10,
        record: { ...record, isBufferingReflection: true },
        threadId: f.threadId,
      })
    );
    await flag.started.promise;
    await nextTurn();
    expect(reflected.settled).toBe(false);
    flag.held.resolve();
    expect((await reflected.result).status).toBe('fulfilled');
    expect(flag.writes).toEqual([false]);
    expect(
      (await f.domain.getObservationalMemory(f.threadId, f.resourceId))?.isBufferingReflection
    ).toBe(false);
  });

  it('keeps async reflection owning its flag until its final clear lands, so a status read starts no stale clear', async () => {
    const f = await fixture({
      model: reflectionModel(),
      observation: { bufferTokens: 100, messageTokens: 1000 },
      reflection: { bufferActivation: 0.5, observationTokens: 100 },
    });
    const initial = await f.engine.getOrCreateRecord(f.threadId, f.resourceId);
    await f.domain.updateActiveObservations({
      id: initial.id,
      lastObservedAt: new Date('2026-10-06T00:00:00Z'),
      observations: '- The user is planning a Paris trip. '.repeat(10),
      tokenCount: 80,
    });
    const record = await f.engine.getOrCreateRecord(f.threadId, f.resourceId);
    const flag = holdFlag(
      f.domain,
      'setBufferingReflectionFlag',
      (value, writes) => !value && writes.length === 2
    );
    // Above the activation point: maybeReflect starts a background buffered reflection.
    await f.engine.reflector.maybeReflect({
      observationTokens: 80,
      record,
      threadId: f.threadId,
    });
    await flag.started.promise;
    expect(flag.writes).toEqual([true, false]);
    // During that clear the reflection flag is still the operation's, not a stale one.
    await f.engine.reflector.maybeReflect({
      observationTokens: 80,
      record: { ...record, isBufferingReflection: true },
      threadId: f.threadId,
    });
    expect(flag.writes).toEqual([true, false]);
    flag.held.resolve();
    await f.engine.settled();
    expect(flag.writes).toEqual([true, false]);
  });

  it('starts no native turn for an already-cancelled run', async () => {
    const f = await fixture({
      model: reflectionModel(),
      observation: { bufferTokens: false, messageTokens: 1000 },
      reflection: { observationTokens: 10_000 },
    });
    const call = new AbortController();
    const reason = new DOMException('Stop before the turn starts', 'AbortError');
    call.abort(reason);
    const turn = f.engine.beginTurn({
      abortSignal: call.signal,
      messageList: new MessageList({ resourceId: f.resourceId, threadId: f.threadId }),
      resourceId: f.resourceId,
      threadId: f.threadId,
    });
    await expect(turn.start()).rejects.toBe(reason);
    expect(await f.domain.getObservationalMemory(f.threadId, f.resourceId)).toBeNull();
  });

  it('starts no observation cycle once its run is cancelled during setup', async () => {
    const f = await fixture({
      model: reflectionModel(),
      observation: { bufferTokens: false, messageTokens: 10 },
      reflection: { observationTokens: 10_000 },
    });
    const committed = message(f);
    // Observation markers land on the latest stored assistant message.
    const answer: MastraDBMessage = {
      ...message(f, 'The forecast for Paris is mild.'),
      createdAt: new Date('2026-10-06T00:00:01Z'),
      role: 'assistant',
    };
    await f.domain.saveMessages({ messages: [committed, answer] });
    const saves = vi.spyOn(f.domain, 'saveMessages');
    const call = new AbortController();
    const reason = new DOMException('Stop while the cycle is set up', 'AbortError');
    await expect(
      f.engine.observe({
        abortSignal: call.signal,
        hooks: {
          // The run is stopped after admission, before the cycle itself starts.
          onObservationStart: () => call.abort(reason),
        },
        messages: [committed, answer],
        resourceId: f.resourceId,
        threadId: f.threadId,
      })
    ).rejects.toBe(reason);
    // No observation-start marker was written for the cancelled cycle.
    expect(saves).not.toHaveBeenCalled();
    const stored = await f.domain.listMessages({ perPage: false, threadId: f.threadId });
    expect(
      stored.messages.flatMap((entry) => entry.content.parts.map((part) => part.type))
    ).not.toContain('data-om-observation-start');
  });
});
