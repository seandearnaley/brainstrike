import type { usePGliteDatabase } from '@brainstrike/db/react';
import { getEmbeddingTelemetrySnapshot } from '@brainstrike/embedding-worker';
import type { SimpleEmbeddingService } from '@brainstrike/embeddings/service';
import type { EmbeddingWorkerController } from '@brainstrike/embeddings/worker';
import { createLogger } from '@brainstrike/logging';
import type { MutableRefObject } from 'react';
import type { EmbeddingHostRuntimeMetadata } from '../../embedding-host-shared';
import { reportEmbeddingHostRuntimeStatus } from './embedding-host-bridge';

const logger = createLogger('EmbeddingHostRuntime');

export interface QueryEmbeddingServiceState {
  readonly identity: string;
  readonly modelKey: string;
  readonly service: SimpleEmbeddingService;
}

interface QueryEmbeddingStateRefs {
  readonly activeCountRef: MutableRefObject<number>;
  readonly serviceStateRef: MutableRefObject<QueryEmbeddingServiceState | null>;
}

export interface QueryEmbeddingRuntimeOwner extends QueryEmbeddingStateRefs {
  closed: boolean;
  readonly closeRef: MutableRefObject<Promise<void> | null>;
  readonly db: NonNullable<ReturnType<typeof usePGliteDatabase>>;
  readonly disposalRef: MutableRefObject<Promise<void> | null>;
  readonly executionTailRef: MutableRefObject<Promise<void>>;
  readonly inferenceController: AbortController;
  readonly inferenceRef: MutableRefObject<Promise<unknown> | null>;
  readonly physicalRetirementRef: MutableRefObject<Promise<void> | null>;
  readonly requests: Map<string, AbortController>;
}

export function createQueryEmbeddingRuntimeOwner(
  db: QueryEmbeddingRuntimeOwner['db'],
  activeCountRef: MutableRefObject<number> = { current: 0 }
): QueryEmbeddingRuntimeOwner {
  return {
    activeCountRef,
    closed: false,
    closeRef: { current: null },
    db,
    disposalRef: { current: null },
    executionTailRef: { current: Promise.resolve() },
    inferenceController: new AbortController(),
    inferenceRef: { current: null },
    physicalRetirementRef: { current: null },
    requests: new Map(),
    serviceStateRef: { current: null },
  };
}

/** FIFO includes service selection and initialization, not just queue submission. */
export function enqueueQueryEmbeddingOperation(
  owner: QueryEmbeddingRuntimeOwner,
  operation: () => Promise<void>
): Promise<void> {
  const execution = owner.executionTailRef.current.then(operation);
  owner.executionTailRef.current = execution.then(
    () => undefined,
    () => undefined
  );
  return execution;
}

/** Every terminal request path joins the same physical owner without joining itself. */
export async function joinQueryEmbeddingFailure(
  owner: QueryEmbeddingRuntimeOwner,
  error: unknown
): Promise<unknown> {
  try {
    await owner.physicalRetirementRef.current;
  } catch (retirementError) {
    if (
      error !== retirementError &&
      !(error instanceof AggregateError && error.errors.includes(retirementError))
    ) {
      return new AggregateError(
        [error, retirementError],
        'Embedding request and physical retirement failed'
      );
    }
  }
  return error;
}

/** The public queue signal requests cancellation; ownership lasts until actual settlement. */
export async function runOwnedQueryEmbeddingInference<Result>(
  owner: QueryEmbeddingRuntimeOwner,
  generate: (signal: AbortSignal) => Promise<Result>,
  requestSignal?: AbortSignal
): Promise<Result> {
  if (owner.closed) {
    throw new Error('Embedding host query runtime is no longer available.');
  }
  const signal = requestSignal
    ? AbortSignal.any([owner.inferenceController.signal, requestSignal])
    : owner.inferenceController.signal;
  signal.throwIfAborted();
  const inference = (async () => {
    const [execution] = await Promise.allSettled([generate(signal)]);
    try {
      // Pool termination can reject execution before its workers physically retire.
      // Join only the pool here: full owner close itself waits for this inference.
      await owner.physicalRetirementRef.current;
    } catch (retirementError) {
      if (execution.status === 'rejected') {
        throw new AggregateError(
          [execution.reason, retirementError],
          'Embedding inference and physical retirement failed'
        );
      }
      throw retirementError;
    }
    if (execution.status === 'rejected') {
      throw execution.reason;
    }
    return execution.value;
  })();
  owner.inferenceRef.current = inference;
  try {
    return await inference;
  } finally {
    if (owner.inferenceRef.current === inference) {
      owner.inferenceRef.current = null;
    }
  }
}

/** Fence preparation immediately; retain physical retirement separately from owner close. */
export function closeQueryEmbeddingRuntimeOwner(
  owner: QueryEmbeddingRuntimeOwner,
  retireQueue: () => Promise<void>,
  runtimeIdRef: MutableRefObject<string>
): Promise<void> {
  if (owner.closeRef.current) {
    return owner.closeRef.current;
  }
  owner.closed = true;
  const physical = Promise.resolve().then(retireQueue);
  owner.physicalRetirementRef.current = physical;
  owner.inferenceController.abort();
  for (const controller of owner.requests.values()) {
    controller.abort();
  }
  owner.requests.clear();
  const inference = owner.inferenceRef.current;
  owner.closeRef.current = (async () => {
    const results = await Promise.allSettled([
      physical,
      // Its public caller retains an independent inference failure.
      inference?.then(
        () => undefined,
        () => undefined
      ),
      owner.disposalRef.current,
    ]);
    const serviceDisposal = await Promise.allSettled([
      disposeQueryEmbeddingService(runtimeIdRef, owner),
    ]);
    const failures = [
      ...new Set(
        [...results, ...serviceDisposal].flatMap((result) =>
          result.status === 'rejected' ? [result.reason] : []
        )
      ),
    ];
    if (failures.length === 1) {
      throw failures[0];
    }
    if (failures.length > 1) {
      throw new AggregateError(failures, 'Embedding owner retirement failed');
    }
  })();
  return owner.closeRef.current;
}

/** Keep the cached service reachable until disposal settles; never retry a failed disposal. */
export async function disposeQueryEmbeddingService(
  runtimeIdRef: MutableRefObject<string>,
  owner: QueryEmbeddingRuntimeOwner
): Promise<void> {
  if (owner.disposalRef.current) {
    await owner.disposalRef.current;
    return;
  }
  const serviceStateRef = owner.serviceStateRef;
  const state = serviceStateRef.current;
  if (!state) {
    return;
  }
  const disposal = (async () => {
    try {
      await state.service.dispose();
    } catch (error) {
      logger.warn('Failed to dispose local query embedding service', {
        error: error instanceof Error ? error.message : String(error),
        modelKey: state.modelKey,
        runtimeId: runtimeIdRef.current,
      });
      throw error;
    }
    if (serviceStateRef.current === state) {
      serviceStateRef.current = null;
    }
  })();
  owner.disposalRef.current = disposal;
  await disposal;
  if (owner.disposalRef.current === disposal) {
    owner.disposalRef.current = null;
  }
}

export async function stopEmbeddingHostAfterRestartLimit(options: {
  readonly queryOwner: QueryEmbeddingRuntimeOwner;
  readonly retireQueue: () => Promise<void>;
  readonly controller: EmbeddingWorkerController | null;
  readonly embeddingRuntimeRef: MutableRefObject<EmbeddingHostRuntimeMetadata | null>;
  readonly isDisposed: () => boolean;
  readonly runtimeIdRef: MutableRefObject<string>;
  readonly terminalError: string;
}): Promise<void> {
  const {
    controller,
    embeddingRuntimeRef,
    isDisposed,
    queryOwner,
    retireQueue,
    runtimeIdRef,
    terminalError,
  } = options;
  const closeQueries = closeQueryEmbeddingRuntimeOwner(queryOwner, retireQueue, runtimeIdRef);
  let lastError = terminalError;
  const [workerStop, queryClose] = await Promise.allSettled([controller?.stop(), closeQueries]);
  if (workerStop.status === 'rejected') {
    const error: unknown = workerStop.reason;
    lastError = `${terminalError}; worker stop failed: ${error instanceof Error ? error.message : String(error)}`;
    logger.error('Embedding host worker stop after restart limit failed', {
      error: error instanceof Error ? error.message : String(error),
      runtimeId: runtimeIdRef.current,
    });
  }
  if (queryClose.status === 'rejected') {
    const error: unknown = queryClose.reason;
    lastError = `${lastError}; query owner retirement failed: ${error instanceof Error ? error.message : String(error)}`;
  }
  const currentMetadata = embeddingRuntimeRef.current;
  if (currentMetadata) {
    embeddingRuntimeRef.current = {
      ...currentMetadata,
      telemetry: getEmbeddingTelemetrySnapshot(),
    };
  }
  if (isDisposed()) {
    return;
  }
  reportEmbeddingHostRuntimeStatus(runtimeIdRef, 'error', {
    embeddingRuntime: embeddingRuntimeRef.current,
    lastError,
  });
}
