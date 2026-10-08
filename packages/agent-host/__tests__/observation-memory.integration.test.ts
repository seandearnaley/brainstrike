import { parseObservationGroups } from '@mastra/memory/processors';
import { expect, test, vi } from 'vitest';
import { chunkStateObservationText } from '../src/adapters/state-store-observation-memory.js';
import { observationMemoryHost } from './fixtures/observation-memory-host.js';

test.each(['thread', 'resource'] as const)(
  'actual public Memory indexes committed native observation groups (%s)',
  async (scope) => {
    const f = await observationMemoryHost(scope);
    try {
      const messages = (await f.read()).filter((message) => message.threadId === f.threadId);
      const result = await f.engine.observe({
        messages,
        resourceId: f.host.resourceId,
        threadId: f.threadId,
      });
      expect(result.observed).toBe(true);
      const snapshot = await f.host.store.memory({
        operation: 'read',
        resourceId: f.host.resourceId,
      });
      const entity = snapshot.entities.find(
        (row) => row.kind === 'observation' && row.id === result.record.id
      );
      expect(entity?.payload['id']).toBe(result.record.id);
      const persisted = entity?.payload['activeObservations'];
      expect(typeof persisted).toBe('string');
      if (typeof persisted !== 'string') {
        throw new Error('Native observation group must be committed to the existing writer');
      }
      const groups = parseObservationGroups(persisted);
      expect(groups.length).toBeGreaterThan(0);
      console.error(
        'Committed native observation indexing receipt:',
        JSON.stringify({
          embeddingCalls: f.host.embeddingCalls,
          groups,
          messages: messages.map(({ id, threadId: owner }) => ({ id, threadId: owner })),
          observerCalls: f.observer.doStreamCalls.length,
          persisted,
          recordId: result.record.id,
          scope,
          upserts: f.vector.upserts.map(({ ids, indexName, metadata, vectors }) => ({
            dimensions: vectors.map((vector) => vector.length),
            ids,
            indexName,
            metadata,
          })),
        })
      );
      expect(f.vector.upserts.length).toBeGreaterThan(0);
      const indexed = f.vector.upserts.flatMap((call) => call.metadata ?? []);
      for (const group of groups) {
        expect(
          indexed.filter((row) => row['group_id'] === group.id).map((row) => row['text'])
        ).toEqual(chunkStateObservationText(group.content));
      }
    } finally {
      await f.close();
    }
  }
);

test('public recall resolves an unchanged Core JSON-array cursor as an individual message', async () => {
  const f = await observationMemoryHost('thread');
  try {
    const message = (await f.read()).filter((item) => item.threadId === f.threadId).at(-1);
    if (!message) {
      throw new Error('Actual committed assistant cursor is absent');
    }
    const read = vi.spyOn(f.domain, 'listMessagesById');
    const recall = f.memory.listTools()['recall'];
    if (!recall?.execute) {
      throw new Error('Pinned public Memory recall tool is absent');
    }
    const context = {
      agent: {
        agentId: 'recorded-observation-causal-agent',
        messages: [],
        resourceId: f.host.resourceId,
        suspend: async () => {
          throw new Error('Canonical cursor probe does not suspend');
        },
        threadId: f.threadId,
        toolCallId: 'recorded-canonical-cursor-probe',
      },
      memory: f.memory,
      observe: noopObserve,
    };
    const result: unknown = await recall.execute(
      { cursor: message.id, limit: 2, mode: 'messages' },
      context
    );
    console.error(
      'Native canonical cursor receipt:',
      JSON.stringify({ cursor: message.id, reads: read.mock.calls, result })
    );
    expect(read).toHaveBeenCalledWith({ messageIds: [message.id] });
    expect(result).toMatchObject({ count: expect.any(Number) });
  } finally {
    await f.close();
  }
});

test('native observation range round-trips unchanged committed message endpoints', async () => {
  const f = await observationMemoryHost('thread');
  try {
    const messages = (await f.read()).filter((message) => message.threadId === f.threadId);
    const result = await f.engine.observe({
      messages,
      resourceId: f.host.resourceId,
      threadId: f.threadId,
    });
    const groups = parseObservationGroups(result.record.activeObservations);
    const first = messages[0];
    const last = messages.at(-1);
    if (!(first && last)) {
      throw new Error('Actual committed observation source requires its unchanged endpoints');
    }
    expect(groups[0]?.range).toBe(`${first.id}:${last.id}`);
  } finally {
    await f.close();
  }
});

import { noopObserve } from '@mastra/core/tools';
