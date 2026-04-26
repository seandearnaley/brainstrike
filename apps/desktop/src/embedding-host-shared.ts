import type {
  BackgroundRuntimeProgress,
  BackgroundRuntimeStatus,
  RuntimeRequestEnvelope,
} from '@brainstrike/worker-runtime';
import {
  assertRuntimeObjectPayloadEnvelope,
  createBackgroundRuntimeDescriptor,
  createRequestId,
} from '@brainstrike/worker-runtime';

export const EMBEDDING_HOST_RUNTIME = createBackgroundRuntimeDescriptor('embedding-host');
export const EMBEDDING_HOST_LIFECYCLE_CHANNELS = EMBEDDING_HOST_RUNTIME.lifecycleChannels;
const EMBEDDING_HOST_CHANNELS = EMBEDDING_HOST_RUNTIME.createScopedChannels({
  command: 'command',
  enqueueBackfill: 'enqueue-backfill',
  backfillProgress: 'backfill-progress',
});
export const EMBEDDING_HOST_STATUS_EVENT = EMBEDDING_HOST_LIFECYCLE_CHANNELS.statusEvent;
export const EMBEDDING_HOST_COMMAND_EVENT = EMBEDDING_HOST_CHANNELS.command;
export const EMBEDDING_HOST_REPORT_STATUS_CHANNEL = EMBEDDING_HOST_LIFECYCLE_CHANNELS.reportStatus;
export const EMBEDDING_HOST_ENSURE_STARTED_CHANNEL =
  EMBEDDING_HOST_LIFECYCLE_CHANNELS.ensureStarted;
export const EMBEDDING_HOST_STOP_CHANNEL = EMBEDDING_HOST_LIFECYCLE_CHANNELS.stop;
export const EMBEDDING_HOST_RESET_CHANNEL = EMBEDDING_HOST_LIFECYCLE_CHANNELS.reset;
export const EMBEDDING_HOST_GET_STATUS_CHANNEL = EMBEDDING_HOST_LIFECYCLE_CHANNELS.getStatus;
export const EMBEDDING_HOST_ENQUEUE_BACKFILL_CHANNEL = EMBEDDING_HOST_CHANNELS.enqueueBackfill;
export const EMBEDDING_HOST_BACKFILL_PROGRESS_EVENT = EMBEDDING_HOST_CHANNELS.backfillProgress;
export const EMBEDDING_HOST_GET_BACKFILLS_IN_FLIGHT_CHANNEL =
  'embedding-host:get-backfills-in-flight' as const;
export const EMBEDDING_HOST_CANCEL_ALL_BACKFILLS_CHANNEL =
  'embedding-host:cancel-all-backfills' as const;
export const EMBEDDING_HOST_CANCEL_BACKFILL_CHANNEL = 'embedding-host:cancel-backfill' as const;
export const EMBEDDING_BACKFILL_CANCELED_MESSAGE = 'Embedding backfill was canceled.' as const;

export type EmbeddingBackfillSource = 'background-indexing' | 'manual';

export interface EmbeddingHostBackfillRequest {
  readonly embeddingSetId: string;
  readonly source?: EmbeddingBackfillSource;
}

export type EmbeddingHostCommandAction = 'reset' | 'stop';

export type EmbeddingHostCommandPayload =
  | {
      readonly action: 'reset';
      readonly nextRuntimeId: string;
    }
  | {
      readonly action: 'stop';
    };

export interface EmbeddingHostBackfillProgress extends BackgroundRuntimeProgress {
  readonly embeddingSetId: string;
  readonly source: EmbeddingBackfillSource;
}

export interface EmbeddingHostBackfillInfo {
  readonly embeddingSetId: string;
  readonly progress: { current: number; total: number } | null;
  readonly requestId: string;
  readonly source: EmbeddingBackfillSource;
}

export const EMBEDDING_HOST_STATUS_ADAPTER = EMBEDDING_HOST_RUNTIME.statusAdapter;
export type EmbeddingHostStatus = BackgroundRuntimeStatus<'embedding-host'>;
export type EmbeddingHostStatusReport = BackgroundRuntimeStatus<'embedding-host'>;
export type EmbeddingHostCommand = RuntimeRequestEnvelope<'control', EmbeddingHostCommandPayload>;

export const EMBEDDING_HOST_STOPPED_RUNTIME_ID = EMBEDDING_HOST_RUNTIME.stoppedRuntimeId;

export function createEmbeddingHostCommand(action: 'stop', runtimeId: string): EmbeddingHostCommand;
export function createEmbeddingHostCommand(
  action: 'reset',
  runtimeId: string,
  nextRuntimeId: string
): EmbeddingHostCommand;
export function createEmbeddingHostCommand(
  action: EmbeddingHostCommandAction,
  runtimeId: string,
  nextRuntimeId?: string
): EmbeddingHostCommand {
  const normalizedRuntimeId = runtimeId.trim();
  if (normalizedRuntimeId.length === 0) {
    throw new Error('Embedding host command runtimeId must be a non-empty string.');
  }
  if (action === 'reset') {
    if (!(typeof nextRuntimeId === 'string' && nextRuntimeId.trim().length > 0)) {
      throw new Error('Embedding host reset commands require a non-empty nextRuntimeId.');
    }
    const normalizedNextRuntimeId = nextRuntimeId.trim();
    return {
      type: 'request',
      channel: 'control',
      requestId: createRequestId('embedding-host-command'),
      runtimeId: normalizedRuntimeId,
      payload: { action, nextRuntimeId: normalizedNextRuntimeId },
    };
  }
  if (nextRuntimeId !== undefined) {
    throw new Error('Embedding host stop commands must not include nextRuntimeId.');
  }
  return {
    type: 'request',
    channel: 'control',
    requestId: createRequestId('embedding-host-command'),
    runtimeId: normalizedRuntimeId,
    payload: { action },
  };
}

export function assertEmbeddingHostCommand(value: unknown): EmbeddingHostCommand {
  const { envelopeBase, payload } = assertRuntimeObjectPayloadEnvelope(
    value,
    'Embedding host command'
  );
  if (envelopeBase.type !== 'request') {
    throw new Error('Embedding host command must have type="request".');
  }
  if (envelopeBase.channel !== 'control') {
    throw new Error('Embedding host command must have channel="control".');
  }
  const action = payload['action'];
  if (action !== 'reset' && action !== 'stop') {
    throw new Error('Embedding host command payload.action must be "reset" or "stop".');
  }
  if (action === 'reset') {
    const nextRuntimeId = payload['nextRuntimeId'];
    if (!(typeof nextRuntimeId === 'string' && nextRuntimeId.trim().length > 0)) {
      throw new Error('Embedding host reset commands require a non-empty payload.nextRuntimeId.');
    }
    return {
      type: 'request',
      channel: 'control',
      requestId: envelopeBase.requestId,
      runtimeId: envelopeBase.runtimeId,
      payload: { action, nextRuntimeId: nextRuntimeId.trim() },
    };
  }
  if ('nextRuntimeId' in payload) {
    throw new Error('Embedding host stop commands must not include payload.nextRuntimeId.');
  }
  return {
    type: 'request',
    channel: 'control',
    requestId: envelopeBase.requestId,
    runtimeId: envelopeBase.runtimeId,
    payload: { action },
  };
}

export function createStoppedEmbeddingHostStatus(
  runtimeId: string = EMBEDDING_HOST_STOPPED_RUNTIME_ID
): EmbeddingHostStatus {
  return EMBEDDING_HOST_RUNTIME.createStoppedStatus(runtimeId);
}
