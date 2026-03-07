export const EMBEDDING_HOST_STATUS_EVENT = 'embedding-host:status';
export const EMBEDDING_HOST_COMMAND_EVENT = 'embedding-host:command';
export const EMBEDDING_HOST_REPORT_STATUS_CHANNEL = 'embedding-host:report-status';
export const EMBEDDING_HOST_ENSURE_STARTED_CHANNEL = 'embedding-host:ensure-started';
export const EMBEDDING_HOST_STOP_CHANNEL = 'embedding-host:stop';
export const EMBEDDING_HOST_RESET_CHANNEL = 'embedding-host:reset';
export const EMBEDDING_HOST_GET_STATUS_CHANNEL = 'embedding-host:get-status';

export type EmbeddingHostLifecycleState = 'stopped' | 'starting' | 'running' | 'stopping' | 'error';

export interface EmbeddingHostStatus {
  readonly active: boolean;
  readonly lastError: string | null;
  readonly state: EmbeddingHostLifecycleState;
}

export interface EmbeddingHostStatusReport {
  readonly active: boolean;
  readonly lastError: string | null;
  readonly state: Exclude<EmbeddingHostLifecycleState, 'stopping'>;
}

export interface EmbeddingHostCommand {
  readonly type: 'reset' | 'stop';
}

export function createStoppedEmbeddingHostStatus(): EmbeddingHostStatus {
  return {
    state: 'stopped',
    active: false,
    lastError: null,
  };
}
