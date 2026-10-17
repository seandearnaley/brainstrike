import { type BoundaryLog, toBoundaryFailure } from '@brainstrike/agent-host/boundary-wire';
import {
  type BoundaryFailure,
  BoundaryFailureError,
  refusal,
} from '@brainstrike/assistant-contract/boundary-failure';
import {
  type NativeIndexRefusalCause,
  NativeIndexRefusalError,
} from '@brainstrike/indexing-contract/indexer-client';

import { HOSTED_EMBEDDING_REFUSALS, hostedEmbeddingFailure } from './hosted-embedding-error';

const descriptions: Readonly<
  Record<NativeIndexRefusalCause['kind'], Pick<BoundaryFailure, 'category' | 'message' | 'remedy'>>
> = {
  closed: {
    category: 'availability',
    message: 'The search index is closed.',
    remedy: 'Reopen the workspace to search again.',
  },
  'embedding-host-unresponsive': {
    category: 'availability',
    message: 'The embedding model stopped responding while indexing.',
    remedy: 'Retry indexing from the Workspace Index status. It restarts the embedding model.',
  },
  'rebuild-required': {
    category: 'availability',
    message: 'The search index needs a rebuild.',
    remedy:
      'Rebuild the search index in Settings, Search & Indexing. Chats, folders and settings are kept.',
  },
  'settings-invalid': {
    category: 'configuration',
    message: 'The search index settings are invalid.',
    remedy: 'Review Search and indexing in Settings.',
  },
  'setup-required': {
    category: 'configuration',
    message: 'The search index needs configuration.',
    remedy: 'Configure Search and indexing in Settings.',
  },
  'source-failure': {
    category: 'availability',
    message: 'The search index could not prepare its sources.',
    remedy: 'Review Search and indexing in Settings and retry.',
  },
  transitioning: {
    category: 'availability',
    message: 'The search index is preparing.',
  },
};

/**
 * Generate and physical join report the same hosted refusal as distinct
 * transported errors. Every joined failure must prove the same allowed kind;
 * an independent cleanup fault or different refusal never becomes one outcome.
 */
function uniformHostedRefusal(error: unknown): BoundaryFailure | undefined {
  if (error instanceof AggregateError) {
    if (error.errors.length === 0) {
      return undefined;
    }
    const failures: readonly unknown[] =
      error.cause === undefined ? error.errors : [...error.errors, error.cause];
    const outcomes = failures.map(uniformHostedRefusal);
    const first = outcomes[0];
    if (
      !first ||
      outcomes.some(
        (outcome) => outcome?.code !== first.code || outcome.category !== first.category
      )
    ) {
      return undefined;
    }
    return first;
  }
  if (error instanceof NativeIndexRefusalError) {
    return error.refusal.kind === 'source-failure' ? uniformHostedRefusal(error.cause) : undefined;
  }
  if (error instanceof BoundaryFailureError) {
    if (error.failure.kind !== 'refusal') {
      return undefined;
    }
    return Object.values(HOSTED_EMBEDDING_REFUSALS).find(
      (failure) =>
        failure.code === error.failure.code && failure.category === error.failure.category
    );
  }
  return hostedEmbeddingFailure(error);
}

/** Preserve proven native outcomes; source and cleanup diagnostics stay in Main. */
export function nativeIndexBoundaryFailure(error: unknown, log: BoundaryLog): BoundaryFailure {
  const hostedFailure = uniformHostedRefusal(error);
  if (hostedFailure) {
    const correlationId = crypto.randomUUID();
    log('Native hosted refusal retained its original causes', {
      cause: error,
      code: hostedFailure.code,
      correlationId,
    });
    return { ...hostedFailure, correlationId };
  }
  if (!(error instanceof NativeIndexRefusalError)) {
    return toBoundaryFailure(error, log);
  }
  const failure = refusal({ ...descriptions[error.refusal.kind], code: error.code });
  if (error.cause === undefined) {
    return failure;
  }
  const correlationId = crypto.randomUUID();
  log('Native index refusal retained its original cause', {
    cause: error.cause,
    code: error.code,
    correlationId,
  });
  return { ...failure, correlationId };
}
