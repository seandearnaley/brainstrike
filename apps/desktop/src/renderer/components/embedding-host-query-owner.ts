import type { usePGliteDatabase } from '@brainstrike/db/react';
import type { EmbeddingResult } from '@brainstrike/embeddings';
import type { SimpleEmbeddingService } from '@brainstrike/embeddings/service';
import type { MutableRefObject } from 'react';

export interface QueryEmbeddingServiceState {
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
  readonly executionTailRef: MutableRefObject<Promise<void>>;
  readonly inferenceController: AbortController;
  readonly inferenceRef: MutableRefObject<Promise<EmbeddingResult> | null>;
}

export function createQueryEmbeddingRuntimeOwner(
  db: QueryEmbeddingRuntimeOwner['db'],
  activeCountRef: MutableRefObject<number> = { current: 0 }
): QueryEmbeddingRuntimeOwner {
  return {
    activeCountRef,
    closed: false,
    db,
    executionTailRef: { current: Promise.resolve() },
    inferenceController: new AbortController(),
    inferenceRef: { current: null },
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
export async function runOwnedQueryEmbeddingInference(
  owner: QueryEmbeddingRuntimeOwner,
  generate: (signal: AbortSignal) => Promise<EmbeddingResult>
): Promise<EmbeddingResult> {
  if (owner.closed) {
    throw new Error('Embedding host query runtime is no longer available.');
  }
  const inference = generate(owner.inferenceController.signal);
  owner.inferenceRef.current = inference;
  try {
    return await inference;
  } finally {
    if (owner.inferenceRef.current === inference) {
      owner.inferenceRef.current = null;
    }
  }
}

/** Fence preparation immediately, but join only inference that already owns execution. */
export async function closeQueryEmbeddingRuntimeOwner(
  owner: QueryEmbeddingRuntimeOwner
): Promise<void> {
  owner.closed = true;
  owner.inferenceController.abort();
  const inference = owner.inferenceRef.current;
  if (inference) {
    await inference.then(
      () => undefined,
      () => undefined
    );
  }
}
