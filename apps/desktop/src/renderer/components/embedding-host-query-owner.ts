import type { ModelCatalogCapability } from '@brainstrike/assistant-contract';
import type { EmbeddingDeviceType } from '@brainstrike/embeddings';
import type { SimpleEmbeddingService } from '@brainstrike/embeddings/service';
import { createLogger } from '@brainstrike/logging';
import type { MutableRefObject } from 'react';
import { createEmbeddingHostRuntimeStoppedError } from '../../embedding-host-shared';

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
  /** Document batches run one at a time, in arrival order; each takes one turn per slice. */
  readonly documentTailRef: MutableRefObject<Promise<void>>;
  readonly inferenceController: AbortController;
  readonly inferenceRef: MutableRefObject<Promise<unknown> | null>;
  readonly physicalRetirementRef: MutableRefObject<Promise<void> | null>;
  readonly requests: Map<string, AbortController>;
  readonly turns: InferenceTurns;
}

/**
 * The host's one inference queue. One turn runs at a time: a whole query, or one slice of a
 * document batch. When a turn ends, the oldest waiting query goes next, so a search waits for
 * at most the slice in flight, never the rest of a batch. FIFO within each kind.
 */
export interface InferenceTurns {
  readonly documents: (() => void)[];
  held: boolean;
  readonly queries: (() => void)[];
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
    documentTailRef: { current: Promise.resolve() },
    inferenceController: new AbortController(),
    inferenceRef: { current: null },
    physicalRetirementRef: { current: null },
    requests: new Map(),
    serviceStateRef: { current: null },
    turns: { documents: [], held: false, queries: [] },
  };
}

function releaseInferenceTurn(turns: InferenceTurns): void {
  const next = turns.queries.shift() ?? turns.documents.shift();
  if (next) {
    next();
  } else {
    turns.held = false;
  }
}

/** Resolves once this caller holds the turn; the returned release passes it on exactly once. */
export function acquireInferenceTurn(
  owner: QueryEmbeddingRuntimeOwner,
  kind: 'document' | 'query'
): Promise<() => void> {
  const { turns } = owner;
  let released = false;
  const release = (): void => {
    if (!released) {
      released = true;
      releaseInferenceTurn(turns);
    }
  };
  if (!turns.held) {
    turns.held = true;
    return Promise.resolve(release);
  }
  return new Promise((resolve) => {
    (kind === 'query' ? turns.queries : turns.documents).push(() => resolve(release));
  });
}

/** Service selection and initialization run inside the turn, not just queue submission. */
export async function runInferenceTurn<Result>(
  owner: QueryEmbeddingRuntimeOwner,
  kind: 'document' | 'query',
  operation: () => Promise<Result>
): Promise<Result> {
  const release = await acquireInferenceTurn(owner, kind);
  try {
    return await operation();
  } finally {
    release();
  }
}

/** Document batches settle in arrival order; their slices interleave only with queries. */
export function enqueueDocumentEmbeddingsOperation(
  owner: QueryEmbeddingRuntimeOwner,
  operation: () => Promise<void>
): Promise<void> {
  const execution = owner.documentTailRef.current.then(operation);
  owner.documentTailRef.current = execution.then(
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
  // Coded, so Main can tell a request this Stop ended from an independent abort.
  const stopped = createEmbeddingHostRuntimeStoppedError();
  owner.inferenceController.abort(stopped);
  for (const controller of owner.requests.values()) {
    controller.abort(stopped);
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
