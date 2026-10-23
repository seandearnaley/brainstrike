import { type BoundaryLog, toBoundaryFailure } from '@brainstrike/agent-host/boundary-wire';
import {
  type BoundaryFailure,
  BoundaryFailureError,
  fault,
  isBoundaryRefusal,
  refusal,
} from '@brainstrike/assistant-contract/boundary-failure';
import {
  NATIVE_INDEX_OFF_MESSAGE,
  type NativeIndexRefusalCause,
  NativeIndexRefusalError,
} from '@brainstrike/indexing-contract/indexer-client';
import { createLogger } from '@brainstrike/logging';

import { getFactoryResetUnavailableReason } from './factory-reset-availability';
import { HOSTED_EMBEDDING_REFUSALS, hostedEmbeddingFailure } from './hosted-embedding-error';
import { IndexConfigApplyFailed, IndexConfigRefused, IndexConfigStoreFailed } from './index-config';

const logger = createLogger('NativeIndexBoundary');

/** Only Factory Reset clears a saved config that no longer decodes, where the app offers it. */
const STORE_FAILED_REMEDY =
  getFactoryResetUnavailableReason(process.platform) === undefined
    ? 'If this keeps happening, the saved settings may be damaged. Factory Reset in Settings clears them, along with your other local app data.'
    : undefined;

/** What a search index config failure wraps, so quit's retirement underneath stays recognisable. */
export function indexConfigCause(error: unknown): unknown {
  return error instanceof IndexConfigStoreFailed || error instanceof IndexConfigApplyFailed
    ? error.cause
    : error;
}

/** The config owner's sentence reaches Settings; a typed refusal underneath keeps its own outcome. */
function indexConfigFailure(error: unknown, log: BoundaryLog): BoundaryFailure | undefined {
  if (error instanceof IndexConfigRefused) {
    return refusal({ category: 'input', code: 'index-config.refused', message: error.message });
  }
  if (!(error instanceof IndexConfigStoreFailed || error instanceof IndexConfigApplyFailed)) {
    return undefined;
  }
  if (isBoundaryRefusal(error.cause) || error.cause instanceof NativeIndexRefusalError) {
    return nativeIndexBoundaryFailure(error.cause, log);
  }
  const stored = error instanceof IndexConfigStoreFailed;
  const code = stored ? 'index-config.store-failed' : 'index-config.apply-failed';
  const correlationId = crypto.randomUUID();
  log('Search index settings failure retained its cause', {
    cause: error.cause,
    code,
    correlationId,
  });
  return fault({
    category: 'internal',
    code,
    correlationId,
    message: error.message,
    ...(stored && STORE_FAILED_REMEDY !== undefined ? { remedy: STORE_FAILED_REMEDY } : {}),
  });
}

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
  off: { category: 'configuration', message: NATIVE_INDEX_OFF_MESSAGE },
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
  const configFailure = indexConfigFailure(error, log);
  if (configFailure) {
    return configFailure;
  }
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
  const retained = { cause: error.cause, code: error.code, correlationId };
  // ADR-0026: quit's one terminal reason. The refusal keeps its kind across the boundary and
  // its cause stays correlated here, at debug: an expected retirement is not an error record.
  if (isQuitTerminalRefusal(error)) {
    logger.debug('Native index refusal retained its original cause', retained);
  } else {
    log('Native index refusal retained its original cause', retained);
  }
  return { ...failure, correlationId };
}

/**
 * Quit's one terminal reason (ADR-0026): the typed refusal of a native index closed for
 * shutdown. Classified by its kind and reason, never by message text.
 */
export function isQuitTerminalRefusal(error: unknown): error is NativeIndexRefusalError {
  return (
    error instanceof NativeIndexRefusalError &&
    error.refusal.kind === 'closed' &&
    error.refusal.reason === 'shutdown'
  );
}
