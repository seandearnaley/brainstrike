import type {
  BackgroundRuntimeStatus,
  RuntimeErrorEnvelope,
  RuntimeProgressEnvelope,
  RuntimeRequestEnvelope,
  RuntimeResultEnvelope,
} from '@brainstrike/worker-runtime';
import { createStoppedBackgroundRuntimeStatus } from '@brainstrike/worker-runtime';

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

export type ChunkingHostChunkingStrategy = 'sentence' | 'token' | 'recursive';

export interface ChunkingHostRequestOptions {
  readonly allowLargeFiles?: boolean;
  readonly forceStrategy?: boolean;
  readonly ignoreFileTypeRecommendations?: boolean;
  readonly maxTokens?: number;
  readonly maxTokensCap?: number;
  readonly overlap?: number;
  readonly requestedStrategy?: ChunkingHostChunkingStrategy;
  readonly separators?: readonly string[];
  readonly tokenTrueSizing?: boolean;
}

export type ChunkingHostStatus = BackgroundRuntimeStatus<'chunking-host'>;
export type ChunkingHostStatusReport = BackgroundRuntimeStatus<'chunking-host'>;

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

export interface ChunkingHostChunkFileByIdRequest {
  readonly fileRecordId: string;
  readonly kind: 'chunk-file-by-id';
  readonly options: ChunkingHostRequestOptions;
  readonly requestId: string;
}

export interface ChunkingHostChunkBatchRequest {
  readonly files: readonly ChunkingHostFilePayload[];
  readonly kind: 'chunk-batch';
  readonly options: ChunkingHostRequestOptions;
  readonly requestId: string;
}

export type ChunkingHostRequestPayload =
  | ChunkingHostChunkBatchRequest
  | ChunkingHostChunkFileByIdRequest
  | ChunkingHostChunkFileRequest;
export type ChunkingHostRequest = RuntimeRequestEnvelope<'chunk', ChunkingHostRequestPayload>;

export interface ChunkingHostProgressReportPayload {
  readonly chunksCreated: number;
  readonly currentIndex?: number;
  readonly fileRecordId: string;
  readonly totalFiles?: number;
}

export interface ChunkingHostFileCompleteReportPayload {
  readonly fileRecordId: string;
  readonly result: unknown;
}

export interface ChunkingHostFileErrorReportPayload {
  readonly errorMessage: string;
  readonly fileRecordId: string;
}

export interface ChunkingHostResultReportPayload {
  readonly result: unknown;
}

export interface ChunkingHostBatchCompleteReportPayload {
  readonly results: readonly unknown[];
}

export interface ChunkingHostErrorReportPayload {
  readonly errorMessage: string;
  readonly fileRecordId?: string;
}

export type ChunkingHostProgressReport = RuntimeProgressEnvelope<
  'chunk',
  ChunkingHostProgressReportPayload
>;
export type ChunkingHostFileCompleteReport = RuntimeProgressEnvelope<
  'chunk-file-complete',
  ChunkingHostFileCompleteReportPayload
>;
export type ChunkingHostFileErrorReport = RuntimeProgressEnvelope<
  'chunk-file-error',
  ChunkingHostFileErrorReportPayload
>;
export type ChunkingHostResultReport = RuntimeResultEnvelope<
  'chunk-result',
  ChunkingHostResultReportPayload
>;
export type ChunkingHostBatchCompleteReport = RuntimeResultEnvelope<
  'chunk-batch-complete',
  ChunkingHostBatchCompleteReportPayload
>;
export type ChunkingHostErrorReport = RuntimeErrorEnvelope<'chunk-error'> & {
  readonly payload: RuntimeErrorEnvelope<'chunk-error'>['payload'] & ChunkingHostErrorReportPayload;
};

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

export const CHUNKING_HOST_STOPPED_RUNTIME_ID = 'chunking-host:stopped';

export function createStoppedChunkingHostStatus(
  runtimeId: string = CHUNKING_HOST_STOPPED_RUNTIME_ID
): ChunkingHostStatus {
  return createStoppedBackgroundRuntimeStatus('chunking-host', runtimeId);
}
