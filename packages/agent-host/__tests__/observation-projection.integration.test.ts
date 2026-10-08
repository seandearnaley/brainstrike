import { SqliteReader } from '@brainstrike/state-store';
import { expect, test } from 'vitest';
import { observations } from '../src/observation-projection.js';
import { observationMemoryHost } from './fixtures/observation-memory-host.js';

const stateProjectionModule = new URL('../dist/state-projection.js', import.meta.url).href;

test.each(['thread', 'resource'] as const)(
  'Core producer authorizes actual native observation retrieval and reopen (%s)',
  async (scope) => {
    const f = await observationMemoryHost(scope, { realIndexer: true, stateProjectionModule });
    const reader = new SqliteReader(f.host.root);
    try {
      const observed = await f.engine.observe({
        messages: (await f.read()).filter((message) => message.threadId === f.threadId),
        resourceId: f.host.resourceId,
        threadId: f.threadId,
      });
      expect(observed.observed).toBe(true);
      const record = reader
        .snapshot(() => reader.memoryObservations(f.host.resourceId))
        .find((row) => row.id === observed.record.id);
      if (!record) {
        throw new Error('Actual native observation was not committed to Core truth');
      }
      const groups = observations(record);
      expect(groups).toHaveLength(scope === 'resource' ? 2 : 1);
      expect(new Set(groups.map((group) => group.threadId))).toEqual(
        new Set(scope === 'resource' ? f.threads : [f.threadId])
      );
      const before = await f.memory.searchMessages({
        query: 'Paris',
        resourceId: f.host.resourceId,
      });
      expect(before.results).toHaveLength(groups.length);
      for (const hit of before.results) {
        expect(groups).toContainEqual({
          groupId: hit.groupId,
          range: hit.range,
          text: hit.text,
          threadId: hit.threadId,
        });
      }
      reader.close();
      const memory = await f.reopenObservations();
      expect(
        (await memory.searchMessages({ query: 'Paris', resourceId: f.host.resourceId })).results
      ).toEqual(before.results);
    } finally {
      reader.close();
      await f.close();
    }
  }
);

test('Core producer preserves native buffered groups through activation and reopen', async () => {
  const f = await observationMemoryHost('thread', {
    buffered: true,
    realIndexer: true,
    stateProjectionModule,
  });
  try {
    const buffered = await f.engine.buffer({
      messages: (await f.read()).filter((message) => message.threadId === f.threadId),
      resourceId: f.host.resourceId,
      skipMinimumTokenCheck: true,
      threadId: f.threadId,
    });
    expect(buffered.buffered).toBe(true);
    const before = await f.memory.searchMessages({ query: 'Paris', resourceId: f.host.resourceId });
    expect(before.results).toHaveLength(1);
    const activated = await f.engine.activate({
      resourceId: f.host.resourceId,
      threadId: f.threadId,
    });
    expect(activated.activated).toBe(true);
    const memory = await f.reopenObservations();
    expect(
      (await memory.searchMessages({ query: 'Paris', resourceId: f.host.resourceId })).results
    ).toEqual(before.results);
  } finally {
    await f.close();
  }
});
