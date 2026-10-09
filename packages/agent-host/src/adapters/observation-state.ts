import type { MemoryDomainPort } from '@brainstrike/state-store';
import type { ObservationalMemoryRecord } from '@mastra/core/storage';
import type { HostObservationalMemoryState, HostObserverAwaitingReason } from '../protocol.js';
import type { HostMemoryCapabilities } from './memory.js';
import { StateStoreMemoryStorage } from './memory-storage.js';

type ObservationRecord = Extract<HostObservationalMemoryState, { state: 'active' }>['record'];

function tokens(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`Observation record ${field} is not a non-negative integer`);
  }
  return value;
}

/** The meter's fields, read strictly: a malformed record is an error, never a zero. */
function observationRecord(record: ObservationalMemoryRecord): NonNullable<ObservationRecord> {
  const observation: unknown = Reflect.get(record.config, 'observation');
  const threshold =
    observation && typeof observation === 'object'
      ? tokens(Reflect.get(observation, 'messageTokens'), 'config.observation.messageTokens')
      : undefined;
  if (!threshold) {
    throw new TypeError('Observation record has no positive config.observation.messageTokens');
  }
  return {
    bufferedObservationTokens: (record.bufferedObservationChunks ?? []).reduce(
      (total, chunk, index) =>
        total + tokens(chunk.tokenCount, `bufferedObservationChunks[${index}].tokenCount`),
      0
    ),
    messageTokenThreshold: threshold,
    observationTokenCount: tokens(record.observationTokenCount, 'observationTokenCount'),
    pendingMessageTokens: tokens(record.pendingMessageTokens, 'pendingMessageTokens'),
    totalTokensObserved: tokens(record.totalTokensObserved, 'totalTokensObserved'),
  };
}

/**
 * Observational memory as an admission configures it. When it is on, the
 * thread's committed record is the one native OM itself reads: Mastra's
 * `getObservationalMemory` over the StateStore memory domain, keyed by the
 * thread, or by the resource for resource scope.
 */
export async function readHostObservationState(
  store: MemoryDomainPort,
  memory: {
    readonly native: Pick<HostMemoryCapabilities['native'], 'options'>;
    readonly resourceId: string;
  },
  awaiting: HostObserverAwaitingReason | undefined,
  threadId: string
): Promise<HostObservationalMemoryState> {
  const observation = memory.native.options?.observationalMemory;
  if (!observation || (typeof observation === 'object' && observation.enabled === false)) {
    return awaiting ? { reason: awaiting, state: 'awaiting-observer' } : { state: 'off' };
  }
  const storage = new StateStoreMemoryStorage(
    memory.resourceId,
    store,
    {
      read: () => Promise.reject(new Error('An observation read needs no transcript')),
    },
    threadId
  );
  try {
    const record = await storage.getObservationalMemory(
      typeof observation === 'object' && observation.scope === 'resource' ? null : threadId,
      memory.resourceId
    );
    return { record: record ? observationRecord(record) : null, state: 'active' };
  } finally {
    await storage.close();
  }
}
