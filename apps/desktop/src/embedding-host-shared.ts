import type {
  BackgroundRuntimeProgress,
  BackgroundRuntimeStatus,
  RuntimeRequestEnvelope,
} from '@brainstrike/worker-runtime';

export const EMBEDDING_HOST_STATUS_EVENT = 'embedding-host:status';
export const EMBEDDING_HOST_COMMAND_EVENT = 'embedding-host:command';
export const EMBEDDING_HOST_REPORT_STATUS_CHANNEL = 'embedding-host:report-status';
export const EMBEDDING_HOST_ENSURE_STARTED_CHANNEL = 'embedding-host:ensure-started';
export const EMBEDDING_HOST_STOP_CHANNEL = 'embedding-host:stop';
export const EMBEDDING_HOST_RESET_CHANNEL = 'embedding-host:reset';
export const EMBEDDING_HOST_GET_STATUS_CHANNEL = 'embedding-host:get-status';

export interface EmbeddingHostCommandPayload {
  readonly action: 'reset' | 'stop';
}

export interface EmbeddingHostBackfillProgress extends BackgroundRuntimeProgress {
  readonly embeddingSetId: string;
}

export type EmbeddingHostStatus = BackgroundRuntimeStatus<'embedding-host'>;
export type EmbeddingHostStatusReport = BackgroundRuntimeStatus<'embedding-host'>;
export type EmbeddingHostCommand = RuntimeRequestEnvelope<'control', EmbeddingHostCommandPayload>;

export const EMBEDDING_HOST_STOPPED_RUNTIME_ID = 'embedding-host:stopped';

export function createStoppedEmbeddingHostStatus(
  runtimeId: string = EMBEDDING_HOST_STOPPED_RUNTIME_ID
): EmbeddingHostStatus {
  return {
    runtimeKind: 'embedding-host',
    runtimeId,
    state: 'stopped',
    active: false,
    lastError: null,
  };
}
