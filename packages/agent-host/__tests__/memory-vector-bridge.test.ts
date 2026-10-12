import { expect, test } from 'vitest';
import { StateStoreMemoryVector } from '../src/adapters/state-store-memory-vector.js';
import {
  RECORDED_VECTOR_PROFILE,
  recordedMemoryVectorPort,
} from './fixtures/recorded-memory-vector-port.js';

function fixture() {
  const recorded = recordedMemoryVectorPort();
  const controller = new AbortController();
  const scope = { resourceId: 'resource', rootId: 'root', threadId: 'thread' };
  const vector = new StateStoreMemoryVector({
    port: recorded.port,
    profile: RECORDED_VECTOR_PROFILE,
    scope,
    signal: controller.signal,
  });
  return { controller, recorded, scope, vector };
}
const dense = Array.from({ length: 384 }, (_value, index) => (index === 0 ? 1 : 0));

test('native segments reuse one committed ID and the pre-inference owner plan', async () => {
  const { recorded, vector } = fixture();
  const identity = { messageId: 'committed-message', seq: 4 };
  await vector.withPreparedMessages([identity], async () => {
    recorded.events.push('embedding');
    await vector.createIndex({ dimension: 384, indexName: 'native-memory' });
    const metadata = {
      message_id: identity.messageId,
      resource_id: 'resource',
      thread_id: 'thread',
    };
    expect(
      await vector.upsert({
        indexName: 'native-memory',
        metadata: [metadata, metadata],
        vectors: [dense, dense],
      })
    ).toEqual([identity.messageId, identity.messageId]);
  });
  expect(recorded.events).toEqual(['prepare', 'embedding', 'upsert']);
  expect(recorded.upserts[0]?.plan).toBe(recorded.plans[0]);
  expect(recorded.upserts[0]?.embeddings).toEqual([
    { messageId: identity.messageId, vectors: [dense, dense] },
  ]);
  await expect(
    vector.upsert({ indexName: 'native-memory', metadata: [], vectors: [] })
  ).rejects.toThrow(/pre-inference/);
});

test.each(['thread', 'resource'] as const)(
  'public %s query maps to the captured owner scope',
  async (mode) => {
    const { recorded, vector } = fixture();
    const threadId = mode === 'thread' ? 'thread' : 'other-durable-member';
    recorded.setHits([{ messageId: 'canonical', score: 1, segmentOrdinal: 0, seq: 8, threadId }]);
    await vector.createIndex({ dimension: 384, indexName: 'native-memory' });
    expect(
      await vector.query({
        filter: mode === 'thread' ? { thread_id: 'thread' } : { resource_id: 'resource' },
        indexName: 'native-memory',
        queryVector: dense,
        topK: 1,
      })
    ).toEqual([
      {
        id: 'canonical',
        metadata: { message_id: 'canonical', resource_id: 'resource', thread_id: threadId },
        score: 1,
      },
    ]);
    expect(recorded.queries[0]).toEqual({
      limit: 1,
      profile: RECORDED_VECTOR_PROFILE,
      scope: { resourceId: 'resource', rootId: 'root', threadId: 'thread' },
      ...(mode === 'thread' ? { threadIds: ['thread'] } : {}),
      vector: dense,
    });
  }
);

test('foreign/unsupported filters fail before the borrowed query port', async () => {
  const { recorded, vector } = fixture();
  await vector.createIndex({ dimension: 384, indexName: 'native-memory' });
  for (const filter of [
    { resource_id: 'foreign' },
    { thread_id: 'foreign' },
    { resource_id: 'resource', role: 'assistant' },
  ]) {
    await expect(
      vector.query({ filter, indexName: 'native-memory', queryVector: dense, topK: 1 })
    ).rejects.toThrow(/scope|authority/);
  }
  expect(recorded.queries).toHaveLength(0);
});

test('a foreign committed metadata claim cannot enter an admitted write', async () => {
  const { recorded, vector } = fixture();
  await vector.createIndex({ dimension: 384, indexName: 'native-memory' });
  await expect(
    vector.withPreparedMessages([{ messageId: 'canonical', seq: 4 }], async () => {
      await vector.upsert({
        indexName: 'native-memory',
        metadata: [{ message_id: 'canonical', resource_id: 'foreign', thread_id: 'thread' }],
        vectors: [dense],
      });
    })
  ).rejects.toThrow(/authority/);
  expect(recorded.upserts).toHaveLength(0);
});

test('owner prepare failure prevents external inference', async () => {
  const { recorded, vector } = fixture();
  const failure = new Error('retired source');
  recorded.setPrepareFailure(failure);
  await expect(
    vector.withPreparedMessages([{ messageId: 'canonical', seq: 4 }], async () => {
      recorded.events.push('embedding');
    })
  ).rejects.toBe(failure);
  expect(recorded.events).toEqual(['prepare']);
});

test('captured run authority and cancellation survive caller DTO mutation', async () => {
  const { controller, recorded, scope, vector } = fixture();
  scope.resourceId = 'changed';
  vector.assertOwner('resource', 'thread', controller.signal);
  expect(() => vector.assertOwner('changed', 'thread', controller.signal)).toThrow(/authority/);
  await vector.createIndex({ dimension: 384, indexName: 'native-memory' });
  const reason = new Error('run stopped');
  controller.abort(reason);
  await expect(
    vector.query({
      filter: { resource_id: 'resource' },
      indexName: 'native-memory',
      queryVector: dense,
      topK: 1,
    })
  ).rejects.toBe(reason);
  expect(recorded.queries).toHaveLength(0);
});
