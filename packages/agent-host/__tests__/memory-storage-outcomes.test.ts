import type {
  MemoryDomainPort,
  MemoryNativeRequest,
  MemorySnapshot,
} from '@brainstrike/state-store';
import type { MastraDBMessage } from '@mastra/core/agent';
import type { ObservationalMemoryRecord } from '@mastra/core/storage';
import { ObservationalMemory } from '@mastra/memory/processors';
import { MockLanguageModelV4, simulateReadableStream } from 'ai/test';
import { afterEach, expect, test } from 'vitest';
import { StateStoreMemoryStorage } from '../src/adapters/memory-storage.js';
import { calculateMemoryMutation } from '../src/adapters/memory-storage-calculator.js';
import { decodeMemory, encodeMemory } from '../src/adapters/memory-storage-codec.js';

// Mastra 1.38 commits observations through outcome-reporting storage methods
// and retries against the head on `applied: false`. The adapter must hand the
// public InMemory calculator's own outcome back unchanged, through the writer.

const resourceId = 'resource';
const threadId = 'thread';
const at = new Date('2026-10-06T19:00:00Z');
const committed: MastraDBMessage = {
  content: { format: 2, parts: [{ text: 'Paris weather. '.repeat(60), type: 'text' }] },
  createdAt: at,
  id: 'committed-host-id',
  resourceId,
  role: 'user',
  threadId,
};

/** The production writer's native contract: calculate on the snapshot, commit its delta. */
function writer(beforeNative?: (request: MemoryNativeRequest, snapshot: MemorySnapshot) => void) {
  const state = {
    requests: [] as MemoryNativeRequest[],
    snapshot: { entities: [], revision: 0 } as MemorySnapshot,
  };
  const port: MemoryDomainPort = {
    memory: async (request) => {
      if (request.operation === 'read') {
        return state.snapshot;
      }
      if (request.operation !== 'native') {
        throw new Error(`Unexpected ${request.operation} request in the outcome fixture`);
      }
      state.requests.push(request);
      beforeNative?.(request, state.snapshot);
      const result = await calculateMemoryMutation(state.snapshot, request);
      const rows = new Map(state.snapshot.entities.map((row) => [`${row.kind}:${row.id}`, row]));
      for (const change of result.changes) {
        if (change.operation === 'put') {
          rows.set(`${change.entity.kind}:${change.entity.id}`, change.entity);
        } else {
          rows.delete(`${change.kind}:${change.id}`);
        }
      }
      state.snapshot = {
        entities: [...rows.values()],
        revision: state.snapshot.revision + (result.changes.length > 0 ? 1 : 0),
      };
      return { ...state.snapshot, value: result.value };
    },
  };
  return { port, state };
}

const adapters: StateStoreMemoryStorage[] = [];
afterEach(async () => {
  for (const adapter of adapters.splice(0)) {
    await adapter.close();
  }
});

async function fixture(beforeNative?: Parameters<typeof writer>[0]) {
  const store = writer(beforeNative);
  const adapter = new StateStoreMemoryStorage(resourceId, store.port, {
    read: async () => [committed],
  });
  adapters.push(adapter);
  await adapter.saveThread({
    thread: {
      createdAt: at,
      id: threadId,
      metadata: {},
      resourceId,
      title: 'Outcomes',
      updatedAt: at,
    },
  });
  const record = await adapter.initializeObservationalMemory({
    config: {},
    resourceId,
    scope: 'thread',
    threadId,
  });
  return { adapter, record, store };
}

function storedRecord(snapshot: MemorySnapshot, id: string): ObservationalMemoryRecord {
  const row = snapshot.entities.find((entry) => entry.kind === 'observation' && entry.id === id);
  if (!row) {
    throw new Error(`Observation record ${id} is not stored`);
  }
  return decodeMemory(row.payload) as ObservationalMemoryRecord;
}

test('a conflicting commit reports the vendor conflict and writes nothing', async () => {
  const { adapter, record, store } = await fixture();
  const before = store.state.snapshot;
  expect(
    await adapter.commitActiveObservations({
      expectedActiveObservations: '- A head text this writer never saw.',
      id: record.id,
      lastObservedAt: at,
      observations: '- Must not land.',
      tokenCount: 4,
    })
  ).toEqual({ applied: false, reason: 'conflict' });
  expect(store.state.snapshot).toEqual(before);
  expect(storedRecord(store.state.snapshot, record.id).activeObservations).toBe('');
});

test('a commit to a superseded generation reports retired', async () => {
  const { adapter, record } = await fixture();
  await adapter.createReflectionGeneration({
    currentRecord: record,
    reflection: '- Reflected head.',
    tokenCount: 3,
  });
  expect(
    await adapter.commitActiveObservations({
      id: record.id,
      lastObservedAt: at,
      observations: '- Must not land on the retired generation.',
      tokenCount: 6,
    })
  ).toEqual({ applied: false, reason: 'retired' });
});

test('a skipped buffered chunk reports persisted false and is never stored', async () => {
  const { adapter, record, store } = await fixture();
  const chunk = {
    cycleId: 'cycle',
    lastObservedAt: at,
    messageIds: [committed.id],
    messageTokens: 100,
    observations: '- A buffered fact.',
    tokenCount: 4,
  };
  expect(await adapter.appendBufferedObservations({ chunk, id: record.id })).toEqual({
    persisted: true,
    recordId: record.id,
  });
  const once = store.state.snapshot;
  expect(
    await adapter.appendBufferedObservations({
      chunk: { ...chunk, observations: '- The same cycle again.' },
      id: record.id,
    })
  ).toEqual({ persisted: false, recordId: record.id });
  expect(store.state.snapshot).toEqual(once);
  expect(
    storedRecord(once, record.id).bufferedObservationChunks?.map((c) => c.observations)
  ).toEqual(['- A buffered fact.']);
});

test('a buffered chunk the cursor already covers is skipped; a later one persists', async () => {
  const { adapter, record, store } = await fixture();
  await adapter.updateActiveObservations({
    id: record.id,
    lastObservedAt: at,
    observations: '- An observed fact.',
    tokenCount: 4,
  });
  const chunk = (cycleId: string, offsetMs: number) => ({
    chunk: {
      cycleId,
      lastObservedAt: new Date(at.getTime() + offsetMs),
      messageIds: [committed.id],
      messageTokens: 100,
      observations: `- Buffered by ${cycleId}.`,
      tokenCount: 4,
    },
    id: record.id,
  });
  const observed = store.state.snapshot;
  // Core's rule: a chunk stores max message time + 1 ms, so cursor >= lastObservedAt - 1 ms
  // means every message it holds is already observed.
  for (const [cycleId, offsetMs] of [
    ['at-cursor', 0],
    ['within-tolerance', 1],
  ] as const) {
    expect(await adapter.appendBufferedObservations(chunk(cycleId, offsetMs))).toEqual({
      persisted: false,
      recordId: record.id,
    });
  }
  expect(store.state.snapshot).toEqual(observed);
  expect(await adapter.appendBufferedObservations(chunk('after-cursor', 2))).toEqual({
    persisted: true,
    recordId: record.id,
  });
  expect(
    storedRecord(store.state.snapshot, record.id).bufferedObservationChunks?.map(
      (c) => c.observations
    )
  ).toEqual(['- Buffered by after-cursor.']);
});

test('a conflicting observation commit takes the vendor retry against the head', async () => {
  const concurrent = '- Another writer committed this first.';
  let injected = false;
  const { record, store, adapter } = await fixture((request, snapshot) => {
    // Either native write of active observations: the outcome-reporting one, or
    // the update it would otherwise be reduced to.
    if (
      injected ||
      !(
        request.method === 'commitActiveObservations' ||
        request.method === 'updateActiveObservations'
      )
    ) {
      return;
    }
    // Another writer's commit lands between this cycle's head read and its write.
    injected = true;
    const row = snapshot.entities.find((entry) => entry.kind === 'observation');
    if (!row) {
      throw new Error('Expected the initialized observation record');
    }
    const payload = encodeMemory({
      ...(decodeMemory(row.payload) as ObservationalMemoryRecord),
      activeObservations: concurrent,
    });
    Object.assign(row, { payload });
  });
  const engine = new ObservationalMemory({
    model: new MockLanguageModelV4({
      doStream: async () => ({
        stream: simulateReadableStream({
          chunkDelayInMs: null,
          chunks: [
            { type: 'stream-start', warnings: [] },
            { id: 'text', type: 'text-start' },
            {
              delta: '<observations>\n- The user asked about Paris weather.\n</observations>',
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
    }),
    observation: { bufferTokens: false, messageTokens: 10 },
    reflection: { observationTokens: 10_000 },
    storage: adapter,
  });
  const result = await engine.observe({ messages: [committed], resourceId, threadId });
  await engine.settled();
  expect(result.observed).toBe(true);
  expect(store.state.requests.filter((r) => r.method === 'commitActiveObservations')).toHaveLength(
    2
  );
  const active = storedRecord(store.state.snapshot, record.id).activeObservations;
  expect(active).toContain(concurrent);
  expect(active).toContain('The user asked about Paris weather.');
});
