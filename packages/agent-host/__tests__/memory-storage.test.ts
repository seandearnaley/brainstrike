import type { MemoryDomainPort, MemorySnapshot } from '@brainstrike/state-store';
import type { MastraDBMessage } from '@mastra/core/agent';
import { expect, test } from 'vitest';
import { StateStoreMemoryStorage } from '../src/adapters/memory-storage.js';

const committed: MastraDBMessage = {
  content: { format: 2, parts: [{ text: 'Committed host truth', type: 'text' }] },
  createdAt: new Date('2026-10-06T19:00:00Z'),
  id: 'committed-host-id',
  resourceId: 'resource',
  role: 'user',
  threadId: 'thread',
};
const empty: MemorySnapshot = { entities: [], revision: 0 };

test('functional metadata updates preserve native partial-merge semantics', async () => {
  let current: MemorySnapshot = {
    entities: [
      {
        id: 'thread',
        kind: 'thread',
        payload: {
          createdAt: '2026-10-06T19:00:00.000Z',
          id: 'thread',
          metadata: { retained: 'unchanged' },
          resourceId: 'resource',
          updatedAt: '2026-10-06T19:00:00.000Z',
        },
        threadId: 'thread',
      },
    ],
    revision: 1,
  };
  const writer: MemoryDomainPort = {
    memory: async (request) => {
      if (request.operation === 'commit') {
        expect(request.expectedRevision).toBe(1);
        const first = request.changes[0];
        if (first?.operation !== 'put') {
          throw new Error('Expected an atomic metadata put');
        }
        current = { entities: [first.entity], revision: 2 };
      }
      return current;
    },
  };
  const adapter = new StateStoreMemoryStorage('resource', writer, { read: async () => [] });
  const updated = await adapter.updateThreadMetadata({
    id: 'thread',
    update: () => ({ added: 'new' }),
  });
  expect(updated?.metadata).toEqual({ added: 'new', retained: 'unchanged' });
  expect(current.entities[0]?.payload['metadata']).toEqual(updated?.metadata);
  await adapter.close();
});

test('public storage projects committed identities without appending native transcript facts', async () => {
  let mutations = 0;
  const writer: MemoryDomainPort = {
    memory: async (request) => {
      if (request.operation !== 'read') {
        mutations += 1;
      }
      return empty;
    },
  };
  const adapter = new StateStoreMemoryStorage('resource', writer, {
    read: async () => [committed],
  });
  const nativeProjection = {
    ...committed,
    content: {
      ...committed.content,
      parts: [{ text: 'Native processed projection', type: 'text' as const }],
    },
  };
  expect(await adapter.saveMessages({ messages: [nativeProjection] })).toEqual({
    messages: [committed],
  });
  expect((await adapter.listMessagesById({ messageIds: [committed.id] })).messages).toMatchObject([
    committed,
  ]);
  expect(mutations).toBe(0);
  await adapter.close();
  await expect(adapter.saveMessages({ messages: [committed] })).rejects.toThrow(
    /admission is closed/
  );
});

test('uncommitted native IDs and forbidden transcript mutations remain cleanup failures', async () => {
  const adapter = new StateStoreMemoryStorage(
    'resource',
    { memory: async () => empty },
    { read: async () => [committed] }
  );
  const uncommitted = await adapter
    .saveMessages({ messages: [{ ...committed, id: 'new-native-id' }] })
    .catch((cause: unknown) => cause);
  expect(uncommitted).toBeInstanceOf(Error);
  const forbidden = await adapter.deleteMessages([committed.id]).catch((cause: unknown) => cause);
  expect(forbidden).toBeInstanceOf(Error);
  await expect(adapter.close()).rejects.toMatchObject({ errors: [uncommitted, forbidden] });
  await expect(adapter.close()).rejects.toMatchObject({ errors: [uncommitted, forbidden] });
});
