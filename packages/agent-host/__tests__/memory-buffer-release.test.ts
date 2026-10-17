import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { InMemoryStore } from '@mastra/core/storage';
import { ObservationalMemory } from '@mastra/memory/processors';
import { MockLanguageModelV4 } from 'ai/test';
import { afterEach, describe, expect, it } from 'vitest';

// The patched Memory 1.38 `buffer()` keeps its operation registered until its
// final flag clear lands (patches/@mastra__memory@1.38.0.patch). Upstream
// releases the operation first, so a status read during that clear would take
// the still-owned flag for a stale one and queue a competing clear.

const require = createRequire(import.meta.url);
const cjsProcessors =
  require('@mastra/memory/processors') as typeof import('@mastra/memory/processors');
const entrypoints = [
  { Engine: ObservationalMemory, label: 'ESM' },
  { Engine: cjsProcessors.ObservationalMemory, label: 'CJS' },
] as const;
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) {
    await step();
  }
});

describe.each(entrypoints)('$label patched buffer release', ({ Engine }) => {
  it('keeps buffer() owning its flag until its final clear lands, so a status read starts no stale clear', async () => {
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
        title: 'Buffer release fixture',
        updatedAt: new Date('2026-10-06T00:00:00Z'),
      },
    });
    const engine = new Engine({
      model: new MockLanguageModelV4(),
      observation: { bufferTokens: 100, messageTokens: 1000 },
      reflection: { observationTokens: 10_000 },
      storage: domain,
    });
    const final = Promise.withResolvers<void>();
    const finalStarted = Promise.withResolvers<void>();
    cleanup.push(async () => {
      final.resolve();
      await engine.settled().catch(() => undefined);
      await storage.close();
    });
    const record = await engine.getOrCreateRecord(threadId, resourceId);
    const writes: boolean[] = [];
    const original = domain.setBufferingObservationFlag.bind(domain);
    domain.setBufferingObservationFlag = async (id, value, tokens) => {
      writes.push(value);
      if (!value && writes.length === 2) {
        finalStarted.resolve();
        await final.promise;
      }
      await original(id, value, tokens);
    };
    // Nothing to buffer: the cycle records no chunk, so its cleanup clears the flag.
    const buffered = engine.buffer({
      messages: [],
      pendingTokens: 200,
      record,
      resourceId,
      threadId,
    });
    await finalStarted.promise;
    expect(writes).toEqual([true, false]);
    // During that clear the flag is still this operation's, not a stale one.
    await expect(
      engine.triggerAsyncBuffering({
        pendingTokens: 200,
        record: { ...record, isBufferingObservation: true },
        resourceId,
        threadId,
        threshold: 1000,
        unbufferedPendingTokens: 200,
        unobservedMessages: [],
      })
    ).resolves.toBe(false);
    expect(writes).toEqual([true, false]);
    final.resolve();
    await expect(buffered).resolves.toMatchObject({ buffered: false });
    await engine.settled();
    expect(writes).toEqual([true, false]);
  });
});
