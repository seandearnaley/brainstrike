import type { VectorProfile } from '@brainstrike/indexer';
import type { MemoryDomainPort, MemoryJson, MemorySnapshot } from '@brainstrike/state-store';
import { Schema } from 'effect';
import { afterEach, expect, test } from 'vitest';
import { StateStoreMemoryStorage } from '../src/adapters/memory-storage.js';
import { calculateMemoryMutation } from '../src/adapters/memory-storage-calculator.js';
import {
  admittedMemoryModels,
  hostMemoryModels,
  readHostObservation,
} from '../src/adapters/observation-state.js';
import { HostObservationalMemoryStateSchema } from '../src/protocol.js';

const resourceId = 'resource';
const threadId = 'thread';
const at = new Date('2026-10-06T19:00:00Z');
const later = new Date('2026-10-06T19:05:00Z');
const CONFIG = {
  observation: { messageTokens: 1000 },
  reflection: { observationTokens: 8000 },
  scope: 'thread',
};

/**
 * The production writer's native contract over one in-memory snapshot, which
 * a test can damage: one stored field of the observation record replaced.
 */
function writer(): MemoryDomainPort & { damage(field: string, value: MemoryJson): void } {
  let snapshot: MemorySnapshot = { entities: [], revision: 0 };
  return {
    damage: (field, value) => {
      snapshot = {
        ...snapshot,
        entities: snapshot.entities.map((row) =>
          row.kind === 'observation' ? { ...row, payload: { ...row.payload, [field]: value } } : row
        ),
      };
    },
    memory: async (request) => {
      if (request.operation === 'read') {
        return snapshot;
      }
      if (request.operation !== 'native') {
        throw new Error(`Unexpected ${request.operation} request in the observation fixture`);
      }
      const result = await calculateMemoryMutation(snapshot, request);
      const rows = new Map(snapshot.entities.map((row) => [`${row.kind}:${row.id}`, row]));
      for (const change of result.changes) {
        if (change.operation === 'put') {
          rows.set(`${change.entity.kind}:${change.entity.id}`, change.entity);
        } else {
          rows.delete(`${change.kind}:${change.id}`);
        }
      }
      snapshot = { entities: [...rows.values()], revision: snapshot.revision + 1 };
      return { ...snapshot, value: result.value };
    },
  };
}

const adapters: StateStoreMemoryStorage[] = [];
afterEach(async () => {
  for (const adapter of adapters.splice(0)) {
    await adapter.close();
  }
});

/** A thread's OM record, written through the same native storage Mastra writes it with. */
async function seeded(config: Record<string, unknown> = CONFIG) {
  const store = writer();
  const storage = new StateStoreMemoryStorage(
    resourceId,
    store,
    { read: async () => [] },
    threadId
  );
  adapters.push(storage);
  const record = await storage.initializeObservationalMemory({
    config,
    resourceId,
    scope: 'thread',
    threadId,
  });
  return { record, storage, store };
}

test.each([
  ['isObserving', 'yes', 'Observation record isObserving is not a boolean'],
  ['isBufferingReflection', null, 'Observation record isBufferingReflection is not a boolean'],
  ['generationCount', -1, 'Observation record generationCount is not a non-negative integer'],
  ['originType', 'rewind', 'Observation record originType is not initial or reflection'],
  ['lastObservedAt', 1_791_313_200_000, 'Observation record lastObservedAt is not a date'],
  ['lastBufferedAtTime', true, 'Observation record lastBufferedAtTime is not a date'],
] as const)('a stored %s of %j is an error, never a default', async (field, value, message) => {
  const { store } = await seeded();
  store.damage(field, value);
  await expect(read(store)).rejects.toThrow(message);
});

async function read(store: MemoryDomainPort) {
  const state = await readHostObservation(
    store,
    { resourceId, scope: 'thread', state: 'on' },
    threadId
  );
  // Every projection is what the wire carries.
  expect(
    Schema.decodeSync(HostObservationalMemoryStateSchema, {
      errors: 'all',
      onExcessProperty: 'error',
    })(state)
  ).toEqual(state);
  if (state.state !== 'active' || state.record === null) {
    throw new Error('Expected an active observation record');
  }
  return state.record;
}

test('a fresh record projects its idle lifecycle, first generation and reflection threshold', async () => {
  const { store } = await seeded();
  expect(await read(store)).toEqual({
    bufferedObservationTokens: 0,
    lifecycle: {
      generationCount: 0,
      isBufferingObservation: false,
      isBufferingReflection: false,
      isObserving: false,
      isReflecting: false,
      lastBufferedAtTime: null,
      lastObservedAt: null,
      originType: 'initial',
      reflectionTokenThreshold: 8000,
    },
    messageTokenThreshold: 1000,
    observationTokenCount: 0,
    pendingMessageTokens: 0,
    totalTokensObserved: 0,
  });
});

test('live observing, reflecting and buffering flags are the stored ones', async () => {
  const { record, storage, store } = await seeded();
  await storage.setObservingFlag(record.id, true);
  expect((await read(store)).lifecycle).toMatchObject({ isObserving: true, isReflecting: false });
  await storage.setReflectingFlag(record.id, true);
  await storage.setBufferingObservationFlag(record.id, true, 200);
  await storage.setBufferingReflectionFlag(record.id, true);
  expect((await read(store)).lifecycle).toMatchObject({
    isBufferingObservation: true,
    isBufferingReflection: true,
    isObserving: true,
    isReflecting: true,
  });
});

test('a buffered chunk, its activation and a reflection carry their times and generation', async () => {
  const { record, storage, store } = await seeded();
  await storage.updateBufferedObservations({
    chunk: {
      cycleId: 'cycle',
      lastObservedAt: at,
      messageIds: ['committed'],
      messageTokens: 100,
      observations: '- A retained fact.',
      tokenCount: 10,
    },
    id: record.id,
    lastBufferedAtTime: later,
  });
  expect(await read(store)).toMatchObject({
    bufferedObservationTokens: 10,
    lifecycle: { lastBufferedAtTime: later.getTime(), lastObservedAt: null },
  });
  await storage.swapBufferedToActive({
    activationRatio: 1,
    currentPendingTokens: 100,
    id: record.id,
    messageTokensThreshold: 100,
  });
  const active = await storage.getObservationalMemory(threadId, resourceId);
  if (!active) {
    throw new Error('The activated record is gone');
  }
  expect(await read(store)).toMatchObject({
    lifecycle: { lastObservedAt: at.getTime() },
    observationTokenCount: 10,
  });
  await storage.createReflectionGeneration({
    currentRecord: active,
    reflection: '- Condensed retained fact.',
    tokenCount: 4,
  });
  expect((await read(store)).lifecycle).toMatchObject({
    generationCount: 1,
    lastObservedAt: at.getTime(),
    originType: 'reflection',
    reflectionTokenThreshold: 8000,
  });
});

test('a record without a positive reflection threshold is an error, never a zero', async () => {
  const { store } = await seeded({ ...CONFIG, reflection: {} });
  await expect(read(store)).rejects.toThrow(
    'Observation record config.reflection.observationTokens is not a non-negative integer'
  );
  const zero = await seeded({ ...CONFIG, reflection: { observationTokens: 0 } });
  await expect(read(zero.store)).rejects.toThrow(
    'Observation record has no positive config.reflection.observationTokens'
  );
});

test('the run’s models name its observer and its embedder by their identities', () => {
  const local: VectorProfile = {
    dimensions: 384,
    distance: 'cosine',
    dtype: 'fp16',
    modelId: 'Xenova/all-MiniLM-L6-v2',
    provider: 'local',
    revision: 'a'.repeat(40),
    tokenCap: 256,
  };
  expect(hostMemoryModels('openai::gpt-5-mini', local)).toEqual({
    embedder: {
      dimensions: 384,
      distance: 'cosine',
      dtype: 'fp16',
      modelId: 'Xenova/all-MiniLM-L6-v2',
      provider: 'local',
    },
    observer: 'openai::gpt-5-mini',
  });
  expect(
    hostMemoryModels(undefined, {
      dimensions: 1536,
      distance: 'cosine',
      modelId: 'text-embedding-3-small',
      provider: 'openai',
    })
  ).toEqual({
    embedder: {
      dimensions: 1536,
      distance: 'cosine',
      modelId: 'text-embedding-3-small',
      provider: 'openai',
    },
  });
  expect(hostMemoryModels(undefined, undefined)).toEqual({});
});

test('an admission names its observer only while its observational memory is on', () => {
  const on = { resourceId, scope: 'thread', state: 'on' } as const;
  expect(admittedMemoryModels(on, 'openai::gpt-5-mini', undefined)).toEqual({
    observer: 'openai::gpt-5-mini',
  });
  expect(admittedMemoryModels({ state: 'off' }, 'openai::gpt-5-mini', undefined)).toEqual({});
  expect(
    admittedMemoryModels(
      { reason: 'model-not-eligible', state: 'awaiting-observer' },
      'openai::gpt-5-mini',
      undefined
    )
  ).toEqual({});
});
