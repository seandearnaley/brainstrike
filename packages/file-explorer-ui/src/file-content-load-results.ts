import { createLogger } from '@brainstrike/logging';
import type {
  FileContentReadResult,
  FileContentWorker,
  FileReadRequest,
} from '@brainstrike/workers/file-content-worker';
import type { Dispatch, RefObject, SetStateAction } from 'react';

const logger = createLogger('FileContentLoadResults');

interface SettledFileReadPreparations {
  readonly failures: unknown[];
  readonly requests: FileReadRequest[];
}

type WorkerBatchResult = { readonly status: 'completed' } | { error: unknown; status: 'failed' };

export function clearFileLoadingState(
  compositeKey: string,
  loadingPathsRef: RefObject<Set<string>>,
  setLoadingFiles: Dispatch<SetStateAction<Set<string>>>
): void {
  loadingPathsRef.current.delete(compositeKey);
  setLoadingFiles((previous) => {
    const next = new Set(previous);
    next.delete(compositeKey);
    return next;
  });
}

export function processFileContentWorkerResults(
  results: Record<string, FileContentReadResult>,
  setFileContent: (key: string, content: string) => void,
  expectedGenerations: ReadonlyMap<string, number>,
  isCurrentGeneration: (compositeKey: string, expectedGeneration: number) => boolean
): void {
  let unexpectedResultCount = 0;
  for (const [key, result] of Object.entries(results)) {
    const expectedGeneration = expectedGenerations.get(key);
    if (expectedGeneration === undefined) {
      unexpectedResultCount += 1;
      continue;
    }
    if (!isCurrentGeneration(key, expectedGeneration)) {
      continue;
    }
    setFileContent(key, result.status === 'accessible' ? result.content : result.message);
  }
  if (unexpectedResultCount > 0) {
    logger.warn('Ignoring file-content results for unrequested keys', {
      count: unexpectedResultCount,
    });
  }
}

export function settleFileReadPreparations(
  results: readonly PromiseSettledResult<FileReadRequest | null>[],
  compositeKeys: readonly string[],
  clearLoading: (compositeKey: string) => void
): SettledFileReadPreparations {
  const failures: unknown[] = [];
  const requests: FileReadRequest[] = [];
  for (const [index, result] of results.entries()) {
    if (result.status === 'rejected') {
      failures.push(result.reason);
      const compositeKey = compositeKeys[index];
      if (compositeKey !== undefined) {
        clearLoading(compositeKey);
      }
      continue;
    }
    if (result.value) {
      requests.push(result.value);
    }
  }
  return { failures, requests };
}

export async function runFileContentWorkerBatch({
  clearLoading,
  processResults,
  requests,
  worker,
}: {
  readonly clearLoading: (compositeKey: string) => void;
  readonly processResults: (results: Record<string, FileContentReadResult>) => void;
  readonly requests: readonly FileReadRequest[];
  readonly worker: FileContentWorker;
}): Promise<WorkerBatchResult> {
  try {
    const results = await worker([...requests], ({ key }) => {
      clearLoading(key);
    });
    processResults(results);
    return { status: 'completed' };
  } catch (error) {
    return { error, status: 'failed' };
  } finally {
    for (const request of requests) {
      clearLoading(request.compositeKey);
    }
  }
}
