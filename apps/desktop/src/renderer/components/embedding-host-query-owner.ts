import type { usePGliteDatabase } from '@brainstrike/db/react';
import type { SimpleEmbeddingService } from '@brainstrike/embeddings/service';
import { createLogger } from '@brainstrike/logging';
import type { MutableRefObject } from 'react';

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
  readonly db: NonNullable<ReturnType<typeof usePGliteDatabase>>;
  readonly disposalRef: MutableRefObject<Promise<void> | null>;
  readonly executionTailRef: MutableRefObject<Promise<void>>;
  readonly inferenceController: AbortController;
  readonly inferenceRef: MutableRefObject<Promise<unknown> | null>;
  readonly requests: Map<string, AbortController>;
}

export function createQueryEmbeddingRuntimeOwner(
  db: QueryEmbeddingRuntimeOwner['db'],
  activeCountRef: MutableRefObject<number> = { current: 0 }
): QueryEmbeddingRuntimeOwner {
  return {
    activeCountRef,
    closed: false,
    db,
    disposalRef: { current: null },
    executionTailRef: { current: Promise.resolve() },
    inferenceController: new AbortController(),
    inferenceRef: { current: null },
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
  const inference = generate(signal);
  owner.inferenceRef.current = inference;
  try {
    return await inference;
  } finally {
    if (owner.inferenceRef.current === inference) {
      owner.inferenceRef.current = null;
    }
  }
}

/** Fence preparation immediately, joining only owned inference and cached-service disposal. */
export async function closeQueryEmbeddingRuntimeOwner(
  owner: QueryEmbeddingRuntimeOwner
): Promise<void> {
  owner.closed = true;
  owner.inferenceController.abort();
  for (const controller of owner.requests.values()) {
    controller.abort();
  }
  owner.requests.clear();
  const inference = owner.inferenceRef.current;
  if (inference) {
    await inference.then(
      () => undefined,
      () => undefined
    );
  }
  await owner.disposalRef.current;
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
