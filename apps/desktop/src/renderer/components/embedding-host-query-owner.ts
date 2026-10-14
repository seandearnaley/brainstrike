import type { ModelCatalogCapability } from '@brainstrike/assistant-contract';
import type { EmbeddingDeviceType } from '@brainstrike/embeddings';
import type { SimpleEmbeddingService } from '@brainstrike/embeddings/service';
import { createLogger } from '@brainstrike/logging';
import type { MutableRefObject } from 'react';

const logger = createLogger('EmbeddingHostRuntime');

export interface QueryEmbeddingServiceState {
  readonly identity: string;
  readonly modelKey: string;
  readonly selectedDevicePreference: EmbeddingDeviceType;
  readonly service: SimpleEmbeddingService;
}

interface QueryEmbeddingStateRefs {
  readonly activeCountRef: MutableRefObject<number>;
  readonly serviceStateRef: MutableRefObject<QueryEmbeddingServiceState | null>;
}

export interface QueryEmbeddingRuntimeOwner extends QueryEmbeddingStateRefs {
  readonly catalog: Pick<ModelCatalogCapability, 'read'> | undefined;
  closed: boolean;
  readonly closeRef: MutableRefObject<Promise<void> | null>;
  readonly disposalRef: MutableRefObject<Promise<void> | null>;
  readonly executionTailRef: MutableRefObject<Promise<void>>;
  readonly inferenceController: AbortController;
  readonly inferenceRef: MutableRefObject<Promise<unknown> | null>;
  readonly physicalRetirementRef: MutableRefObject<Promise<void> | null>;
  readonly requests: Map<string, AbortController>;
}

export function createQueryEmbeddingRuntimeOwner(
  catalog: QueryEmbeddingRuntimeOwner['catalog'],
  activeCountRef: MutableRefObject<number> = { current: 0 }
): QueryEmbeddingRuntimeOwner {
  return {
    activeCountRef,
    catalog,
    closed: false,
    closeRef: { current: null },
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
