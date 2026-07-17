import type { ChunkingRequestOptions, ChunkResult } from '@brainstrike/file-import';
import { getChunkingStrategy, useChunkingWorkerContext } from '@brainstrike/file-import';
import { createLogger } from '@brainstrike/utils/logger';
import { serializeRuntimeError } from '@brainstrike/worker-runtime';
import { useEffect, useRef } from 'react';
import type {
  ChunkingHostChunkFileByIdRequest,
  ChunkingHostRequest,
  ChunkingHostRequestOptions,
  ChunkingHostResponseReport,
  ChunkingHostStatus,
} from '../../chunking-host-shared';

const logger = createLogger('ChunkingHostRuntime');
const CHUNKING_HOST_REQUEST_HEARTBEAT_MS = 10_000;

function getChunkingHostBridge(): {
  onRequest?: (callback: (request: ChunkingHostRequest) => void) => () => void;
  reportResponse?: (response: ChunkingHostResponseReport) => void;
  reportStatus?: (status: ChunkingHostStatus) => void;
} | null {
  const hostWindow = window as Window & {
    chunkingHost?: {
      onRequest?: (callback: (request: ChunkingHostRequest) => void) => () => void;
      reportResponse?: (response: ChunkingHostResponseReport) => void;
      reportStatus?: (status: ChunkingHostStatus) => void;
    };
  };
  return hostWindow.chunkingHost ?? null;
}

function reportStatus(status: ChunkingHostStatus): void {
  getChunkingHostBridge()?.reportStatus?.(status);
}

function reportResponse(response: ChunkingHostResponseReport): void {
  getChunkingHostBridge()?.reportResponse?.(response);
}

function getHeartbeatFileRecordId(request: ChunkingHostRequest): string {
  const payload = request.payload;
  if (payload.kind === 'chunk-batch') {
    return payload.files[0]?.fileRecordId ?? request.requestId;
  }
  return payload.fileRecordId;
}

function getHeartbeatTotalFiles(request: ChunkingHostRequest): number {
  return request.payload.kind === 'chunk-batch' ? request.payload.files.length : 1;
}

function reportRequestHeartbeat(request: ChunkingHostRequest, runtimeId: string): void {
  reportResponse({
    channel: 'chunk',
    payload: {
      chunksCreated: 0,
      currentIndex: 0,
      fileRecordId: getHeartbeatFileRecordId(request),
      totalFiles: getHeartbeatTotalFiles(request),
    },
    requestId: request.requestId,
    runtimeId,
    type: 'progress',
  });
}

function resolveChunkingHostRuntimeId(): string {
  const runtimeId = new URLSearchParams(window.location.search).get('runtimeId');
  if (!(runtimeId && runtimeId.trim().length > 0)) {
    throw new Error('Chunking host renderer requires a runtimeId query parameter.');
  }
  return runtimeId;
}

interface FileRecordRow {
  content: string;
  name: string;
  path: string;
}

function getElectronDbQuery():
  | ((sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }>)
  | null {
  const api = (
    window as Window & {
      electronAPI?: {
        db?: {
          query?: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }>;
        };
      };
    }
  ).electronAPI;
  return api?.db?.query ?? null;
}

async function loadFileRecordById(fileRecordId: string): Promise<FileRecordRow> {
  const query = getElectronDbQuery();
  if (!query) {
    throw new Error('Chunking host database bridge is not available.');
  }

  const result = await query(
    `SELECT name, path, content
       FROM file_records
      WHERE id = $1
      LIMIT 1`,
    [fileRecordId]
  );
  if (!Array.isArray(result.rows) || result.rows.length === 0) {
    throw new Error(`Chunking host could not find file record ${fileRecordId}.`);
  }
  const row = result.rows[0] as Record<string, unknown> | undefined;
  if (!row) {
    throw new Error(`Chunking host could not find file record ${fileRecordId}.`);
  }
  if (typeof row['name'] !== 'string' || row['name'].trim().length === 0) {
    throw new Error(`Chunking host file record ${fileRecordId} is missing name metadata.`);
  }
  if (typeof row['path'] !== 'string' || row['path'].trim().length === 0) {
    throw new Error(`Chunking host file record ${fileRecordId} is missing path metadata.`);
  }
  if (typeof row['content'] !== 'string') {
    throw new Error(`Chunking host file record ${fileRecordId} is missing content.`);
  }
  return {
    content: row['content'],
    name: row['name'],
    path: row['path'],
  };
}

function toWorkerRequestOptions(
  filePath: string,
  options: ChunkingHostRequestOptions
): ChunkingRequestOptions {
  const autoStrategy = getChunkingStrategy(filePath);
  const requestedStrategy = options.requestedStrategy;
  const hasExplicitRequestedStrategy =
    requestedStrategy !== undefined && requestedStrategy !== 'auto';
  const resolvedStrategy = hasExplicitRequestedStrategy ? requestedStrategy : autoStrategy;
  const forceStrategy =
    options.forceStrategy === true ||
    (hasExplicitRequestedStrategy && requestedStrategy !== autoStrategy);

  return {
    strategy: resolvedStrategy,
    ...(forceStrategy ? { forceStrategy: true } : {}),
    ...(options.allowLargeFiles === undefined ? {} : { allowLargeFiles: options.allowLargeFiles }),
    ...(options.ignoreFileTypeRecommendations === undefined
      ? {}
      : { ignoreFileTypeRecommendations: options.ignoreFileTypeRecommendations }),
    ...(options.maxTokens === undefined ? {} : { maxTokens: options.maxTokens }),
    ...(options.maxTokensCap === undefined ? {} : { maxTokensCap: options.maxTokensCap }),
    ...(options.overlap === undefined ? {} : { overlap: options.overlap }),
    ...(options.separators === undefined ? {} : { separators: [...options.separators] }),
    ...(options.tokenTrueSizing === undefined ? {} : { tokenTrueSizing: options.tokenTrueSizing }),
  };
}

async function chunkFileById(
  request: ChunkingHostChunkFileByIdRequest,
  chunkFile: (
    fileRecordId: string,
    content: string,
    fileName: string,
    filePath: string,
    options: ChunkingRequestOptions
  ) => Promise<ChunkResult>
): Promise<ChunkResult> {
  const fileRecord = await loadFileRecordById(request.fileRecordId);
  return await chunkFile(
    request.fileRecordId,
    fileRecord.content,
    fileRecord.name,
    fileRecord.path,
    toWorkerRequestOptions(fileRecord.path, request.options)
  );
}

async function executeChunkRequest(
  request: ChunkingHostRequest,
  chunkFile: (
    fileRecordId: string,
    content: string,
    fileName: string,
    filePath: string,
    options: ChunkingRequestOptions
  ) => Promise<ChunkResult>
): Promise<ChunkResult | ChunkResult[]> {
  const payload = request.payload;
  if (payload.kind === 'chunk-file') {
    return await chunkFile(
      payload.fileRecordId,
      payload.content,
      payload.fileName,
      payload.filePath,
      toWorkerRequestOptions(payload.filePath, payload.options)
    );
  }
  if (payload.kind === 'chunk-file-by-id') {
    return await chunkFileById(payload, chunkFile);
  }

  const results: ChunkResult[] = [];
  // The hidden host keeps batch file chunking serial on purpose so import bursts do not
  // rematerialize multiple large file contents in parallel and destabilize the visible renderer.
  for (const file of payload.files) {
    const result = await chunkFile(
      file.fileRecordId,
      file.content,
      file.fileName,
      file.filePath,
      toWorkerRequestOptions(file.filePath, payload.options)
    );
    results.push(result);
  }
  return results;
}

function reportChunkRequestSuccess(
  request: ChunkingHostRequest,
  result: ChunkResult | ChunkResult[],
  runtimeId: string
): void {
  if (Array.isArray(result)) {
    const batchRequest = request.payload;
    if (batchRequest.kind !== 'chunk-batch') {
      throw new Error('Chunk batch success reporting requires a chunk-batch request.');
    }
    for (const [index, batchResult] of result.entries()) {
      const file = batchRequest.files[index];
      if (!file) {
        throw new Error(`Chunk batch response index ${index} has no matching request file.`);
      }
      reportResponse({
        channel: 'chunk',
        payload: {
          chunksCreated: batchResult.chunks.length,
          currentIndex: index + 1,
          fileRecordId: file.fileRecordId,
          totalFiles: batchRequest.files.length,
        },
        requestId: request.requestId,
        runtimeId,
        type: 'progress',
      });
      reportResponse({
        channel: 'chunk-file-complete',
        payload: {
          fileRecordId: file.fileRecordId,
          result: batchResult,
        },
        requestId: request.requestId,
        runtimeId,
        type: 'progress',
      });
    }
    reportResponse({
      channel: 'chunk-batch-complete',
      payload: {
        results: result,
      },
      requestId: request.requestId,
      runtimeId,
      type: 'result',
    });
    return;
  }

  reportResponse({
    channel: 'chunk-result',
    payload: {
      result,
    },
    requestId: request.requestId,
    runtimeId,
    type: 'result',
  });
}

function getRequestErrorPayload(request: ChunkingHostRequest, message: string) {
  const maybeFileRecordId =
    request.payload.kind === 'chunk-file' || request.payload.kind === 'chunk-file-by-id'
      ? { fileRecordId: request.payload.fileRecordId }
      : {};
  return {
    ...serializeRuntimeError(message),
    ...maybeFileRecordId,
    errorMessage: message,
  };
}

function getChunkingRequestLogBindings(request: ChunkingHostRequest): {
  readonly kind?: string;
  readonly requestId?: string;
} {
  const bindings: {
    kind?: string;
    requestId?: string;
  } = {};
  const payload = request.payload as unknown;
  if (payload && typeof payload === 'object') {
    const payloadWithKind = payload as {
      readonly kind?: unknown;
    };
    if (typeof payloadWithKind.kind === 'string') {
      bindings.kind = payloadWithKind.kind;
    }
  }
  if (typeof request.requestId === 'string' && request.requestId.trim().length > 0) {
    bindings.requestId = request.requestId;
  }
  return bindings;
}

export function ChunkingHostRuntime(): null {
  const { ensureStarted, error } = useChunkingWorkerContext();
  const activeRequestCountRef = useRef(0);
  const fatalErrorRef = useRef<string | null>(null);
  const runtimeIdRef = useRef<string>(resolveChunkingHostRuntimeId());

  useEffect(() => {
    let disposed = false;

    const syncActiveStatus = (): void => {
      if (fatalErrorRef.current) {
        reportStatus({
          active: false,
          lastError: fatalErrorRef.current,
          runtimeId: runtimeIdRef.current,
          runtimeKind: 'chunking-host',
          state: 'error',
        });
        return;
      }
      reportStatus({
        active: activeRequestCountRef.current > 0,
        lastError: null,
        runtimeId: runtimeIdRef.current,
        runtimeKind: 'chunking-host',
        state: 'running',
      });
    };

    const startHost = async (): Promise<void> => {
      fatalErrorRef.current = null;
      reportStatus({
        active: false,
        lastError: null,
        runtimeId: runtimeIdRef.current,
        runtimeKind: 'chunking-host',
        state: 'starting',
      });
      try {
        await ensureStarted();
        if (disposed) {
          return;
        }
        syncActiveStatus();
      } catch (startError) {
        const message = startError instanceof Error ? startError.message : String(startError);
        fatalErrorRef.current = message;
        logger.error('Failed to start chunking host worker', {
          error: message,
          runtimeId: runtimeIdRef.current,
        });
        reportStatus({
          active: false,
          lastError: message,
          runtimeId: runtimeIdRef.current,
          runtimeKind: 'chunking-host',
          state: 'error',
        });
      }
    };

    const onRequest = async (request: ChunkingHostRequest): Promise<void> => {
      let heartbeatId: number | null = null;
      try {
        const port = await ensureStarted();
        if (disposed) {
          return;
        }

        activeRequestCountRef.current += 1;
        syncActiveStatus();

        heartbeatId = window.setInterval(() => {
          reportRequestHeartbeat(request, runtimeIdRef.current);
        }, CHUNKING_HOST_REQUEST_HEARTBEAT_MS);
        const result = await executeChunkRequest(request, port.chunkFile);
        reportChunkRequestSuccess(request, result, runtimeIdRef.current);
      } catch (requestError) {
        const message = requestError instanceof Error ? requestError.message : String(requestError);
        const requestBindings = getChunkingRequestLogBindings(request);
        logger.error('Chunking host request failed', {
          ...requestBindings,
          error: message,
          runtimeId: runtimeIdRef.current,
        });
        reportResponse({
          channel: 'chunk-error',
          payload: getRequestErrorPayload(request, message),
          requestId: request.requestId,
          runtimeId: runtimeIdRef.current,
          type: 'error',
        });
      } finally {
        if (heartbeatId !== null) {
          window.clearInterval(heartbeatId);
        }
        if (activeRequestCountRef.current > 0) {
          activeRequestCountRef.current -= 1;
        } else {
          logger.warn('Chunking host active request count underflow detected', {
            requestId: request.requestId,
            runtimeId: runtimeIdRef.current,
          });
        }
        if (!disposed) {
          syncActiveStatus();
        }
      }
    };

    const unsubscribeRequest = getChunkingHostBridge()?.onRequest?.((request) => {
      onRequest(request).catch((requestError: unknown) => {
        logger.error('Uncaught error in chunking request handler', {
          error: requestError instanceof Error ? requestError.message : String(requestError),
          requestId: request.requestId,
          runtimeId: runtimeIdRef.current,
        });
      });
    });

    startHost().catch((startError: unknown) => {
      logger.error('Chunking host startup failed', {
        error: startError instanceof Error ? startError.message : String(startError),
        runtimeId: runtimeIdRef.current,
      });
    });

    return () => {
      disposed = true;
      unsubscribeRequest?.();
      activeRequestCountRef.current = 0;
      reportStatus({
        active: false,
        lastError: null,
        runtimeId: runtimeIdRef.current,
        runtimeKind: 'chunking-host',
        state: 'stopped',
      });
    };
  }, [ensureStarted]);

  useEffect(() => {
    if (!error) {
      return;
    }
    fatalErrorRef.current = error.message;
    reportStatus({
      active: false,
      lastError: error.message,
      runtimeId: runtimeIdRef.current,
      runtimeKind: 'chunking-host',
      state: 'error',
    });
  }, [error]);
  return null;
}
