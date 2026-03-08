import type {
  BackgroundRuntimeProgress,
  BackgroundRuntimeStatus,
  RuntimeRequestEnvelope,
} from '@brainstrike/worker-runtime';
import { createBackgroundRuntimeDescriptor } from '@brainstrike/worker-runtime';

export const EMBEDDING_HOST_RUNTIME = createBackgroundRuntimeDescriptor('embedding-host');
export const EMBEDDING_HOST_LIFECYCLE_CHANNELS = EMBEDDING_HOST_RUNTIME.lifecycleChannels;
export const EMBEDDING_HOST_STATUS_EVENT = EMBEDDING_HOST_LIFECYCLE_CHANNELS.statusEvent;
export const EMBEDDING_HOST_COMMAND_EVENT = EMBEDDING_HOST_RUNTIME.createScopedChannel('command');
export const EMBEDDING_HOST_REPORT_STATUS_CHANNEL = EMBEDDING_HOST_LIFECYCLE_CHANNELS.reportStatus;
export const EMBEDDING_HOST_ENSURE_STARTED_CHANNEL =
  EMBEDDING_HOST_LIFECYCLE_CHANNELS.ensureStarted;
export const EMBEDDING_HOST_STOP_CHANNEL = EMBEDDING_HOST_LIFECYCLE_CHANNELS.stop;
export const EMBEDDING_HOST_RESET_CHANNEL = EMBEDDING_HOST_LIFECYCLE_CHANNELS.reset;
export const EMBEDDING_HOST_GET_STATUS_CHANNEL = EMBEDDING_HOST_LIFECYCLE_CHANNELS.getStatus;
export const EMBEDDING_HOST_ENQUEUE_BACKFILL_CHANNEL =
  EMBEDDING_HOST_RUNTIME.createScopedChannel('enqueue-backfill');
export const EMBEDDING_HOST_BACKFILL_PROGRESS_EVENT =
  EMBEDDING_HOST_RUNTIME.createScopedChannel('backfill-progress');

export interface EmbeddingHostCommandPayload {
  readonly action: 'reset' | 'stop';
}

export interface EmbeddingHostBackfillProgress extends BackgroundRuntimeProgress {
  readonly embeddingSetId: string;
}

export const EMBEDDING_HOST_STATUS_ADAPTER = EMBEDDING_HOST_RUNTIME.statusAdapter;
export type EmbeddingHostStatus = BackgroundRuntimeStatus<'embedding-host'>;
export type EmbeddingHostStatusReport = BackgroundRuntimeStatus<'embedding-host'>;
export type EmbeddingHostCommand = RuntimeRequestEnvelope<'control', EmbeddingHostCommandPayload>;

export const EMBEDDING_HOST_STOPPED_RUNTIME_ID = EMBEDDING_HOST_RUNTIME.stoppedRuntimeId;

export function createStoppedEmbeddingHostStatus(
  runtimeId: string = EMBEDDING_HOST_STOPPED_RUNTIME_ID
): EmbeddingHostStatus {
  return EMBEDDING_HOST_RUNTIME.createStoppedStatus(runtimeId);
}
