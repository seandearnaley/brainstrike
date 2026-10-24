import type { VectorProfile } from '@brainstrike/indexer';
import type { MemoryDomainPort } from '@brainstrike/state-store';
import type { ObservationalMemoryRecord } from '@mastra/core/storage';
import type {
  HostMemoryModels,
  HostObservationalMemoryState,
  HostObserverAwaitingReason,
} from '../protocol.ts';
import type { HostMemoryCapabilities } from './memory.ts';
import { StateStoreMemoryStorage } from './memory-storage.ts';

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

function flag(value: unknown, field: string): boolean {
  if (typeof value !== 'boolean') {
    throw new TypeError(`Observation record ${field} is not a boolean`);
  }
  return value;
}

/** A stored time as epoch ms; a time the record has not reached yet is null. */
function time(value: unknown, field: string): number | null {
  if (value === null || value === undefined) {
    return null;
  }
  if (!(value instanceof Date && Number.isFinite(value.getTime()))) {
    throw new TypeError(`Observation record ${field} is not a date`);
  }
  return value.getTime();
}

/** A positive threshold from the record's stored configuration, or an error. */
function threshold(config: Record<string, unknown>, section: string, field: string): number {
  const entry: unknown = Reflect.get(config, section);
  const value =
    entry && typeof entry === 'object'
      ? tokens(Reflect.get(entry, field), `config.${section}.${field}`)
      : undefined;
  if (!value) {
    throw new TypeError(`Observation record has no positive config.${section}.${field}`);
  }
  return value;
}

function originType(value: unknown): 'initial' | 'reflection' {
  if (value !== 'initial' && value !== 'reflection') {
    throw new TypeError('Observation record originType is not initial or reflection');
  }
  return value;
}

/** The meter's fields, read strictly: a malformed record is an error, never a zero. */
function observationRecord(record: ObservationalMemoryRecord): NonNullable<ObservationRecord> {
  return {
    bufferedObservationTokens: (record.bufferedObservationChunks ?? []).reduce(
      (total, chunk, index) =>
        total + tokens(chunk.tokenCount, `bufferedObservationChunks[${index}].tokenCount`),
      0
    ),
    lifecycle: {
      generationCount: tokens(record.generationCount, 'generationCount'),
      isBufferingObservation: flag(record.isBufferingObservation, 'isBufferingObservation'),
      isBufferingReflection: flag(record.isBufferingReflection, 'isBufferingReflection'),
      isObserving: flag(record.isObserving, 'isObserving'),
      isReflecting: flag(record.isReflecting, 'isReflecting'),
      lastBufferedAtTime: time(record.lastBufferedAtTime, 'lastBufferedAtTime'),
      lastObservedAt: time(record.lastObservedAt, 'lastObservedAt'),
      originType: originType(record.originType),
      reflectionTokenThreshold: threshold(record.config, 'reflection', 'observationTokens'),
    },
    messageTokenThreshold: threshold(record.config, 'observation', 'messageTokens'),
    observationTokenCount: tokens(record.observationTokenCount, 'observationTokenCount'),
    pendingMessageTokens: tokens(record.pendingMessageTokens, 'pendingMessageTokens'),
    totalTokensObserved: tokens(record.totalTokensObserved, 'totalTokensObserved'),
  };
}

/**
 * The models an admission's memory uses: its observer's catalog id and its
 * vector profile's identity. A local profile's precision follows its device.
 */
export function hostMemoryModels(
  observerModelId: string | undefined,
  profile: VectorProfile | undefined
): HostMemoryModels {
  return {
    ...(profile
      ? {
          embedder: {
            dimensions: profile.dimensions,
            distance: profile.distance,
            ...('dtype' in profile ? { dtype: profile.dtype } : {}),
            modelId: profile.modelId,
            provider: profile.provider,
          },
        }
      : {}),
    ...(observerModelId === undefined ? {} : { observer: observerModelId }),
  };
}

/** A live admission's models: its observer runs only while its observational memory is on. */
export function admittedMemoryModels(
  source: HostObservationSource,
  observerModelId: string | undefined,
  profile: VectorProfile | undefined
): HostMemoryModels {
  return hostMemoryModels(source.state === 'on' ? observerModelId : undefined, profile);
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
