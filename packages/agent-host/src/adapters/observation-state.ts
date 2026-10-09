import type { MemoryDomainPort } from '@brainstrike/state-store';
import type { ObservationalMemoryRecord } from '@mastra/core/storage';
import type { HostObservationalMemoryState, HostObserverAwaitingReason } from '../protocol.js';
import type { HostMemoryCapabilities } from './memory.js';
import { StateStoreMemoryStorage } from './memory-storage.js';

/** Observational memory as an admission configures it; `on` names where its record lives. */
export type HostObservationSource =
  | { readonly state: 'off' }
  | { readonly reason: HostObserverAwaitingReason; readonly state: 'awaiting-observer' }
  | { readonly resourceId: string; readonly scope: 'thread' | 'resource'; readonly state: 'on' };

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

/** A live admission's source: its native options, or the platform's awaiting reason. */
export function nativeObservationSource(
  memory: {
    readonly native: Pick<HostMemoryCapabilities['native'], 'options'>;
    readonly resourceId: string;
  },
  awaiting: HostObserverAwaitingReason | undefined
): HostObservationSource {
  const observation = memory.native.options?.observationalMemory;
  if (!observation || (typeof observation === 'object' && observation.enabled === false)) {
    return awaiting ? { reason: awaiting, state: 'awaiting-observer' } : { state: 'off' };
  }
  const scope = typeof observation === 'object' && observation.scope === 'resource';
  return { resourceId: memory.resourceId, scope: scope ? 'resource' : 'thread', state: 'on' };
}

/**
 * The state for one thread. When observational memory is on, its record is the
 * one native OM itself reads: Mastra's `getObservationalMemory` over the
 * StateStore memory domain, keyed by the thread, or by the resource for
 * resource scope. Reading it acquires nothing.
 */
export async function readHostObservation(
  store: MemoryDomainPort,
  source: HostObservationSource,
  threadId: string
): Promise<HostObservationalMemoryState> {
  if (source.state !== 'on') {
    return source;
  }
  const storage = new StateStoreMemoryStorage(
    source.resourceId,
    store,
    { read: () => Promise.reject(new Error('An observation read needs no transcript')) },
    threadId
  );
  try {
    const record = await storage.getObservationalMemory(
      source.scope === 'resource' ? null : threadId,
      source.resourceId
    );
    return { record: record ? observationRecord(record) : null, state: 'active' };
  } finally {
    await storage.close();
  }
}
