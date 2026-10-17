import { BoundaryFailureError, refusal } from '@brainstrike/assistant-contract/boundary-failure';
import type { EmbeddingRequestProgress } from '@brainstrike/embeddings';

/**
 * A document batch whose liveness window expired: the embedding host stopped reporting. Recovery
 * needs a person (BST-2104 owner decision): as a refusal it is never re-opened automatically, and
 * its remedy is the explicit Retry indexing action, which restarts the host.
 */
export const EMBEDDING_HOST_UNRESPONSIVE_CODE = 'embedding-host.unresponsive';

/** What the batch last reported before it went silent; the log carries the request identity. */
export type EmbeddingHostUnresponsiveStage = 'no-report' | 'model-setup' | 'inference';

export function embeddingHostUnresponsiveStage(
  progress: EmbeddingRequestProgress | undefined
): EmbeddingHostUnresponsiveStage {
  if (progress === undefined) {
    return 'no-report';
  }
  return progress.stage === 'setup' ? 'model-setup' : 'inference';
}

function duration(ms: number): string {
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) {
    return `${seconds} s`;
  }
  const rest = seconds % 60;
  return `${Math.floor(seconds / 60)} min${rest === 0 ? '' : ` ${rest} s`}`;
}

function describeStage(progress: EmbeddingRequestProgress | undefined, texts: number): string {
  if (progress === undefined) {
    return 'before it started on a batch';
  }
  if (progress.stage === 'setup') {
    return 'while it was loading';
  }
  return `after ${progress.completed} of ${texts} chunks in a batch`;
}

/** Plain words for the person who has to act; no request or runtime identity. */
export function embeddingHostUnresponsiveError(details: {
  readonly elapsedMs: number;
  readonly lastProgress: EmbeddingRequestProgress | undefined;
  readonly texts: number;
  readonly windowMs: number;
}): BoundaryFailureError {
  return new BoundaryFailureError(
    refusal({
      category: 'availability',
      code: EMBEDDING_HOST_UNRESPONSIVE_CODE,
      message:
        `The embedding model stopped responding ${describeStage(details.lastProgress, details.texts)}. ` +
        `It sent no progress for ${duration(details.windowMs)} ` +
        `(${duration(details.elapsedMs)} after the batch started).`,
      remedy: 'Retry indexing restarts the embedding model and resumes indexing.',
    })
  );
}

/**
 * The unresponsive-host refusal anywhere in a failure: retirement and ingestion wrap it in
 * AggregateErrors and causes on its way to the lifecycle owner.
 */
export function findEmbeddingHostUnresponsive(
  error: unknown,
  seen: ReadonlySet<unknown> = new Set()
): BoundaryFailureError | undefined {
  if (seen.has(error)) {
    return;
  }
  if (error instanceof BoundaryFailureError && error.code === EMBEDDING_HOST_UNRESPONSIVE_CODE) {
    return error;
  }
  if (!(error instanceof Error)) {
    return;
  }
  const visited = new Set([...seen, error]);
  for (const nested of error instanceof AggregateError ? error.errors : []) {
    const found = findEmbeddingHostUnresponsive(nested, visited);
    if (found) {
      return found;
    }
  }
  return findEmbeddingHostUnresponsive(error.cause, visited);
}
