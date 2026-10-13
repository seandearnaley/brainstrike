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

import { HOSTED_EMBEDDING_MISSING_KEY, hostedEmbeddingFailure } from './hosted-embedding-error';

const descriptions: Readonly<
  Record<NativeIndexRefusalCause['kind'], Pick<BoundaryFailure, 'category' | 'message' | 'remedy'>>
> = {
  closed: {
    category: 'availability',
    message: 'The search index is closed.',
    remedy: 'Reopen the workspace to search again.',
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
 * BST-2008: generate and physical join report the same configuration refusal as
 * distinct transported errors. Every joined failure must prove that exact kind;
 * an independent cleanup fault is never hidden behind a recoverable refusal.
 */
function isMissingKey(error: unknown): boolean {
  if (error instanceof AggregateError) {
    return (
      error.errors.length > 0 &&
      error.errors.every(isMissingKey) &&
      (error.cause === undefined || isMissingKey(error.cause))
    );
  }
  if (error instanceof NativeIndexRefusalError) {
    return error.refusal.kind === 'source-failure' && isMissingKey(error.cause);
  }
  if (error instanceof BoundaryFailureError) {
    return (
      error.failure.kind === 'refusal' &&
      error.failure.category === 'configuration' &&
      error.failure.code === HOSTED_EMBEDDING_MISSING_KEY.code
    );
  }
  return hostedEmbeddingFailure(error) !== undefined;
}

/** Preserve proven native outcomes; source and cleanup diagnostics stay in Main. */
export function nativeIndexBoundaryFailure(error: unknown, log: BoundaryLog): BoundaryFailure {
  if (isMissingKey(error)) {
    const correlationId = crypto.randomUUID();
    log('Native configuration refusal retained its original causes', {
      cause: error,
      code: HOSTED_EMBEDDING_MISSING_KEY.code,
      correlationId,
    });
    return { ...HOSTED_EMBEDDING_MISSING_KEY, correlationId };
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
