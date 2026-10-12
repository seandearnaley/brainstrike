import type {
  MemoryCalculation,
  MemoryEntity,
  MemoryEntityChange,
  MemoryJsonObject,
  MemoryNativeRequest,
  MemorySnapshot,
} from '@brainstrike/state-store';
import { InMemoryStore, type MemoryStorage } from '@mastra/core/storage';
import { TokenCounter } from '@mastra/memory/processors';
import { decodeMemory, encodeMemory } from './memory-storage-codec.js';

const methods = new Set([
  'getThreadById',
  'saveThread',
  'updateThread',
  'listThreads',
  'getResourceById',
  'saveResource',
  'updateResource',
  'getObservationalMemory',
  'getObservationalMemoryHistory',
  'initializeObservationalMemory',
  'insertObservationalMemoryRecord',
  'updateActiveObservations',
  'updateBufferedObservations',
  'swapBufferedToActive',
  'createReflectionGeneration',
  'updateBufferedReflection',
  'swapBufferedReflectionToActive',
  'setReflectingFlag',
  'setObservingFlag',
  'setBufferingObservationFlag',
  'setBufferingReflectionFlag',
  'clearObservationalMemory',
  'setPendingMessageTokens',
  'updateObservationalMemoryConfig',
]);

function entity(
  kind: MemoryEntity['kind'],
  value: { id: string },
  threadId: string | null
): MemoryEntity {
  const payload = encodeMemory(value);
  if (!(payload && typeof payload === 'object' && !Array.isArray(payload))) {
    throw new Error('Invalid native memory entity');
  }
  return { id: value.id, kind, payload: payload as MemoryJsonObject, threadId };
}

function property(value: unknown, key: string): unknown {
  return value && typeof value === 'object' ? Reflect.get(value, key) : undefined;
}

async function hydrate(
  native: MemoryStorage,
  snapshot: MemorySnapshot
): Promise<Set<string | null>> {
  const scopes = new Set<string | null>([null]);
  for (const row of snapshot.entities) {
    if (row.threadId) {
      scopes.add(row.threadId);
    }
    const value = decodeMemory(row.payload);
    if (row.kind === 'thread') {
      await native.saveThread({
        thread: value as Parameters<MemoryStorage['saveThread']>[0]['thread'],
      });
    } else if (row.kind === 'resource') {
      await native.saveResource({
        resource: value as Parameters<MemoryStorage['saveResource']>[0]['resource'],
      });
    }
  }
  const observations = snapshot.entities.filter((row) => row.kind === 'observation');
  // The public insertion primitive maintains generation ordering itself.
  for (const row of observations) {
    await native.insertObservationalMemoryRecord(
      decodeMemory(row.payload) as Parameters<MemoryStorage['insertObservationalMemoryRecord']>[0]
    );
  }
  return scopes;
}

function validateArguments(
  request: MemoryNativeRequest,
  args: unknown[],
  scopes: Set<string | null>
): void {
  if (
    [
      'getObservationalMemory',
      'getObservationalMemoryHistory',
      'clearObservationalMemory',
    ].includes(request.method) &&
    args[1] !== request.resourceId
  ) {
    throw new Error('Native memory operation crossed its resource owner');
  }
  for (const argument of args) {
    const owner = property(argument, 'resourceId');
    if (owner !== undefined && owner !== request.resourceId) {
      throw new Error('Native memory operation crossed its resource owner');
    }
    const threadOwner = property(property(argument, 'thread'), 'resourceId');
    if (threadOwner !== undefined && threadOwner !== request.resourceId) {
      throw new Error('Native thread crossed its resource owner');
    }
    const resourceId = property(property(argument, 'resource'), 'id');
    if (resourceId !== undefined && resourceId !== request.resourceId) {
      throw new Error('Native resource identity changed');
    }
    for (const value of [
      property(argument, 'threadId'),
      property(property(argument, 'currentRecord'), 'threadId'),
    ]) {
      if (typeof value === 'string') {
        scopes.add(value);
      }
    }
  }
  if (
    (request.method === 'getObservationalMemory' ||
      request.method === 'getObservationalMemoryHistory' ||
      request.method === 'clearObservationalMemory') &&
    typeof args[0] === 'string'
  ) {
    scopes.add(args[0]);
  }
}

async function entities(
  native: MemoryStorage,
  resourceId: string,
  scopes: Set<string | null>
): Promise<MemoryEntity[]> {
  const after: MemoryEntity[] = [];
  const resource = await native.getResourceById({ resourceId });
  if (resource) {
    after.push(entity('resource', resource, null));
  }
  for (const thread of (await native.listThreads({ filter: { resourceId }, perPage: false }))
    .threads) {
    scopes.add(thread.id);
    after.push(entity('thread', thread, thread.id));
  }
  for (const scope of scopes) {
    for (const record of await native.getObservationalMemoryHistory(scope, resourceId)) {
      after.push(entity('observation', record, record.threadId));
    }
  }
  return after;
}

/**
 * Pure vendor-storage calculation, loaded by Studio on the existing writer.
 * The transient projection has no SQLite connection, file or transcript facts.
 * Native operations/IDs stay unmodified; only their delta becomes durable.
 * Upstream primitive: https://github.com/mastra-ai/mastra/tree/main/packages/core/src/storage/domains/memory
 */
export async function calculateMemoryMutation(
  snapshot: MemorySnapshot,
  request: MemoryNativeRequest
): Promise<MemoryCalculation> {
  if (!methods.has(request.method)) {
    throw new Error('Unsupported native memory operation');
  }
  const temporary = new InMemoryStore({ id: request.resourceId });
  await temporary.init();
  try {
    const native = await temporary.getStore('memory');
    if (!native) {
      throw new Error('Public native memory domain is absent');
    }
    const scopes = await hydrate(native, snapshot);
    const args = request.arguments.map((value) => decodeMemory(value));
    validateArguments(request, args, scopes);
    const operation: unknown = Reflect.get(native, request.method);
    if (typeof operation !== 'function') {
      throw new Error('Public native memory method is absent');
    }
    const result: unknown = await Reflect.apply(operation, native, args);
    const after = await entities(native, request.resourceId, scopes);
    const before = new Map(snapshot.entities.map((row) => [`${row.kind}:${row.id}`, row]));
    const changes: MemoryEntityChange[] = [];
    for (const row of after) {
      const key = `${row.kind}:${row.id}`;
      if (JSON.stringify(before.get(key)) !== JSON.stringify(row)) {
        changes.push({ entity: row, operation: 'put' });
      }
      before.delete(key);
    }
    for (const row of before.values()) {
      changes.push({ id: row.id, kind: row.kind, operation: 'remove' });
    }
    return { changes, value: result === undefined ? null : encodeMemory(result) };
  } finally {
    await temporary.close();
  }
}

const observationTokens = new TokenCounter();

/**
 * Mastra OM's own observation token count. `TokenCounter.countObservations`
 * sets a record's `observationTokenCount`, each buffered chunk's `tokenCount`
 * and `bufferedReflectionTokens`; the writer recounts those with it after
 * detaching a deleted thread's sections from shared resource observations.
 */
export function countObservationTokens(text: string): number {
  return observationTokens.countObservations(text);
}
