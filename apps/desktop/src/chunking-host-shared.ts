export const CHUNKING_HOST_STATUS_EVENT = 'chunking-host:status';
export const CHUNKING_HOST_REQUEST_EVENT = 'chunking-host:request';
export const CHUNKING_HOST_PROGRESS_EVENT = 'chunking-host:progress';
export const CHUNKING_HOST_REPORT_STATUS_CHANNEL = 'chunking-host:report-status';
export const CHUNKING_HOST_REPORT_RESPONSE_CHANNEL = 'chunking-host:report-response';
export const CHUNKING_HOST_ENSURE_STARTED_CHANNEL = 'chunking-host:ensure-started';
export const CHUNKING_HOST_STOP_CHANNEL = 'chunking-host:stop';
export const CHUNKING_HOST_RESET_CHANNEL = 'chunking-host:reset';
export const CHUNKING_HOST_GET_STATUS_CHANNEL = 'chunking-host:get-status';
export const CHUNKING_HOST_CHUNK_FILE_CHANNEL = 'chunking-host:chunk-file';
export const CHUNKING_HOST_CHUNK_BATCH_CHANNEL = 'chunking-host:chunk-batch';

export type ChunkingHostLifecycleState = 'stopped' | 'starting' | 'running' | 'stopping' | 'error';

export type ChunkingHostChunkingStrategy = 'sentence' | 'token' | 'recursive';

export interface ChunkingHostRequestOptions {
  readonly strategy: ChunkingHostChunkingStrategy;
  readonly [key: string]: unknown;
}

export interface ChunkingHostStatus {
  readonly active: boolean;
  readonly lastError: string | null;
  readonly state: ChunkingHostLifecycleState;
}

export interface ChunkingHostStatusReport {
  readonly active: boolean;
  readonly lastError: string | null;
  readonly state: Exclude<ChunkingHostLifecycleState, 'stopping'>;
}

export interface ChunkingHostFilePayload {
  readonly content: string;
  readonly fileName: string;
  readonly filePath: string;
  readonly fileRecordId: string;
}

export interface ChunkingHostChunkFileRequest extends ChunkingHostFilePayload {
  readonly kind: 'chunk-file';
  readonly options: ChunkingHostRequestOptions;
  readonly requestId: string;
}

export interface ChunkingHostChunkBatchRequest {
  readonly files: readonly ChunkingHostFilePayload[];
  readonly kind: 'chunk-batch';
  readonly options: ChunkingHostRequestOptions;
  readonly requestId: string;
}

export type ChunkingHostRequest = ChunkingHostChunkBatchRequest | ChunkingHostChunkFileRequest;

export interface ChunkingHostProgressReport {
  readonly chunksCreated: number;
  readonly currentIndex?: number;
  readonly fileRecordId: string;
  readonly requestId: string;
  readonly totalFiles?: number;
  readonly type: 'progress';
}

export interface ChunkingHostFileCompleteReport {
  readonly fileRecordId: string;
  readonly requestId: string;
  readonly result: unknown;
  readonly type: 'file-complete';
}

export interface ChunkingHostFileErrorReport {
  readonly error: string;
  readonly fileRecordId: string;
  readonly requestId: string;
  readonly type: 'file-error';
}

export interface ChunkingHostResultReport {
  readonly requestId: string;
  readonly result: unknown;
  readonly type: 'result';
}

export interface ChunkingHostBatchCompleteReport {
  readonly requestId: string;
  readonly results: readonly unknown[];
  readonly type: 'batch-complete';
}

export interface ChunkingHostErrorReport {
  readonly error: string;
  readonly fileRecordId?: string;
  readonly requestId: string;
  readonly type: 'error';
}

export type ChunkingHostProgressEvent =
  | ChunkingHostFileCompleteReport
  | ChunkingHostFileErrorReport
  | ChunkingHostProgressReport;

export type ChunkingHostResponseReport =
  | ChunkingHostBatchCompleteReport
  | ChunkingHostErrorReport
  | ChunkingHostFileCompleteReport
  | ChunkingHostFileErrorReport
  | ChunkingHostProgressReport
  | ChunkingHostResultReport;

export function createStoppedChunkingHostStatus(): ChunkingHostStatus {
  return {
    state: 'stopped',
    active: false,
    lastError: null,
  };
}
