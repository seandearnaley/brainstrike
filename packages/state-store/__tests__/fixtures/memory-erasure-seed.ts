import type { StateStore } from '../../src/state-store.js';

export const MEMORY_ERASURE_SECRET = 'recorded-M3-shared-WM-OM-erasure-fixture';
export const MEMORY_ERASURE_RESOURCE = 'recorded-shared-resource';
export const MEMORY_ERASURE_THREAD = 'recorded-canonical-thread';

/** Native DTOs and buffer activation match the recorded Memory calculator lane. */
export async function seedMemoryErasure(store: StateStore): Promise<void> {
  const resourceId = MEMORY_ERASURE_RESOURCE;
  const threadId = MEMORY_ERASURE_THREAD;
  await store.append([{ event: { text: MEMORY_ERASURE_SECRET, type: 'text' }, threadId }]);
  const at = new Date('2026-10-06T19:00:00Z').toISOString();
  const native = (
    method:
      | 'saveThread'
      | 'saveResource'
      | 'initializeObservationalMemory'
      | 'updateBufferedObservations'
      | 'swapBufferedToActive',
    argumentsValue: readonly import('../../src/memory-types.js').MemoryJson[]
  ) =>
    store.memory({
      arguments: argumentsValue,
      method,
      operation: 'native',
      ownerThreadId: threadId,
      resourceId,
    });
  await native('saveThread', [
    { thread: { createdAt: at, id: threadId, metadata: {}, resourceId, updatedAt: at } },
  ]);
  await native('saveResource', [
    {
      resource: {
        createdAt: at,
        id: resourceId,
        updatedAt: at,
        workingMemory: MEMORY_ERASURE_SECRET,
      },
    },
  ]);
  const created = await native('initializeObservationalMemory', [
    { config: {}, resourceId, scope: 'resource', threadId: null },
  ]);
  const value = created.value;
  if (
    !(
      value &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      'id' in value &&
      typeof value['id'] === 'string'
    )
  ) {
    throw new Error('Native OM did not create its record');
  }
  await native('updateBufferedObservations', [
    {
      chunk: {
        cycleId: 'recorded-cycle',
        lastObservedAt: at,
        messageIds: [JSON.stringify([threadId, 1])],
        messageTokens: 100,
        observations: MEMORY_ERASURE_SECRET,
        tokenCount: 10,
      },
      id: value['id'],
      lastBufferedAtTime: at,
    },
  ]);
  await native('swapBufferedToActive', [
    { activationRatio: 1, currentPendingTokens: 100, id: value['id'], messageTokensThreshold: 100 },
  ]);
}
