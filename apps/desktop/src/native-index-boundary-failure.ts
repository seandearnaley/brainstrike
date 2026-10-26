import { type BoundaryLog, toBoundaryFailure } from '@brainstrike/agent-host/boundary-wire';
import {
  type BoundaryFailure,
  BoundaryFailureError,
  fault,
  isBoundaryRefusal,
  processLost,
  refusal,
} from '@brainstrike/assistant-contract/boundary-failure';
import { IndexerError } from '@brainstrike/indexer';
import {
  NATIVE_INDEX_OFF_MESSAGE,
  type NativeIndexRefusalCause,
  NativeIndexRefusalError,
} from '@brainstrike/indexing-contract/indexer-client';
import { createLogger } from '@brainstrike/logging';
import { SqliteQueryProcessExitedError } from '@brainstrike/sqlite-query';
import { RootLockedError } from '@brainstrike/state-store';

import { HOSTED_EMBEDDING_REFUSALS, hostedEmbeddingFailure } from './hosted-embedding-error';
import { IndexConfigApplyFailed, IndexConfigRefused, IndexConfigStoreFailed } from './index-config';
import { NativeIndexEventRefusedError } from './native-index-workflow-errors';

const logger = createLogger('NativeIndexBoundary');

/** Only Factory Reset clears a saved config that no longer decodes. */
const STORE_FAILED_REMEDY =
  'If this keeps happening, the saved settings may be damaged. Factory Reset in Settings clears them, along with your other local app data.';

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
    ...(stored ? { remedy: STORE_FAILED_REMEDY } : {}),
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
    remedy:
      'Rebuild the search index in Settings, Search & Indexing. Chats, folders and settings are kept.',
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

/**
 * An index process that exited under the call without Main asking it to: a crash, or a signal to
 * Main's process group (BST-2192). The supervisor's typed loss crosses; the exit stays its cause.
 */
function lostIndexProcess(error: unknown): BoundaryFailureError | undefined {
  if (error instanceof IndexerError && error.code === 'indexer-exited') {
    return new BoundaryFailureError(processLost({ child: 'index-utility' }), { cause: error });
  }
  if (error instanceof SqliteQueryProcessExitedError) {
    return new BoundaryFailureError(processLost({ child: 'index-query' }), { cause: error });
  }
  return undefined;
}

/** The held Root a failure comes from, through its causes and joined errors. */
export function heldRoot(error: unknown): RootLockedError | undefined {
  if (error instanceof RootLockedError) {
    return error;
  }
  if (!(error instanceof Error)) {
    return undefined;
  }
  const inner: readonly unknown[] =
    error instanceof AggregateError ? [...(error.errors as unknown[]), error.cause] : [error.cause];
  for (const cause of inner) {
    const held = heldRoot(cause);
    if (held) {
      return held;
    }
  }
  return undefined;
}

/** Preserve proven native outcomes; source and cleanup diagnostics stay in Main. */
export function nativeIndexBoundaryFailure(error: unknown, log: BoundaryLog): BoundaryFailure {
  // ADR-0031: another process holds the profile's Root, so its host was refused, whichever
  // operation needed the host. The OS lock names no holder; only a live process holds it.
  if (heldRoot(error)) {
    return refusal({
      category: 'availability',
      code: 'profile.data-in-use',
      message: 'This profile’s data is in use by another Brainstrike process.',
      remedy: 'Close that process, then open BrainStrike again.',
    });
  }
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
  // An event refused because an owner closed or is replacing the index: the refusal a read gets.
  if (
    error instanceof NativeIndexEventRefusedError &&
    (error.cause.kind === 'closed' || error.cause.kind === 'transitioning')
  ) {
    return refusal({ ...descriptions[error.cause.kind], code: `native-index-${error.cause.kind}` });
  }
  if (!(error instanceof NativeIndexRefusalError)) {
    return toBoundaryFailure(lostIndexProcess(error) ?? error, log);
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
