import {
  buildInaccessibleContent,
  INACCESSIBLE_CONTENT_PREFIX,
} from '@brainstrike/file-explorer-hooks';
import { createLogger } from '@brainstrike/logging';
import { BINARY_CONTENT_MESSAGE } from '@brainstrike/types';
import type {
  FileContentReadResult,
  FileContentWorker,
  FileReadRequest,
} from '@brainstrike/workers/file-content-worker';
import type { Dispatch, RefObject, SetStateAction } from 'react';

const logger = createLogger('FileContentLoadResults');

export interface FileContentErrorRecord {
  readonly compositeKey: string;
  readonly error: Error;
  readonly expectedGeneration: number;
}

export interface SettledFileReadPreparations {
  readonly failures: readonly {
    readonly compositeKey: string;
    readonly error: unknown;
  }[];
  readonly requests: FileReadRequest[];
}

export type FileContentWorkerBatchResult =
  | { readonly status: 'completed' }
  | { error: unknown; status: 'failed' };

export function createFileContentLoadError(failures: readonly unknown[]): Error {
  const [onlyFailure] = failures;
  if (failures.length === 1 && onlyFailure instanceof Error) {
    return onlyFailure;
  }
  return new AggregateError(failures, 'One or more file-content reads failed.');
}

export function toFileContentError(error: unknown): Error {
  if (error instanceof Error) {
    return error;
  }
  return new Error('File content read failed.', { cause: error });
}

export function collectFileContentFailures({
  expectedGenerations,
  preparationFailures,
  requests,
  workerResult,
}: {
  readonly expectedGenerations: ReadonlyMap<string, number>;
  readonly preparationFailures: SettledFileReadPreparations['failures'];
  readonly requests: readonly FileReadRequest[];
  readonly workerResult: FileContentWorkerBatchResult;
}): { readonly errorRecords: FileContentErrorRecord[]; readonly failures: unknown[] } {
  const failures: unknown[] = preparationFailures.map((failure) => failure.error);
  const errorRecords = preparationFailures.map((failure) => ({
    compositeKey: failure.compositeKey,
    error: toFileContentError(failure.error),
    expectedGeneration: expectedGenerations.get(failure.compositeKey) ?? 0,
  }));
  if (workerResult.status === 'failed') {
    failures.push(workerResult.error);
    const workerError = toFileContentError(workerResult.error);
    for (const request of requests) {
      errorRecords.push({
        compositeKey: request.compositeKey,
        error: workerError,
        expectedGeneration: expectedGenerations.get(request.compositeKey) ?? 0,
      });
    }
  }
  return { errorRecords, failures };
}

export async function settleFileContentPromises(promises: Iterable<Promise<void>>): Promise<void> {
  const settled = await Promise.allSettled(promises);
  const failures = settled.flatMap((result) =>
    result.status === 'rejected' ? [result.reason] : []
  );
  if (failures.length > 0) {
    throw createFileContentLoadError(failures);
  }
}

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
    if (result.status === 'accessible') {
      setFileContent(key, result.content);
      continue;
    }
    const content =
      result.message === BINARY_CONTENT_MESSAGE ||
      result.message.startsWith(INACCESSIBLE_CONTENT_PREFIX)
        ? result.message
        : buildInaccessibleContent(result.message);
    setFileContent(key, content);
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
  const failures: Array<{ readonly compositeKey: string; readonly error: unknown }> = [];
  const requests: FileReadRequest[] = [];
  for (const [index, result] of results.entries()) {
    if (result.status === 'rejected') {
      const compositeKey = compositeKeys[index];
      if (compositeKey !== undefined) {
        failures.push({ compositeKey, error: result.reason });
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
}): Promise<FileContentWorkerBatchResult> {
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
