import type { ChunkingStrategy } from '@brainstrike/text-splitter';
import type {
  BackgroundRuntimeStatus,
  RuntimeEnvelopeObjectPayloadBase,
  RuntimeErrorEnvelope,
  RuntimeProgressEnvelope,
  RuntimeRequestEnvelope,
  RuntimeRequestPayloadBase,
  RuntimeResultEnvelope,
} from '@brainstrike/worker-runtime';
import {
  assertRuntimeObjectPayloadEnvelope,
  assertRuntimeRequestPayloadBase,
  createBackgroundRuntimeDescriptor,
  serializeRuntimeError,
} from '@brainstrike/worker-runtime';

export const CHUNKING_HOST_RUNTIME = createBackgroundRuntimeDescriptor('chunking-host');
export const CHUNKING_HOST_LIFECYCLE_CHANNELS = CHUNKING_HOST_RUNTIME.lifecycleChannels;
const CHUNKING_HOST_CHANNELS = CHUNKING_HOST_RUNTIME.createScopedChannels({
  chunkBatch: 'chunk-batch',
  chunkFile: 'chunk-file',
  progress: 'progress',
  reportResponse: 'report-response',
  request: 'request',
});
export const CHUNKING_HOST_STATUS_EVENT = CHUNKING_HOST_LIFECYCLE_CHANNELS.statusEvent;
export const CHUNKING_HOST_REQUEST_EVENT = CHUNKING_HOST_CHANNELS.request;
export const CHUNKING_HOST_PROGRESS_EVENT = CHUNKING_HOST_CHANNELS.progress;
export const CHUNKING_HOST_REPORT_STATUS_CHANNEL = CHUNKING_HOST_LIFECYCLE_CHANNELS.reportStatus;
export const CHUNKING_HOST_REPORT_RESPONSE_CHANNEL = CHUNKING_HOST_CHANNELS.reportResponse;
export const CHUNKING_HOST_ENSURE_STARTED_CHANNEL = CHUNKING_HOST_LIFECYCLE_CHANNELS.ensureStarted;
export const CHUNKING_HOST_STOP_CHANNEL = CHUNKING_HOST_LIFECYCLE_CHANNELS.stop;
export const CHUNKING_HOST_RESET_CHANNEL = CHUNKING_HOST_LIFECYCLE_CHANNELS.reset;
export const CHUNKING_HOST_GET_STATUS_CHANNEL = CHUNKING_HOST_LIFECYCLE_CHANNELS.getStatus;
export const CHUNKING_HOST_CHUNK_FILE_CHANNEL = CHUNKING_HOST_CHANNELS.chunkFile;
export const CHUNKING_HOST_CHUNK_BATCH_CHANNEL = CHUNKING_HOST_CHANNELS.chunkBatch;

export type ChunkingHostChunkingStrategy = ChunkingStrategy;

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

export const CHUNKING_HOST_STATUS_ADAPTER = CHUNKING_HOST_RUNTIME.statusAdapter;
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

type MutableChunkingRequestOptions = Record<string, unknown>;

function assertFilePayload(value: unknown, fieldName: string): ChunkingHostFilePayload {
  if (!value || typeof value !== 'object') {
    throw new Error(`${fieldName} must be an object.`);
  }
  const candidate = value as Record<string, unknown>;
  if (
    typeof candidate['fileRecordId'] !== 'string' ||
    candidate['fileRecordId'].trim().length === 0
  ) {
    throw new Error(`${fieldName}.fileRecordId must be a non-empty string.`);
  }
  if (typeof candidate['content'] !== 'string') {
    throw new Error(`${fieldName}.content must be a string.`);
  }
  if (typeof candidate['fileName'] !== 'string' || candidate['fileName'].trim().length === 0) {
    throw new Error(`${fieldName}.fileName must be a non-empty string.`);
  }
  if (typeof candidate['filePath'] !== 'string' || candidate['filePath'].trim().length === 0) {
    throw new Error(`${fieldName}.filePath must be a non-empty string.`);
  }
  return {
    content: candidate['content'],
    fileName: candidate['fileName'],
    filePath: candidate['filePath'],
    fileRecordId: candidate['fileRecordId'],
  };
}

function readOptionalBooleanOption(
  candidate: Record<string, unknown>,
  options: MutableChunkingRequestOptions,
  key: keyof ChunkingHostChunkFileRequest['options']
): void {
  const value = candidate[key];
  if (value === undefined) {
    return;
  }
  if (typeof value !== 'boolean') {
    throw new Error(`Chunking host request options ${String(key)} must be boolean when set.`);
  }
  options[key] = value;
}

function readOptionalNumberOption(
  candidate: Record<string, unknown>,
  options: MutableChunkingRequestOptions,
  key: 'maxTokens' | 'maxTokensCap' | 'overlap'
): void {
  const value = candidate[key];
  if (value === undefined) {
    return;
  }
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`Chunking host request options ${key} must be a finite number when set.`);
  }
  if ((key === 'maxTokens' || key === 'maxTokensCap') && value <= 0) {
    throw new Error(`Chunking host request options ${key} must be greater than zero when set.`);
  }
  if (key === 'overlap' && value < 0) {
    throw new Error('Chunking host request options overlap must be non-negative when set.');
  }
  options[key] = value;
}

function readOptionalStrategyOption(
  candidate: Record<string, unknown>,
  options: MutableChunkingRequestOptions
): void {
  const requestedStrategy = candidate['requestedStrategy'];
  if (requestedStrategy === undefined) {
    return;
  }
  if (
    requestedStrategy !== 'auto' &&
    requestedStrategy !== 'character' &&
    requestedStrategy !== 'sentence' &&
    requestedStrategy !== 'token' &&
    requestedStrategy !== 'recursive' &&
    requestedStrategy !== 'markdown' &&
    requestedStrategy !== 'semantic-markdown' &&
    requestedStrategy !== 'html' &&
    requestedStrategy !== 'json' &&
    requestedStrategy !== 'latex'
  ) {
    throw new Error('Chunking host request options has invalid requestedStrategy.');
  }
  options['requestedStrategy'] = requestedStrategy;
}

function readOptionalSeparatorsOption(
  candidate: Record<string, unknown>,
  options: MutableChunkingRequestOptions
): void {
  const separators = candidate['separators'];
  if (separators === undefined) {
    return;
  }
  if (!Array.isArray(separators) || separators.some((separator) => typeof separator !== 'string')) {
    throw new Error('Chunking host request options separators must be a string array when set.');
  }
  options['separators'] = [...separators];
}

function assertChunkingRequestOptions(value: unknown): ChunkingHostChunkFileRequest['options'] {
  if (!value || typeof value !== 'object') {
    throw new Error('Chunking host request options must be an object.');
  }
  const candidate = value as Record<string, unknown>;
  const options: MutableChunkingRequestOptions = {};

  readOptionalStrategyOption(candidate, options);
  readOptionalBooleanOption(candidate, options, 'forceStrategy');
  readOptionalBooleanOption(candidate, options, 'ignoreFileTypeRecommendations');
  readOptionalBooleanOption(candidate, options, 'tokenTrueSizing');
  readOptionalBooleanOption(candidate, options, 'allowLargeFiles');
  readOptionalNumberOption(candidate, options, 'maxTokens');
  readOptionalNumberOption(candidate, options, 'maxTokensCap');
  readOptionalNumberOption(candidate, options, 'overlap');
  readOptionalSeparatorsOption(candidate, options);

  return options as ChunkingHostChunkFileRequest['options'];
}

function assertChunkFileRequest(value: unknown): ChunkingHostChunkFileRequest {
  const { requestBase } = assertRuntimeRequestPayloadBase(
    value,
    'Chunking host chunk-file request',
    'chunk-file'
  );
  return {
    ...requestBase,
    ...assertFilePayload(value, 'chunkFileRequest'),
    options: assertChunkingRequestOptions((value as Record<string, unknown>)['options']),
  };
}

function assertChunkFileByIdRequest(value: unknown): ChunkingHostChunkFileByIdRequest {
  const { candidate, requestBase } = assertRuntimeRequestPayloadBase(
    value,
    'Chunking host chunk-file-by-id request',
    'chunk-file-by-id'
  );
  if (
    typeof candidate['fileRecordId'] !== 'string' ||
    candidate['fileRecordId'].trim().length === 0
  ) {
    throw new Error(
      'Chunking host chunk-file-by-id request must include a non-empty fileRecordId.'
    );
  }
  return {
    ...requestBase,
    fileRecordId: candidate['fileRecordId'],
    options: assertChunkingRequestOptions(candidate['options']),
  };
}

export function isChunkingHostRequestPayloadBase(
  payload: unknown
): payload is RuntimeRequestPayloadBase<'chunk-file' | 'chunk-file-by-id' | 'chunk-batch'> {
  return (
    !!payload &&
    typeof payload === 'object' &&
    typeof (payload as Record<string, unknown>)['kind'] === 'string'
  );
}

export function assertChunkingHostChunkFileRequestPayload(
  value: unknown
): ChunkingHostChunkFileByIdRequest | ChunkingHostChunkFileRequest {
  if (isChunkingHostRequestPayloadBase(value) && value.kind === 'chunk-file-by-id') {
    return assertChunkFileByIdRequest(value);
  }
  return assertChunkFileRequest(value);
}

export function assertChunkingHostChunkBatchRequestPayload(
  value: unknown
): ChunkingHostChunkBatchRequest {
  const { candidate, requestBase } = assertRuntimeRequestPayloadBase(
    value,
    'Chunking host chunk-batch request',
    'chunk-batch'
  );
  if (!Array.isArray(candidate['files']) || candidate['files'].length === 0) {
    throw new Error('Chunking host chunk-batch request must include at least one file.');
  }
  return {
    ...requestBase,
    files: candidate['files'].map((entry: unknown, index: number) =>
      assertFilePayload(entry, `files[${index}]`)
    ),
    options: assertChunkingRequestOptions(candidate['options']),
  };
}

function assertChunkProgressPayload(
  payload: Record<string, unknown>
): ChunkingHostProgressReportPayload {
  if (typeof payload['fileRecordId'] !== 'string' || typeof payload['chunksCreated'] !== 'number') {
    throw new Error('Chunking host progress payload is invalid.');
  }
  return {
    chunksCreated: payload['chunksCreated'],
    fileRecordId: payload['fileRecordId'],
    ...(typeof payload['currentIndex'] === 'number'
      ? { currentIndex: payload['currentIndex'] }
      : {}),
    ...(typeof payload['totalFiles'] === 'number' ? { totalFiles: payload['totalFiles'] } : {}),
  };
}

function assertChunkFileCompletePayload(
  payload: Record<string, unknown>
): ChunkingHostFileCompleteReportPayload {
  if (typeof payload['fileRecordId'] !== 'string') {
    throw new Error('Chunking host file-complete payload is invalid.');
  }
  return {
    fileRecordId: payload['fileRecordId'],
    result: payload['result'],
  };
}

function assertChunkFileErrorPayload(
  payload: Record<string, unknown>
): ChunkingHostFileErrorReportPayload {
  if (typeof payload['fileRecordId'] !== 'string' || typeof payload['errorMessage'] !== 'string') {
    throw new Error('Chunking host file-error payload is invalid.');
  }
  return {
    errorMessage: payload['errorMessage'],
    fileRecordId: payload['fileRecordId'],
  };
}

function assertChunkBatchCompletePayload(
  payload: Record<string, unknown>
): ChunkingHostBatchCompleteReportPayload {
  if (!Array.isArray(payload['results'])) {
    throw new Error('Chunking host batch-complete payload must include results array.');
  }
  return {
    results: payload['results'].map((result: unknown, index: number) =>
      assertChunkResultValue(result, `Chunking host batch-complete payload results[${index}]`)
    ),
  };
}

function assertChunkResultValue(value: unknown, context: string): unknown {
  if (!value || typeof value !== 'object') {
    throw new Error(`${context} must be an object.`);
  }
  const candidate = value as Record<string, unknown>;
  if (candidate['type'] !== 'result') {
    throw new Error(`${context} must declare type="result".`);
  }
  if (typeof candidate['id'] !== 'string' || candidate['id'].trim().length === 0) {
    throw new Error(`${context} must include a non-empty id.`);
  }
  if (
    typeof candidate['fileRecordId'] !== 'string' ||
    candidate['fileRecordId'].trim().length === 0
  ) {
    throw new Error(`${context} must include a non-empty fileRecordId.`);
  }
  if (!Array.isArray(candidate['chunks'])) {
    throw new Error(`${context} must include a chunks array.`);
  }
  if (typeof candidate['skipped'] !== 'boolean') {
    throw new Error(`${context} must include a boolean skipped flag.`);
  }
  if (
    typeof candidate['strategyUsed'] !== 'string' ||
    candidate['strategyUsed'].trim().length === 0
  ) {
    throw new Error(`${context} must include a non-empty strategyUsed.`);
  }
  if (typeof candidate['totalTokens'] !== 'number' || !Number.isFinite(candidate['totalTokens'])) {
    throw new Error(`${context} must include a finite totalTokens number.`);
  }
  return candidate;
}

function assertChunkResultPayload(
  payload: Record<string, unknown>
): ChunkingHostResultReportPayload {
  if (!('result' in payload)) {
    throw new Error('Chunking host result payload must include result.');
  }
  return {
    result: assertChunkResultValue(payload['result'], 'Chunking host result payload result'),
  };
}

function createChunkingHostErrorPayload(
  payload: Record<string, unknown>
): ChunkingHostErrorReport['payload'] {
  if (typeof payload['message'] !== 'string') {
    throw new Error('Chunking host error payload must include message string.');
  }
  const fileRecordId = payload['fileRecordId'];
  return {
    ...serializeRuntimeError(payload['message']),
    ...(typeof fileRecordId === 'string' ? { fileRecordId } : {}),
    errorMessage: payload['message'],
  };
}

function assertChunkingHostProgressReport(
  envelopeBase: RuntimeEnvelopeObjectPayloadBase,
  payload: Record<string, unknown>
): ChunkingHostResponseReport {
  switch (envelopeBase.channel) {
    case 'chunk':
      return {
        ...envelopeBase,
        channel: envelopeBase.channel,
        payload: assertChunkProgressPayload(payload),
        type: 'progress',
      };
    case 'chunk-file-complete':
      return {
        ...envelopeBase,
        channel: envelopeBase.channel,
        payload: assertChunkFileCompletePayload(payload),
        type: 'progress',
      };
    case 'chunk-file-error':
      return {
        ...envelopeBase,
        channel: envelopeBase.channel,
        payload: assertChunkFileErrorPayload(payload),
        type: 'progress',
      };
    default:
      throw new Error('Chunking host progress report has invalid channel.');
  }
}

function assertChunkingHostResultReport(
  envelopeBase: RuntimeEnvelopeObjectPayloadBase,
  payload: Record<string, unknown>
): ChunkingHostResponseReport {
  switch (envelopeBase.channel) {
    case 'chunk-result':
      return {
        ...envelopeBase,
        channel: envelopeBase.channel,
        payload: assertChunkResultPayload(payload),
        type: 'result',
      };
    case 'chunk-batch-complete':
      return {
        ...envelopeBase,
        channel: envelopeBase.channel,
        payload: assertChunkBatchCompletePayload(payload),
        type: 'result',
      };
    default:
      throw new Error('Chunking host result report has invalid channel.');
  }
}

export function assertChunkingHostResponseReport(value: unknown): ChunkingHostResponseReport {
  const { envelopeBase, payload } = assertRuntimeObjectPayloadEnvelope(
    value,
    'Chunking host response report'
  );
  switch (envelopeBase.type) {
    case 'progress':
      return assertChunkingHostProgressReport(envelopeBase, payload);
    case 'result':
      return assertChunkingHostResultReport(envelopeBase, payload);
    case 'error':
      return {
        ...envelopeBase,
        channel: 'chunk-error',
        payload: createChunkingHostErrorPayload(payload),
        type: 'error',
      } satisfies Extract<ChunkingHostResponseReport, { type: 'error' }>;
    default:
      throw new Error('Chunking host response report has invalid envelope type.');
  }
}

export function assertChunkingHostStatusReport(value: unknown): ChunkingHostStatusReport {
  return CHUNKING_HOST_STATUS_ADAPTER.assertStatus(value);
}

export const CHUNKING_HOST_STOPPED_RUNTIME_ID = CHUNKING_HOST_RUNTIME.stoppedRuntimeId;

export function createStoppedChunkingHostStatus(
  runtimeId: string = CHUNKING_HOST_STOPPED_RUNTIME_ID
): ChunkingHostStatus {
  return CHUNKING_HOST_RUNTIME.createStoppedStatus(runtimeId);
}
