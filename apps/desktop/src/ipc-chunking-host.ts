import { type IpcMainEvent, type IpcMainInvokeEvent, ipcMain } from 'electron';
import type { ChunkingHostManager } from './chunking-host-manager';
import type {
  ChunkingHostChunkBatchRequest,
  ChunkingHostChunkFileRequest,
  ChunkingHostFilePayload,
  ChunkingHostResponseReport,
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
  if (!value || typeof value !== 'object') {
    throw new Error('Chunking host status report must be an object.');
  }
  const candidate = value as Record<string, unknown>;
  if (
    candidate['state'] !== 'starting' &&
    candidate['state'] !== 'running' &&
    candidate['state'] !== 'stopped' &&
    candidate['state'] !== 'error'
  ) {
    throw new Error('Chunking host status report has invalid state.');
  }
  if (typeof candidate['active'] !== 'boolean') {
    throw new Error('Chunking host status report must include active boolean.');
  }
  if (candidate['lastError'] !== null && typeof candidate['lastError'] !== 'string') {
    throw new Error('Chunking host status report must include string or null lastError.');
  }
  return {
    state: candidate['state'],
    active: candidate['active'],
    lastError: candidate['lastError'],
  } as ChunkingHostStatusReport;
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

function assertChunkingRequestOptions(value: unknown): ChunkingHostChunkFileRequest['options'] {
  if (!value || typeof value !== 'object') {
    throw new Error('Chunking host request options must be an object.');
  }
  const candidate = value as Record<string, unknown>;
  const strategy = candidate['strategy'];
  if (strategy !== 'sentence' && strategy !== 'token' && strategy !== 'recursive') {
    throw new Error('Chunking host request options must include a valid strategy.');
  }
  return value as ChunkingHostChunkFileRequest['options'];
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

function assertChunkingHostResponseReport(value: unknown): ChunkingHostResponseReport {
  if (!value || typeof value !== 'object') {
    throw new Error('Chunking host response report must be an object.');
  }
  const candidate = value as Record<string, unknown>;
  if (typeof candidate['requestId'] !== 'string' || candidate['requestId'].trim().length === 0) {
    throw new Error('Chunking host response report must include a non-empty requestId.');
  }
  switch (candidate['type']) {
    case 'progress':
      if (
        typeof candidate['fileRecordId'] !== 'string' ||
        typeof candidate['chunksCreated'] !== 'number'
      ) {
        throw new Error('Chunking host progress report is invalid.');
      }
      return value as ChunkingHostResponseReport;
    case 'file-complete':
      if (typeof candidate['fileRecordId'] !== 'string' || !candidate['result']) {
        throw new Error('Chunking host file-complete report is invalid.');
      }
      return value as ChunkingHostResponseReport;
    case 'file-error':
      if (typeof candidate['fileRecordId'] !== 'string' || typeof candidate['error'] !== 'string') {
        throw new Error('Chunking host file-error report is invalid.');
      }
      return value as ChunkingHostResponseReport;
    case 'result':
      if (!candidate['result']) {
        throw new Error('Chunking host result report must include a result.');
      }
      return value as ChunkingHostResponseReport;
    case 'batch-complete':
      if (!Array.isArray(candidate['results'])) {
        throw new Error('Chunking host batch-complete report must include results array.');
      }
      return value as ChunkingHostResponseReport;
    case 'error':
      if (typeof candidate['error'] !== 'string') {
        throw new Error('Chunking host error report must include an error string.');
      }
      return value as ChunkingHostResponseReport;
    default:
      throw new Error('Chunking host response report has invalid type.');
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
      manager.chunkFile(event.sender.id, assertChunkFileRequest(payload))
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
