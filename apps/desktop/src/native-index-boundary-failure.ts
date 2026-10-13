import type { BoundaryLog } from '@brainstrike/agent-host/boundary-wire';
import { type BoundaryFailure, refusal } from '@brainstrike/assistant-contract/boundary-failure';
import type {
  NativeIndexRefusalCause,
  NativeIndexRefusalError,
} from '@brainstrike/indexing-contract/indexer-client';

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

/** Preserve the lifecycle discriminator; source error text stays in Main. */
export function nativeIndexBoundaryFailure(
  error: NativeIndexRefusalError,
  log: BoundaryLog
): BoundaryFailure {
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
