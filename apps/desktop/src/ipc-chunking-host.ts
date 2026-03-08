import { assertBackgroundRuntimeStatus, serializeRuntimeError } from '@brainstrike/worker-runtime';
import { type IpcMainEvent, type IpcMainInvokeEvent, ipcMain } from 'electron';
import type { ChunkingHostManager } from './chunking-host-manager';
import type {
  ChunkingHostBatchCompleteReportPayload,
  ChunkingHostChunkBatchRequest,
  ChunkingHostChunkFileByIdRequest,
  ChunkingHostChunkFileRequest,
  ChunkingHostErrorReport,
  ChunkingHostFileCompleteReportPayload,
  ChunkingHostFileErrorReportPayload,
  ChunkingHostFilePayload,
  ChunkingHostProgressReportPayload,
  ChunkingHostResponseReport,
  ChunkingHostResultReportPayload,
  ChunkingHostStatusReport,
} from './chunking-host-shared';
import {
  CHUNKING_HOST_CHUNK_BATCH_CHANNEL,
  CHUNKING_HOST_CHUNK_FILE_CHANNEL,
  CHUNKING_HOST_ENSURE_STARTED_CHANNEL,
  CHUNKING_HOST_GET_STATUS_CHANNEL,
  CHUNKING_HOST_REPORT_RESPONSE_CHANNEL,
  CHUNKING_HOST_REPORT_STATUS_CHANNEL,
  CHUNKING_HOST_RESET_CHANNEL,
  CHUNKING_HOST_STOP_CHANNEL,
} from './chunking-host-shared';

function assertChunkingHostStatusReport(value: unknown): ChunkingHostStatusReport {
  return assertBackgroundRuntimeStatus(value, 'chunking-host') as ChunkingHostStatusReport;
}

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
    fileRecordId: candidate['fileRecordId'],
    content: candidate['content'],
    fileName: candidate['fileName'],
    filePath: candidate['filePath'],
  };
}

type MutableChunkingRequestOptions = Record<string, unknown>;

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
  if (typeof value !== 'number') {
    throw new Error(`Chunking host request options ${key} must be numeric when set.`);
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
    requestedStrategy !== 'sentence' &&
    requestedStrategy !== 'token' &&
    requestedStrategy !== 'recursive'
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
  if (!value || typeof value !== 'object') {
    throw new Error('Chunking host chunk-file request must be an object.');
  }
  const candidate = value as Record<string, unknown>;
  if (candidate['kind'] !== 'chunk-file') {
    throw new Error('Chunking host chunk-file request must declare kind="chunk-file".');
  }
  if (typeof candidate['requestId'] !== 'string' || candidate['requestId'].trim().length === 0) {
    throw new Error('Chunking host chunk-file request must include a non-empty requestId.');
  }
  return {
    kind: 'chunk-file',
    requestId: candidate['requestId'],
    ...assertFilePayload(value, 'chunkFileRequest'),
    options: assertChunkingRequestOptions(candidate['options']),
  };
}

function assertChunkFileByIdRequest(value: unknown): ChunkingHostChunkFileByIdRequest {
  if (!value || typeof value !== 'object') {
    throw new Error('Chunking host chunk-file-by-id request must be an object.');
  }
  const candidate = value as Record<string, unknown>;
  if (candidate['kind'] !== 'chunk-file-by-id') {
    throw new Error('Chunking host chunk-file-by-id request must declare kind="chunk-file-by-id".');
  }
  if (typeof candidate['requestId'] !== 'string' || candidate['requestId'].trim().length === 0) {
    throw new Error('Chunking host chunk-file-by-id request must include a non-empty requestId.');
  }
  if (
    typeof candidate['fileRecordId'] !== 'string' ||
    candidate['fileRecordId'].trim().length === 0
  ) {
    throw new Error(
      'Chunking host chunk-file-by-id request must include a non-empty fileRecordId.'
    );
  }
  return {
    kind: 'chunk-file-by-id',
    requestId: candidate['requestId'],
    fileRecordId: candidate['fileRecordId'],
    options: assertChunkingRequestOptions(candidate['options']),
  };
}

function assertChunkBatchRequest(value: unknown): ChunkingHostChunkBatchRequest {
  if (!value || typeof value !== 'object') {
    throw new Error('Chunking host chunk-batch request must be an object.');
  }
  const candidate = value as Record<string, unknown>;
  if (candidate['kind'] !== 'chunk-batch') {
    throw new Error('Chunking host chunk-batch request must declare kind="chunk-batch".');
  }
  if (typeof candidate['requestId'] !== 'string' || candidate['requestId'].trim().length === 0) {
    throw new Error('Chunking host chunk-batch request must include a non-empty requestId.');
  }
  if (!Array.isArray(candidate['files']) || candidate['files'].length === 0) {
    throw new Error('Chunking host chunk-batch request must include at least one file.');
  }
  return {
    kind: 'chunk-batch',
    requestId: candidate['requestId'],
    files: candidate['files'].map((entry, index) => assertFilePayload(entry, `files[${index}]`)),
    options: assertChunkingRequestOptions(candidate['options']),
  };
}

interface ChunkingHostEnvelopeBase {
  readonly channel: string;
  readonly requestId: string;
  readonly runtimeId: string;
}

function assertChunkingHostEnvelopeBase(value: unknown): {
  readonly candidate: Record<string, unknown>;
  readonly envelopeBase: ChunkingHostEnvelopeBase;
  readonly payload: Record<string, unknown>;
} {
  if (!value || typeof value !== 'object') {
    throw new Error('Chunking host response report must be an object.');
  }
  const candidate = value as Record<string, unknown>;
  if (typeof candidate['requestId'] !== 'string' || candidate['requestId'].trim().length === 0) {
    throw new Error('Chunking host response report must include a non-empty requestId.');
  }
  if (typeof candidate['runtimeId'] !== 'string' || candidate['runtimeId'].trim().length === 0) {
    throw new Error('Chunking host response report must include a non-empty runtimeId.');
  }
  if (typeof candidate['channel'] !== 'string' || candidate['channel'].trim().length === 0) {
    throw new Error('Chunking host response report must include a non-empty channel.');
  }
  const payload = candidate['payload'];
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('Chunking host response report must include a payload object.');
  }
  return {
    candidate,
    envelopeBase: {
      channel: candidate['channel'],
      requestId: candidate['requestId'],
      runtimeId: candidate['runtimeId'],
    },
    payload: payload as Record<string, unknown>,
  };
}

function assertChunkProgressPayload(
  payload: Record<string, unknown>
): ChunkingHostProgressReportPayload {
  if (typeof payload['fileRecordId'] !== 'string' || typeof payload['chunksCreated'] !== 'number') {
    throw new Error('Chunking host progress payload is invalid.');
  }
  return {
    fileRecordId: payload['fileRecordId'],
    chunksCreated: payload['chunksCreated'],
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
    fileRecordId: payload['fileRecordId'],
    errorMessage: payload['errorMessage'],
  };
}

function assertChunkBatchCompletePayload(
  payload: Record<string, unknown>
): ChunkingHostBatchCompleteReportPayload {
  if (!Array.isArray(payload['results'])) {
    throw new Error('Chunking host batch-complete payload must include results array.');
  }
  return {
    results: payload['results'],
  };
}

function assertChunkResultPayload(
  payload: Record<string, unknown>
): ChunkingHostResultReportPayload {
  if (!('result' in payload)) {
    throw new Error('Chunking host result payload must include result.');
  }
  return {
    result: payload['result'],
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
  envelopeBase: ChunkingHostEnvelopeBase,
  channel: string,
  payload: Record<string, unknown>
): ChunkingHostResponseReport {
  switch (channel) {
    case 'chunk':
      return {
        ...envelopeBase,
        type: 'progress',
        channel,
        payload: assertChunkProgressPayload(payload),
      };
    case 'chunk-file-complete':
      return {
        ...envelopeBase,
        type: 'progress',
        channel,
        payload: assertChunkFileCompletePayload(payload),
      };
    case 'chunk-file-error':
      return {
        ...envelopeBase,
        type: 'progress',
        channel,
        payload: assertChunkFileErrorPayload(payload),
      };
    default:
      throw new Error('Chunking host progress report has invalid channel.');
  }
}

function assertChunkingHostResultReport(
  envelopeBase: ChunkingHostEnvelopeBase,
  channel: string,
  payload: Record<string, unknown>
): ChunkingHostResponseReport {
  switch (channel) {
    case 'chunk-result':
      return {
        ...envelopeBase,
        type: 'result',
        channel,
        payload: assertChunkResultPayload(payload),
      };
    case 'chunk-batch-complete':
      return {
        ...envelopeBase,
        type: 'result',
        channel,
        payload: assertChunkBatchCompletePayload(payload),
      };
    default:
      throw new Error('Chunking host result report has invalid channel.');
  }
}

function assertChunkingHostResponseReport(value: unknown): ChunkingHostResponseReport {
  const { candidate, envelopeBase, payload } = assertChunkingHostEnvelopeBase(value);
  switch (candidate['type']) {
    case 'progress':
      return assertChunkingHostProgressReport(envelopeBase, envelopeBase.channel, payload);
    case 'result':
      return assertChunkingHostResultReport(envelopeBase, envelopeBase.channel, payload);
    case 'error':
      return {
        ...envelopeBase,
        type: 'error',
        channel: 'chunk-error',
        payload: createChunkingHostErrorPayload(payload),
      } satisfies Extract<ChunkingHostResponseReport, { type: 'error' }>;
    default:
      throw new Error('Chunking host response report has invalid envelope type.');
  }
}

export function registerChunkingHostIpcHandlers(manager: ChunkingHostManager): () => void {
  ipcMain.handle(CHUNKING_HOST_ENSURE_STARTED_CHANNEL, async () =>
    manager.ensureStarted({ waitForRunning: true })
  );
  ipcMain.handle(CHUNKING_HOST_STOP_CHANNEL, async () => manager.stop());
  ipcMain.handle(CHUNKING_HOST_RESET_CHANNEL, async () => manager.reset());
  ipcMain.handle(CHUNKING_HOST_GET_STATUS_CHANNEL, async () => manager.getStatus());
  ipcMain.handle(
    CHUNKING_HOST_CHUNK_FILE_CHANNEL,
    async (event: IpcMainInvokeEvent, payload: unknown) =>
      manager.chunkFile(
        event.sender.id,
        (() => {
          if (
            payload &&
            typeof payload === 'object' &&
            (payload as Record<string, unknown>)['kind'] === 'chunk-file-by-id'
          ) {
            return assertChunkFileByIdRequest(payload);
          }
          return assertChunkFileRequest(payload);
        })()
      )
  );
  ipcMain.handle(
    CHUNKING_HOST_CHUNK_BATCH_CHANNEL,
    async (event: IpcMainInvokeEvent, payload: unknown) =>
      manager.chunkBatch(event.sender.id, assertChunkBatchRequest(payload))
  );
  ipcMain.on(CHUNKING_HOST_REPORT_STATUS_CHANNEL, (event: IpcMainEvent, payload: unknown) => {
    manager.acceptStatusReport(event.sender.id, assertChunkingHostStatusReport(payload));
  });
  ipcMain.on(CHUNKING_HOST_REPORT_RESPONSE_CHANNEL, (event: IpcMainEvent, payload: unknown) => {
    manager.acceptResponseReport(event.sender.id, assertChunkingHostResponseReport(payload));
  });

  return () => {
    ipcMain.removeHandler(CHUNKING_HOST_ENSURE_STARTED_CHANNEL);
    ipcMain.removeHandler(CHUNKING_HOST_STOP_CHANNEL);
    ipcMain.removeHandler(CHUNKING_HOST_RESET_CHANNEL);
    ipcMain.removeHandler(CHUNKING_HOST_GET_STATUS_CHANNEL);
    ipcMain.removeHandler(CHUNKING_HOST_CHUNK_FILE_CHANNEL);
    ipcMain.removeHandler(CHUNKING_HOST_CHUNK_BATCH_CHANNEL);
    ipcMain.removeAllListeners(CHUNKING_HOST_REPORT_STATUS_CHANNEL);
    ipcMain.removeAllListeners(CHUNKING_HOST_REPORT_RESPONSE_CHANNEL);
  };
}
