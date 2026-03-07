import { useChunkingWorkerContext } from '@brainstrike/file-import/chunking-worker-context';
import { createLogger } from '@brainstrike/utils';
import { useEffect, useRef } from 'react';
import type {
  ChunkingHostRequest,
  ChunkingHostResponseReport,
  ChunkingHostStatus,
} from '../../chunking-host-shared';

const logger = createLogger('ChunkingHostRuntime');

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

export function ChunkingHostRuntime(): null {
  const { ensureStarted, error } = useChunkingWorkerContext();
  const activeRequestCountRef = useRef(0);
  const fatalErrorRef = useRef<string | null>(null);

  useEffect(() => {
    let disposed = false;

    const syncActiveStatus = (): void => {
      if (fatalErrorRef.current) {
        reportStatus({ state: 'error', active: false, lastError: fatalErrorRef.current });
        return;
      }
      reportStatus({
        state: 'running',
        active: activeRequestCountRef.current > 0,
        lastError: null,
      });
    };

    const startHost = async (): Promise<void> => {
      fatalErrorRef.current = null;
      reportStatus({ state: 'starting', active: false, lastError: null });
      try {
        await ensureStarted();
        if (disposed) {
          return;
        }
        syncActiveStatus();
      } catch (startError) {
        const message = startError instanceof Error ? startError.message : String(startError);
        fatalErrorRef.current = message;
        logger.error('Failed to start chunking host worker', { error: message });
        reportStatus({ state: 'error', active: false, lastError: message });
      }
    };

    const onRequest = async (request: ChunkingHostRequest): Promise<void> => {
      try {
        const port = await ensureStarted();
        if (disposed) {
          return;
        }

        activeRequestCountRef.current += 1;
        syncActiveStatus();

        if (request.kind === 'chunk-file') {
          const result = await port.chunkFile(
            request.fileRecordId,
            request.content,
            request.fileName,
            request.filePath,
            request.options
          );
          reportResponse({
            type: 'result',
            requestId: request.requestId,
            result,
          });
        } else {
          const results = await port.chunkBatch([...request.files], request.options, {
            onFileComplete: (fileRecordId, result) => {
              reportResponse({
                type: 'file-complete',
                requestId: request.requestId,
                fileRecordId,
                result,
              });
            },
            onFileError: (fileRecordId, errorMessage) => {
              reportResponse({
                type: 'file-error',
                requestId: request.requestId,
                fileRecordId,
                error: errorMessage,
              });
            },
            onProgress: (fileRecordId, chunksCreated, currentIndex, total) => {
              reportResponse({
                type: 'progress',
                requestId: request.requestId,
                fileRecordId,
                chunksCreated,
                currentIndex,
                totalFiles: total,
              });
            },
          });
          reportResponse({
            type: 'batch-complete',
            requestId: request.requestId,
            results,
          });
        }
      } catch (requestError) {
        const message = requestError instanceof Error ? requestError.message : String(requestError);
        logger.error('Chunking host request failed', {
          kind: request.kind,
          requestId: request.requestId,
          error: message,
        });
        reportResponse({
          type: 'error',
          requestId: request.requestId,
          ...(request.kind === 'chunk-file' ? { fileRecordId: request.fileRecordId } : {}),
          error: message,
        });
      } finally {
        if (activeRequestCountRef.current > 0) {
          activeRequestCountRef.current -= 1;
        }
        if (!disposed) {
          syncActiveStatus();
        }
      }
    };

    const unsubscribeRequest = getChunkingHostBridge()?.onRequest?.((request) => {
      void onRequest(request);
    });

    void startHost();

    return () => {
      disposed = true;
      unsubscribeRequest?.();
      activeRequestCountRef.current = 0;
      reportStatus({ state: 'stopped', active: false, lastError: null });
    };
  }, [ensureStarted]);

  useEffect(() => {
    if (!error) {
      return;
    }
    fatalErrorRef.current = error.message;
    reportStatus({ state: 'error', active: false, lastError: error.message });
  }, [error]);
  return null;
}
